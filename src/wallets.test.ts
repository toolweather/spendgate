import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp, SG_REST } from "./index.js";
import { testEnv, type Env } from "./env.js";
import { APPROVE_MIN_SCORE, BUDGET_SCORE_CAP } from "./scoring.js";
import { D1UsageStore, MemoryUsageStore } from "./store.js";
import { decideWallet, isDevWallet, parseAllowlistBody, parseWalletFields } from "./wallets.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const HARDHAT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GANACHE_0 = "0x627306090abaB3A6e1400e9345bC60c78a8BEf57";
const BIP39_0 = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TRUFFLE_0 = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1";
const OWNED = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const DEMO_URL = "https://spendgate.toolweather.workers.dev/v1/score?src=x";
const DEMO_BODY =
  '{"amount":0.4,"currency":"USDC","category":"crypto_transfer","purpose":"deploy on sepolia","from_wallet":"0x2222222222222222222222222222222222222222","allowed_wallets":["0x3333333333333333333333333333333333333333"]}';

function appFor(envOver: Partial<Env> = {}) {
  const store = new MemoryUsageStore();
  const app = createApp({
    store,
    now: () => NOW,
    ids: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n.toString(16).padStart(8, "0");
      };
    })(),
  });
  return { app, env: testEnv(envOver), store };
}

function post(
  built: ReturnType<typeof appFor>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return built.app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10", ...headers },
      body: JSON.stringify(body),
    },
    built.env,
  );
}

const micro = {
  amount: 0.4,
  currency: "USDC",
  category: "crypto_transfer",
  purpose: "deploy on sepolia",
  merchant: "https://www.cloudflare.com",
};

interface ScoreBody {
  score: number;
  verdict: string;
  reasons: string[];
  recommended_action: string;
  payment_source: {
    from_wallet: string | null;
    allowlisted: boolean | null;
    checked_at: string;
    reason: string | null;
    signature?: string;
  };
  detail: { micro_approved: boolean };
  quota: { remaining_today: number };
}

function sqliteAllowlist() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0004_wallet_allowlist.sql", "utf8"));
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

describe("dev wallets", () => {
  it("recognizes published mnemonic accounts 0 and ignores a normal address", () => {
    expect(isDevWallet(HARDHAT_0)).toBe(true);
    expect(isDevWallet(HARDHAT_0.toLowerCase())).toBe(true);
    expect(isDevWallet(GANACHE_0)).toBe(true);
    expect(isDevWallet(BIP39_0)).toBe(true);
    expect(isDevWallet(TRUFFLE_0)).toBe(true);
    expect(isDevWallet(OWNED)).toBe(false);
  });
});

describe("decideWallet", () => {
  it("leaves callers that omit from_wallet alone", () => {
    expect(decideWallet({ fromWallet: null, requestAllowlist: [OWNED], storedAllowlist: [OTHER] })).toEqual({
      fromWallet: null,
      allowlisted: null,
      reason: null,
    });
  });

  it("prefers the request list over the stored list", () => {
    const hit = decideWallet({ fromWallet: OWNED, requestAllowlist: [OWNED], storedAllowlist: [] });
    expect(hit.reason).toBeNull();
    expect(hit.allowlisted).toBe(true);
    const miss = decideWallet({ fromWallet: OWNED, requestAllowlist: [OTHER], storedAllowlist: [OWNED] });
    expect(miss.reason).toBe("unauthorized_wallet");
  });

  it("blocks a dev account even when the allowlist names it", () => {
    const decision = decideWallet({
      fromWallet: HARDHAT_0.toLowerCase(),
      requestAllowlist: [HARDHAT_0.toLowerCase()],
      storedAllowlist: null,
    });
    expect(decision.reason).toBe("dev_wallet");
    expect(decision.allowlisted).toBe(true);
  });

  it("blocks a dev account with no allowlist instead of asking a human", () => {
    const decision = decideWallet({
      fromWallet: HARDHAT_0.toLowerCase(),
      requestAllowlist: null,
      storedAllowlist: null,
    });
    expect(decision).toMatchObject({ reason: "dev_wallet", allowlisted: null });
  });
});

