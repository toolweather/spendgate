import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";
import { testEnv } from "./env.js";
import { D1UsageStore, MemoryUsageStore } from "./store.js";
import { normalizeEmail, PRO_PRICE_LABEL, submitWaitlist, WAITLIST_IP_DAILY_CAP } from "./waitlist.js";

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0002_waitlist.sql", "utf8"));
  const writes: string[] = [];
  const reads: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: (string | number | null)[] = [];
      const api = {
        bind(...bound: unknown[]) {
          args = bound as (string | number | null)[];
          return api;
        },
        async run() {
          writes.push(sql);
          const result = statement.run(...args);
          return { meta: { changes: Number(result.changes) } };
        },
        async first<T>() {
          reads.push(sql);
          return (statement.get(...args) ?? null) as T | null;
        },
      };
      return api;
    },
  };
  return { store: new D1UsageStore(db as unknown as D1Database), sqlite, writes, reads };
}

describe("waitlist storage", () => {
  it("lowercases and rejects addresses that are not emails", () => {
    expect(normalizeEmail(" Team@Example.com ")).toEqual({ ok: true, email: "team@example.com" });
    expect(normalizeEmail("nope").ok).toBe(false);
    expect(normalizeEmail("a@b").ok).toBe(false);
    expect(normalizeEmail("a@b.c").ok).toBe(false);
  });

  it("writes one row per new email and nothing on a duplicate or a full IP cap", async () => {
    const { store, sqlite, writes, reads } = sqliteD1();
    const base = {
      createdAt: "2026-10-16T00:00:00.000Z",
      source: "pro" as string | null,
      ipHash: "day-hash",
      ipDailyCap: 2,
    };
    expect(await store.joinWaitlist({ ...base, email: "a@example.com" })).toBe("created");
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(0);
    expect(writes[0]).toMatch(/INSERT INTO waitlist/i);
    expect(writes[0]).toMatch(/ON CONFLICT\(email\) DO NOTHING/);
    expect(writes[0]).toMatch(/COUNT\(\*\)/);

    writes.length = 0;
    reads.length = 0;
    expect(await store.joinWaitlist({ ...base, email: "a@example.com", source: "again" })).toBe("duplicate");
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(1);
    expect(sqlite.prepare("SELECT source FROM waitlist WHERE email = ?").get("a@example.com")).toEqual({ source: "pro" });

    expect(await store.joinWaitlist({ ...base, email: "b@example.com" })).toBe("created");
    expect(await store.joinWaitlist({ ...base, email: "c@example.com" })).toBe("rate_limited");
    expect(await store.joinWaitlist({ ...base, email: "c@example.com", ipHash: "other-day" })).toBe("created");
    expect(await store.countWaitlist()).toBe(3);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM waitlist").get()).toEqual({ n: 3 });
  });

  it("resets the IP cap on the next UTC day without a second table", async () => {
    let now = new Date("2026-10-15T23:00:00.000Z");
    const store = new MemoryUsageStore();
    const app = createApp({ store, now: () => now });
    const env = testEnv();
    for (let i = 0; i < WAITLIST_IP_DAILY_CAP; i += 1) {
      const res = await app.request(
        "/v1/waitlist",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
          body: JSON.stringify({ email: `day1-${i}@example.com` }),
        },
        env,
      );
      expect(res.status).toBe(201);
    }
    const blocked = await app.request(
      "/v1/waitlist",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ email: "still-today@example.com" }),
      },
      env,
    );
    expect(blocked.status).toBe(429);
    now = new Date("2026-10-16T00:10:00.000Z");
    const nextDay = await app.request(
      "/v1/waitlist",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ email: "next-day@example.com" }),
      },
      env,
    );
    expect(nextDay.status).toBe(201);
  });

  it("does not call the store when the honeypot is filled", async () => {
    const store = new MemoryUsageStore();
    let joins = 0;
    const original = store.joinWaitlist.bind(store);
    store.joinWaitlist = async (row) => {
      joins += 1;
      return original(row);
    };
    const outcome = await submitWaitlist({
      store,
      now: new Date("2026-10-16T00:00:00.000Z"),
      ip: "203.0.113.10",
      body: { email: "bot@example.com", hp_field: "filled" },
    });
    expect(outcome.status).toBe(200);
    expect(joins).toBe(0);
    expect(await store.countWaitlist()).toBe(0);
  });
});

describe("waitlist page", () => {
  it("shows the proposed price, the form, and a landing-page link", () => {
    const page = readFileSync("public/pro.html", "utf8");
    const landing = readFileSync("public/index.html", "utf8");
    expect(page).toContain(PRO_PRICE_LABEL);
    expect(page).toContain("Join the waitlist");
    expect(page).toContain('name="hp_field"');
    expect(page).toContain('action="/v1/waitlist"');
    expect(page).toContain("higher limits");
    expect(page).toContain("spend policies");
    expect(page).toContain("alerts");
    expect(landing).toContain('href="/pro"');
    expect(landing).toContain(PRO_PRICE_LABEL);
  });
});
