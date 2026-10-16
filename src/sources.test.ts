import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withSources } from "./sources.js";

const IP_A = "203.0.113.10";
const IP_B = "203.0.113.20";
const IP_C = "203.0.113.30";
const KEY = "sg_live_caller_example";

const REST: [RegExp, string][] = [
  [/^POST \/v1\/score$/, "score_spend"],
  [/^GET \/v1\/quota$/, "get_quota"],
];

interface SqliteDb {
  prepare(sql: string): {
    bind(...bound: unknown[]): unknown;
    run(): Promise<{ meta: { changes: number }; results: unknown[] }>;
    all<T>(): Promise<{ results: T[] }>;
  };
}

function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["migrations/0003_source_daily.sql", "migrations/0005_source_callers.sql"]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  const db: SqliteDb = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql) as unknown as {
        run(...args: never[]): { changes: number | bigint };
        all(...args: never[]): unknown[];
      };
      let args: unknown[] = [];
      const api = {
        bind(...bound: unknown[]) {
          args = bound;
          return api;
        },
        async run() {
          const result = statement.run(...(args as never[]));
          return { meta: { changes: Number(result.changes ?? 0) }, results: [] as unknown[] };
        },
        async all<T>() {
          return { results: statement.all(...(args as never[])) as T[] };
        },
      };
      return api;
    },
  };
  return { sqlite, db };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

type CallerRow = {
  day: string;
  src: string;
  ok: number;
  error: number;
  limit: number;
  unique_callers: number;
  unique_ok: number;
  unique_error: number;
  unique_limit: number;
  top_callers: Array<{ hash: string; n: number; ok: number; error: number; limit: number }>;
};

type SourcesBody = {
  note: string;
  totals: Record<string, { ok: number; error: number; limit: number }>;
  rows: Array<{ day: string; src: string; tool: string; outcome: string; n: number }>;
  callers: CallerRow[];
};

function handler(status = 200) {
  return withSources(async () => new Response("{}", { status, headers: { "content-type": "application/json" } }), REST);
}

async function call(
  fetch: ReturnType<typeof handler>,
  db: SqliteDb,
  path: string,
  init: { method?: string; ip?: string; key?: string; ua?: string; body?: unknown; status?: number } = {},
  env: Record<string, string> = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (init.ip) headers["cf-connecting-ip"] = init.ip;
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.ua) headers["user-agent"] = init.ua;
  const method = init.method ?? "POST";
  const bound = init.status === undefined ? fetch : handler(init.status);
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : JSON.stringify(init.body === undefined ? { ping: true } : init.body);
  return bound(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body,
    }),
    { DB: db, ...env },
    undefined as unknown as ExecutionContext,
  );
}