describe("wallet HTTP", () => {
  it("keeps a score unchanged when no wallet is passed, and does not read an allowlist", async () => {
    const built = appFor();
    let reads = 0;
    const original = built.store.getWalletAllowlist.bind(built.store);
    built.store.getWalletAllowlist = async (keyId) => {
      reads += 1;
      return original(keyId);
    };
    const res = await post(built, "/v1/score", micro);
    const body = (await res.json()) as ScoreBody;
    expect(res.status).toBe(200);
    expect(body.verdict).toBe("approve");
    expect(body.score).toBeGreaterThanOrEqual(80);
    expect(body.reasons.some((reason) => reason.includes("wallet"))).toBe(false);
    expect(body.payment_source).toEqual({
      from_wallet: null,
      allowlisted: null,
      checked_at: NOW.toISOString(),
      reason: null,
    });
    expect(body.payment_source.signature).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("blocks the published unauthorized-wallet demo under the micro threshold", async () => {
    const built = appFor();
    const res = await post(built, "/v1/score?src=x", JSON.parse(DEMO_BODY) as unknown);
    const body = (await res.json()) as ScoreBody;
    expect(res.status).toBe(200);
    expect(body.verdict).toBe("block");
    expect(body.reasons[0]).toBe("unauthorized_wallet");
    expect(body.score).toBeLessThanOrEqual(BUDGET_SCORE_CAP);
    expect(body.detail.micro_approved).toBe(false);
    expect(body.recommended_action).toMatch(/not on the allowlist/);
    expect(body.payment_source).toMatchObject({
      from_wallet: OWNED,
      allowlisted: false,
      checked_at: NOW.toISOString(),
      reason: "unauthorized_wallet",
    });
  });

  it("blocks a Hardhat account that the caller tried to allowlist", async () => {
    const built = appFor();
    const res = await post(built, "/v1/score", {
      ...micro,
      from_wallet: HARDHAT_0,
      allowed_wallets: [HARDHAT_0, OWNED],
    });
    const body = (await res.json()) as ScoreBody;
    expect(body.verdict).toBe("block");
    expect(body.reasons[0]).toBe("dev_wallet");
    expect(body.payment_source.allowlisted).toBe(true);
    expect(body.payment_source.from_wallet).toBe(HARDHAT_0.toLowerCase());
    expect(body.score).toBeLessThanOrEqual(BUDGET_SCORE_CAP);
  });

  it("blocks Ganache, BIP-39, and Truffle tutorial accounts", async () => {
    const built = appFor();
    for (const from_wallet of [GANACHE_0, BIP39_0, TRUFFLE_0]) {
      const res = await post(built, "/v1/score", { ...micro, from_wallet, allowed_wallets: [OWNED] });
      const body = (await res.json()) as ScoreBody;
      expect(body.payment_source.reason).toBe("dev_wallet");
      expect(body.verdict).toBe("block");
    }
  });

  it("asks a human when from_wallet has no allowlist, and does not weaken a budget block", async () => {
    const built = appFor();
    const ask = await post(built, "/v1/score", { ...micro, from_wallet: OWNED });
    const askBody = (await ask.json()) as ScoreBody;
    expect(askBody.verdict).toBe("ask_human");
    expect(askBody.reasons[0]).toBe("wallet_unverified");
    expect(askBody.score).toBeLessThan(APPROVE_MIN_SCORE);
    expect(askBody.payment_source.allowlisted).toBeNull();
    expect(askBody.recommended_action).toMatch(/Ask a human/);

    const blocked = await post(built, "/v1/score", {
      ...micro,
      amount: 30,
      daily_budget_remaining: 10,
      from_wallet: OWNED,
    });
    const blockedBody = (await blocked.json()) as ScoreBody;
    expect(blockedBody.verdict).toBe("block");
    expect(blockedBody.payment_source.reason).toBe("wallet_unverified");
    expect(blockedBody.recommended_action).toMatch(/remaining budget/);
  });

  it("approves an allowlisted wallet and matches checksummed input", async () => {
    const built = appFor();
    const res = await post(built, "/v1/score", {
      ...micro,
      from_wallet: OWNED.toUpperCase().replace("0X", "0x"),
      allowed_wallets: [OWNED],
    });
    const body = (await res.json()) as ScoreBody;
    expect(body.verdict).toBe("approve");
    expect(body.payment_source).toMatchObject({ from_wallet: OWNED, allowlisted: true, reason: null });
    expect(body.reasons.some((reason) => reason.endsWith("_wallet"))).toBe(false);
  });

  it("does not consume quota on a bad address", async () => {
    const built = appFor();
    const bad = await post(built, "/v1/score", { ...micro, from_wallet: "0x1234" });
    expect(bad.status).toBe(400);
    const quota = await built.app.request("/v1/quota", { headers: { "cf-connecting-ip": "203.0.113.10" } }, built.env);
    expect(((await quota.json()) as { used_today: number }).used_today).toBe(0);
  });

  it("signs payment_source only when BUNDLE_PROXY_SECRET is set", async () => {
    const unsigned = appFor({ PAY_TO: "0x1111111111111111111111111111111111111111" });
    const plain = (await (await post(unsigned, "/v1/score", JSON.parse(DEMO_BODY) as unknown)).json()) as ScoreBody;
    expect(plain.payment_source.signature).toBeUndefined();

    const signed = appFor({ BUNDLE_PROXY_SECRET: "bundle-proxy-secret-test" });
    const body = (await (await post(signed, "/v1/score", JSON.parse(DEMO_BODY) as unknown)).json()) as ScoreBody;
    expect(body.verdict).toBe("block");
    expect(body.payment_source.signature).toBe("adc39b8fbf50212f5d5a83c9916faf352d760651422a826729627f8105155f33");
  });

  it("stores a per-key allowlist and uses it when the score omits allowed_wallets", async () => {
    const built = appFor();
    let reads = 0;
    const original = built.store.getWalletAllowlist.bind(built.store);
    built.store.getWalletAllowlist = async (keyId) => {
      reads += 1;
      return original(keyId);
    };
    const minted = await post(built, "/v1/keys", { label: "payer" });
    const key = (await minted.json()) as { api_key: string };
    const before = await built.app.request(
      "/v1/quota",
      { headers: { authorization: `Bearer ${key.api_key}` } },
      built.env,
    );
    const remainingBefore = ((await before.json()) as { remaining_today: number }).remaining_today;

    const denied = await post(built, "/v1/wallet-allowlist", { allowed_wallets: [HARDHAT_0] }, {
      authorization: `Bearer ${key.api_key}`,
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("dev_wallet");

    const anon = await post(built, "/v1/wallet-allowlist", { allowed_wallets: [OWNED] });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("api_key_required");

    const saved = await post(
      built,
      "/v1/wallet-allowlist",
      { allowed_wallets: [OWNED, OWNED.toUpperCase().replace("0X", "0x")] },
      { authorization: `Bearer ${key.api_key}` },
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { allowed_wallets: string[]; key_id: string };
    expect(savedBody.allowed_wallets).toEqual([OWNED]);

    const replaced = await post(
      built,
      "/v1/wallet-allowlist",
      { allowed_wallets: [OTHER] },
      { authorization: `Bearer ${key.api_key}` },
    );
    expect(((await replaced.json()) as { allowed_wallets: string[] }).allowed_wallets).toEqual([OTHER]);

    const after = await built.app.request(
      "/v1/quota",
      { headers: { authorization: `Bearer ${key.api_key}` } },
      built.env,
    );
    expect(((await after.json()) as { remaining_today: number }).remaining_today).toBe(remainingBefore);

    reads = 0;
    const usingStored = await post(
      built,
      "/v1/score",
      { ...micro, from_wallet: OTHER },
      { authorization: `Bearer ${key.api_key}` },
    );
    const storedBody = (await usingStored.json()) as ScoreBody;
    expect(storedBody.verdict).toBe("approve");
    expect(storedBody.payment_source.allowlisted).toBe(true);
    expect(reads).toBe(1);

    const overridden = await post(
      built,
      "/v1/score",
      { ...micro, from_wallet: OTHER, allowed_wallets: [OWNED] },
      { authorization: `Bearer ${key.api_key}` },
    );
    const overriddenBody = (await overridden.json()) as ScoreBody;
    expect(overriddenBody.verdict).toBe("block");
    expect(overriddenBody.payment_source.reason).toBe("unauthorized_wallet");

    const empty = await post(built, "/v1/wallet-allowlist", { allowed_wallets: [] }, {
      authorization: `Bearer ${key.api_key}`,
    });
    expect(empty.status).toBe(200);
    const emptied = await post(
      built,
      "/v1/score",
      { ...micro, from_wallet: OTHER },
      { authorization: `Bearer ${key.api_key}` },
    );
    expect(((await emptied.json()) as ScoreBody).payment_source.reason).toBe("unauthorized_wallet");
  });

  it("sets the allowlist from MCP and then scores against it", async () => {
    const built = appFor();
    const minted = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_api_key", arguments: {} },
    });
    const key = JSON.parse(
      ((await minted.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { api_key: string };

    const set = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "set_wallet_allowlist", arguments: { api_key: key.api_key, allowed_wallets: [OWNED] } },
    });
    const setBody = JSON.parse(
      ((await set.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { allowed_wallets: string[] };
    expect(setBody.allowed_wallets).toEqual([OWNED]);

    const scored = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "score_spend",
        arguments: { ...micro, api_key: key.api_key, from_wallet: GANACHE_0 },
      },
    });
    const verdict = JSON.parse(
      ((await scored.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as ScoreBody;
    expect(verdict.verdict).toBe("block");
    expect(verdict.payment_source.reason).toBe("dev_wallet");
  });
});

describe("allowlist storage", () => {
  it("replaces the row in one write and treats a missing row as no list", async () => {
    const { store, writes, reads } = sqliteAllowlist();
    expect(await store.getWalletAllowlist("key_1")).toBeNull();
    expect(reads).toHaveLength(1);
    reads.length = 0;

    await store.setWalletAllowlist("key_1", [OWNED], "2026-10-16T00:00:00.000Z");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/INSERT INTO wallet_allowlist/);
    expect(writes[0]).toMatch(/ON CONFLICT\(key_id\) DO UPDATE/);
    expect(reads).toHaveLength(0);

    writes.length = 0;
    await store.setWalletAllowlist("key_1", [], "2026-10-16T00:01:00.000Z");
    expect(writes).toHaveLength(1);
    expect(await store.getWalletAllowlist("key_1")).toEqual([]);
  });

  it("rejects a dev account before a caller could store it", () => {
    const parsed = parseAllowlistBody({ allowed_wallets: [OWNED, HARDHAT_0] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("dev_wallet");
    expect(parseWalletFields({ from_wallet: "nope" }).ok).toBe(false);
    const empty = parseWalletFields({});
    expect(empty.ok && empty.fromWallet).toBeNull();
  });
});

describe("docs and source tags", () => {
  it("shows one unauthorized-wallet curl with ?src=x on the README, landing page, and pro page", () => {
    for (const path of ["README.md", "public/index.html", "public/pro.html"]) {
      const text = readFileSync(path, "utf8");
      expect(text).toContain(DEMO_URL);
      expect(text).toContain(DEMO_BODY);
      expect(text).toContain("unauthorized_wallet");
    }
  });

  it("keeps source tagging and adds the allowlist route beside the existing tools", () => {
    expect(SG_REST.map(([pattern, tool]) => [pattern.source, tool])).toEqual([
      ["^POST \\/v1\\/score$", "score_spend"],
      ["^GET \\/v1\\/quota$", "get_quota"],
      ["^POST \\/v1\\/wallet-allowlist$", "set_wallet_allowlist"],
    ]);
    expect(readFileSync("src/sources.ts", "utf8")).toContain("normalizeSrc");
    expect(readFileSync("src/sources.ts", "utf8")).toContain("source_daily");
  });
});
