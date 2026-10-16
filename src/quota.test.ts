import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { decodeBase64Json } from "./crypto.js";
import { testEnv, type Env } from "./env.js";
import { createApp, SG_REST } from "./index.js";
import { withSources } from "./sources.js";
import { D1UsageStore, MemoryUsageStore, type UsageSnapshot } from "./store.js";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const PAY_TO = "0x1111111111111111111111111111111111111111";
const IP = "203.0.113.10";

const micro = {
  amount: 0.2,
  category: "status_check",
  merchant: "https://www.cloudflare.com/status",
  agent_id: "agent_demo",
};

interface SqliteDb {
  prepare(sql: string): {
    bind(...bound: unknown[]): unknown;
    run(): Promise<{ meta: { changes: number }; results: unknown[] }>;
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
  };
  withSession(constraint?: string): SqliteDb;
}

function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "migrations/0001_init.sql",
    "migrations/0002_waitlist.sql",
    "migrations/0003_source_daily.sql",
    "migrations/0004_wallet_allowlist.sql",
    "migrations/0005_source_callers.sql",
  ]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  const queries: string[] = [];
  const db: SqliteDb = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql) as unknown as {
        run(...args: never[]): { changes: number | bigint };
        get(...args: never[]): unknown;
        all(...args: never[]): unknown[];
      };
      let args: unknown[] = [];
      const api = {
        bind(...bound: unknown[]) {
          args = bound;
          return api;
        },
        async run() {
          queries.push(sql);
          const result = statement.run(...(args as never[]));
          return { meta: { changes: Number(result.changes ?? 0) }, results: [] as unknown[] };
        },
        async first<T>() {
          queries.push(sql);
          return (statement.get(...(args as never[])) as T | undefined) ?? null;
        },
        async all<T>() {
          queries.push(sql);
          return { results: statement.all(...(args as never[])) as T[] };
        },
      };
      return api;
    },
    withSession() {
      return db;
    },
  };
  return { sqlite, db, queries };
}

function usageWrites(queries: string[]): string[] {
  return queries.filter((sql) => /INSERT\s+INTO\s+usage_daily/i.test(sql));
}

function usageReads(queries: string[]): string[] {
  return queries.filter((sql) => /SELECT\s+score_count/i.test(sql));
}

type QuotaBody = { used_today: number; remaining_today: number; daily_limit: number };