async function sources(db: SqliteDb, env: Record<string, string> = {}): Promise<SourcesBody> {
  const res = await handler()(
    new Request("http://localhost/v1/sources"),
    { DB: db, ...env },
    undefined as unknown as ExecutionContext,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SourcesBody;
}

describe("unique callers on GET /v1/sources", () => {
  it("counts callers per day and src, and per outcome, without storing the ip", async () => {
    const { sqlite, db } = sqliteDb();
    const day = dayStamp();
    const fetch = handler();
    for (let i = 0; i < 3; i += 1) await call(fetch, db, "/v1/score?src=x", { ip: IP_A, status: 200 });
    await call(fetch, db, "/v1/score?src=x", { ip: IP_A, status: 402 });
    await call(fetch, db, "/v1/score?src=x", { ip: IP_B, status: 500 });
    await call(fetch, db, "/mcp?src=x", {
      ip: IP_B,
      status: 200,
      body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_quota", arguments: {} } },
    });

    const body = await sources(db);
    const row = body.callers.find((item) => item.src === "x");
    expect(row).toMatchObject({
      day,
      src: "x",
      ok: 4,
      error: 1,
      limit: 1,
      unique_callers: 2,
      unique_ok: 2,
      unique_error: 1,
      unique_limit: 1,
    });
    const hashA = (await sha256Hex(`${day}:${IP_A}`)).slice(0, 8);
    const hashB = (await sha256Hex(`${day}:${IP_B}`)).slice(0, 8);
    expect(row?.top_callers).toEqual([
      { hash: hashA, n: 4, ok: 3, error: 0, limit: 1 },
      { hash: hashB, n: 2, ok: 1, error: 1, limit: 0 },
    ]);
    expect(row?.top_callers.every((caller) => caller.hash.length === 8)).toBe(true);
    expect(body.totals.x).toEqual({ ok: 4, error: 1, limit: 1 });
    expect(body.rows).toEqual([
      { day, src: "x", tool: "get_quota", outcome: "ok", n: 1 },
      { day, src: "x", tool: "score_spend", outcome: "error", n: 1 },
      { day, src: "x", tool: "score_spend", outcome: "limit", n: 1 },
      { day, src: "x", tool: "score_spend", outcome: "ok", n: 3 },
    ]);

    const stored = (
      sqlite.prepare("SELECT DISTINCT caller_hash FROM source_callers ORDER BY caller_hash") as unknown as {
        all(): Array<{ caller_hash: string }>;
      }
    ).all();
    expect(stored.map((item) => item.caller_hash)).toEqual(
      [(await sha256Hex(`${day}:${IP_A}`)).slice(0, 16), (await sha256Hex(`${day}:${IP_B}`)).slice(0, 16)].sort(),
    );
    const dumped = JSON.stringify(stored);
    expect(dumped).not.toContain(IP_A);
    expect(dumped).not.toContain(IP_B);
    expect(JSON.stringify(body)).not.toContain(IP_A);
    expect(body.note).toContain("not backfilled");
  });

  it("hashes the api key when one is present, even if the ip changes", async () => {
    const { sqlite, db } = sqliteDb();
    const day = dayStamp();
    const fetch = handler();
    await call(fetch, db, "/v1/score?src=site", { ip: IP_A, key: KEY, status: 200 });
    await call(fetch, db, "/v1/score?src=site", { ip: IP_B, key: KEY, status: 200 });
    await call(fetch, db, "/v1/score", { ip: IP_C, status: 200 });
    await call(fetch, db, "/v1/score?src=not-a-directory", { ip: IP_C, status: 429 });

    const body = await sources(db);
    const keyed = body.callers.find((item) => item.src === "site");
    expect(keyed).toMatchObject({ unique_callers: 1, ok: 2, unique_ok: 1 });
    expect(keyed?.top_callers).toEqual([{ hash: (await sha256Hex(`${day}:${KEY}`)).slice(0, 8), n: 2, ok: 2, error: 0, limit: 0 }]);
    expect(body.callers.find((item) => item.src === "direct")).toMatchObject({ unique_callers: 1, ok: 1 });
    expect(body.callers.find((item) => item.src === "other")).toMatchObject({ unique_callers: 1, limit: 1, unique_limit: 1 });

    const dumped = JSON.stringify(
      (
        sqlite.prepare("SELECT caller_hash FROM source_callers") as unknown as { all(): Array<{ caller_hash: string }> }
      ).all(),
    );
    expect(dumped).not.toContain(KEY);
    expect(dumped).not.toContain(IP_A);
  });

  it("skips our user agents, test-key hashes, and ip-hash prefixes", async () => {
    const { sqlite, db } = sqliteDb();
    const fetch = handler();
    const keyHash = await sha256Hex(KEY);
    const ipHash = await sha256Hex(IP_A);
    const env = {
      SOURCES_EXCLUDE_KEY_HASHES: ` aa, ${keyHash.slice(0, 10).toUpperCase()} `,
      SOURCES_EXCLUDE_IP_HASHES: ipHash.slice(0, 12),
    };
    await call(fetch, db, "/v1/score?src=x", { ip: IP_B, ua: "toolweather-health", status: 200 }, env);
    await call(fetch, db, "/v1/score?src=x", { ip: IP_B, key: KEY, status: 200 }, env);
    await call(fetch, db, "/v1/score?src=x", { ip: IP_A, key: "sg_live_other", status: 200 }, env);
    await call(fetch, db, "/v1/quota?src=x", { method: "GET", ip: IP_C, status: 200 }, env);

    const body = await sources(db, env);
    expect(body.callers).toEqual([
      expect.objectContaining({
        src: "x",
        ok: 1,
        unique_callers: 1,
        unique_ok: 1,
        top_callers: [expect.objectContaining({ hash: (await sha256Hex(`${dayStamp()}:${IP_C}`)).slice(0, 8), n: 1 })],
      }),
    ]);
    const count = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM source_daily") as unknown as { get(): { n: number } }
    ).get();
    expect(count.n).toBe(1);
  });

  it("keeps at most 10 top callers and ignores days outside the window", async () => {
    const { sqlite, db } = sqliteDb();
    const day = dayStamp();
    const insert = sqlite.prepare(
      "INSERT INTO source_callers (day, src, caller_hash, outcome, n) VALUES (?, ?, ?, 'ok', ?)",
    ) as unknown as { run(...args: Array<string | number>): unknown };
    for (let i = 0; i < 11; i += 1) {
      insert.run(day, "hn", (i + 1).toString(16).padStart(8, "0") + "ffffffff", 11 - i);
    }
    insert.run("2000-01-01", "hn", "bbbbbbbbbbbbbbbb", 50);

    const body = await sources(db);
    const row = body.callers.find((item) => item.src === "hn");
    expect(row?.unique_callers).toBe(11);
    expect(row?.top_callers).toHaveLength(10);
    expect(row?.top_callers[0]).toMatchObject({ hash: "00000001", n: 11 });
    expect(row?.top_callers[9]).toMatchObject({ n: 2 });
    expect(row?.top_callers.some((caller) => caller.n === 1)).toBe(false);
    expect(body.callers.some((item) => item.day === "2000-01-01")).toBe(false);
  });

  it("keeps the shared module copy note in sources.ts", () => {
    const text = readFileSync("src/sources.ts", "utf8");
    expect(text).toContain("source_callers");
    expect(text).toContain("toolweather");
    expect(text).toContain("upstream");
    expect(text).toContain("paycheck");
    expect(readFileSync("migrations/0005_source_callers.sql", "utf8")).toContain("no backfill");
    expect(readFileSync("README.md", "utf8")).toContain("not backfilled");
  });
});