describe("daily quota counter", () => {
  it("increments the same subject in one write and stops at the cap", async () => {
    const { db, queries } = sqliteDb();
    const store = new D1UsageStore(db as unknown as D1Database);
    const day = "2026-10-16";
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = queries.length;
      const row = await store.tryConsumeFree("anon:same", day, 4);
      expect(queries.slice(before)).toHaveLength(1);
      expect(queries[queries.length - 1]).toMatch(/RETURNING score_count/);
      expect(row).not.toBeNull();
      seen.push(row!.scoreCount);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(await store.tryConsumeFree("anon:same", day, 4)).toBeNull();
    expect(await store.getUsage("anon:same", day)).toEqual({ scoreCount: 4, paidCount: 0 });
    expect((await store.tryConsumeFree("anon:other", day, 4))?.scoreCount).toBe(1);
    expect((await store.getUsage("anon:same", day)).scoreCount).toBe(4);
  });

  it("shares the REST and MCP counters and still answers 402 with x402 after the cap", async () => {
    const { sqlite, db, queries } = sqliteDb();
    const store = new D1UsageStore(db as unknown as D1Database);
    const app = createApp({ store, now: () => NOW });
    const env = testEnv({
      DB: db as unknown as Env["DB"],
      ANON_DAILY_LIMIT: "4",
      PAY_TO,
    });
    const fetch = withSources(
      (req: Request, bound: Env, ctx: ExecutionContext) => app.fetch(req, bound, ctx),
      SG_REST,
    );

    async function post(path: string, body: unknown, ip = IP) {
      return fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify(body),
        }),
        env,
        undefined as unknown as ExecutionContext,
      );
    }

    async function scoreRest(ip = IP, body: unknown = micro) {
      const res = await post(`/v1/score?src=x`, body, ip);
      return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
    }

    const rest1 = await scoreRest();
    const mcp1 = await post("/mcp?src=x", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "score_spend", arguments: micro },
    });
    const guarded = await scoreRest(IP, {
      amount: 0.4,
      currency: "USDC",
      category: "crypto_transfer",
      purpose: "deploy on sepolia",
      from_wallet: "0x2222222222222222222222222222222222222222",
      allowed_wallets: ["0x3333333333333333333333333333333333333333"],
    });

    expect(rest1.status).toBe(200);
    expect((rest1.body.quota as QuotaBody).used_today).toBe(1);
    expect((rest1.body.payment_source as { from_wallet: null }).from_wallet).toBeNull();
    const mcpScore = JSON.parse(
      ((await mcp1.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { quota: QuotaBody; payment_source: { from_wallet: null } };
    expect(mcp1.status).toBe(200);
    expect(mcpScore.quota.used_today).toBe(2);
    expect(mcpScore.payment_source.from_wallet).toBeNull();
    expect(guarded.status).toBe(200);
    expect(guarded.body.verdict).toBe("block");
    expect((guarded.body.payment_source as { reason: string }).reason).toBe("unauthorized_wallet");
    expect((guarded.body.quota as QuotaBody).used_today).toBe(3);
    expect(usageWrites(queries)).toHaveLength(3);
    expect(usageReads(queries)).toHaveLength(0);

    const quota = await fetch(
      new Request("http://localhost/v1/quota?src=x", { headers: { "cf-connecting-ip": IP } }),
      env,
      undefined as unknown as ExecutionContext,
    );
    expect(((await quota.json()) as QuotaBody).used_today).toBe(3);

    const quotaRpc = await post("/mcp?src=x", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_quota", arguments: {} },
    });
    const quotaText = JSON.parse(
      ((await quotaRpc.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { used_today: number; subject: string; tier: string };
    expect(quotaText).toMatchObject({ used_today: 3, subject: "anonymous", tier: "anonymous" });

    const other = await scoreRest("198.51.100.20");
    expect((other.body.quota as QuotaBody).used_today).toBe(1);

    const fourth = await scoreRest();
    expect((fourth.body.quota as QuotaBody).used_today).toBe(4);
    expect((fourth.body.quota as QuotaBody).remaining_today).toBe(0);

    const blocked = await scoreRest();
    expect(blocked.status).toBe(402);
    expect((blocked.body.quota as QuotaBody).used_today).toBe(4);
    expect((blocked.body.quota as QuotaBody).remaining_today).toBe(0);
    const header = blocked.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = decodeBase64Json(header!) as { x402Version: number; accepts: Array<{ payTo: string }> };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0]?.payTo).toBe(PAY_TO);
    expect(decoded).not.toHaveProperty("waitlist_url");

    const mcpBlocked = await post("/mcp?src=x", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "score_spend", arguments: micro },
    });
    expect(mcpBlocked.status).toBe(402);
    expect(mcpBlocked.headers.get("payment-required")).toBeTruthy();
    const mcpErr = (await mcpBlocked.json()) as {
      error: { code: number; data: { quota: QuotaBody; x402Version: number } };
    };
    expect(mcpErr.error.code).toBe(-32002);
    expect(mcpErr.error.data.x402Version).toBe(2);
    expect(mcpErr.error.data.quota.used_today).toBe(4);
    expect(mcpErr.error.data.quota.remaining_today).toBe(0);

    const after = await fetch(
      new Request("http://localhost/v1/quota", { headers: { "cf-connecting-ip": IP } }),
      env,
      undefined as unknown as ExecutionContext,
    );
    expect(((await after.json()) as QuotaBody).used_today).toBe(4);

    const tagged = (
      sqlite.prepare("SELECT tool, outcome, n FROM source_daily WHERE src = ? ORDER BY tool, outcome") as unknown as {
        all(...args: unknown[]): Array<{ tool: string; outcome: string; n: number }>;
      }
    ).all("x");
    expect(tagged).toEqual([
      { tool: "get_quota", outcome: "ok", n: 2 },
      { tool: "score_spend", outcome: "limit", n: 2 },
      { tool: "score_spend", outcome: "ok", n: 5 },
    ]);
    const callerRows = (
      sqlite.prepare("SELECT caller_hash, n FROM source_callers") as unknown as {
        all(): Array<{ caller_hash: string; n: number }>;
      }
    ).all();
    expect(callerRows.reduce((sum, row) => sum + row.n, 0)).toBe(10);
    expect(callerRows.every((row) => row.caller_hash.length === 16 && !row.caller_hash.includes("203.0.113"))).toBe(true);
  });

  it("reports the write's count when a later read is stuck at 1", async () => {
    class StaleReplicaStore extends MemoryUsageStore {
      override async getUsage(subject: string, day: string): Promise<UsageSnapshot> {
        const real = await super.getUsage(subject, day);
        if (real.scoreCount === 0) return real;
        return { scoreCount: 1, paidCount: real.paidCount };
      }
    }
    const store = new StaleReplicaStore();
    const app = createApp({ store, now: () => NOW });
    const env = testEnv({ ANON_DAILY_LIMIT: "3", PAY_TO });
    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        "/v1/score?src=x",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": IP },
          body: JSON.stringify(micro),
        },
        env,
      );
      expect(res.status).toBe(200);
      seen.push(((await res.json()) as { quota: QuotaBody }).quota.used_today);
    }
    expect(seen).toEqual([1, 2, 3]);

    const blocked = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": IP },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "score_spend", arguments: micro },
        }),
      },
      env,
    );
    expect(blocked.status).toBe(402);
    expect(blocked.headers.get("payment-required")).toBeTruthy();
    const err = (await blocked.json()) as { error: { data: { quota: QuotaBody } } };
    expect(err.error.data.quota.used_today).toBe(3);
    expect(err.error.data.quota.remaining_today).toBe(0);
  });
});
