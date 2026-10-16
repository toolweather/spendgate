import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";
import { testEnv, type Env } from "./env.js";
import { encodeBase64Json, decodeBase64Json } from "./crypto.js";
import { MemoryUsageStore } from "./store.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const PAY_TO = "0x1111111111111111111111111111111111111111";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function appFor(envOver: Partial<Env> = {}, fetchImpl?: typeof fetch) {
  const store = new MemoryUsageStore();
  const app = createApp({
    store,
    fetchImpl,
    now: () => NOW,
    ids: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n.toString(16).padStart(8, "0");
      };
    })(),
  });
  const env = testEnv(envOver);
  return { app, env, store };
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
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    built.env,
  );
}

function payment(nonce: string) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: PAY_TO,
        value: "1000",
        validAfter: "0",
        validBefore: "1999999999",
        nonce,
      },
    },
  };
}

const microBody = {
  amount: 0.2,
  category: "status_check",
  merchant: "https://www.cloudflare.com/status",
  agent_id: "agent_demo",
};

describe("HTTP API", () => {
  it("scores anonymously and reports quota", async () => {
    const built = appFor();
    const res = await post(built, "/v1/score", microBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      score: number;
      verdict: string;
      reasons: string[];
      recommended_action: string;
      checked_at: string;
    };
    expect(body.verdict).toBe("approve");
    expect(body.score).toBeGreaterThanOrEqual(80);
    expect(body.reasons.length).toBeGreaterThan(0);
    expect(body.recommended_action.length).toBeGreaterThan(0);
    expect(body.checked_at).toBe(NOW.toISOString());
    expect(res.headers.get("x-spendgate-quota-remaining")).toBe("99");
  });

  it("does not consume quota on a validation error", async () => {
    const built = appFor();
    const bad = await post(built, "/v1/score", { category: "saas" });
    expect(bad.status).toBe(400);
    const quota = await built.app.request("/v1/quota", { headers: { "cf-connecting-ip": "203.0.113.10" } }, built.env);
    const body = (await quota.json()) as { used_today: number; remaining_today: number };
    expect(body.used_today).toBe(0);
    expect(body.remaining_today).toBe(100);
  });

  it("mints a free key and scores against that key's cap", async () => {
    const built = appFor();
    const minted = await post(built, "/v1/keys", { label: "planner" });
    expect(minted.status).toBe(201);
    const key = (await minted.json()) as { api_key: string; daily_limit: number };
    expect(key.api_key.startsWith("sg_live_")).toBe(true);
    expect(key.daily_limit).toBe(1000);

    const scored = await post(built, "/v1/score", { ...microBody, amount: 25, category: "saas" }, {
      authorization: `Bearer ${key.api_key}`,
    });
    expect(scored.status).toBe(200);
    const body = (await scored.json()) as { verdict: string; quota: { daily_limit: number; remaining_today: number } };
    expect(body.verdict).toBe("ask_human");
    expect(body.quota.daily_limit).toBe(1000);
    expect(body.quota.remaining_today).toBe(999);

    const missing = await post(built, "/v1/score", microBody, { authorization: "Bearer sg_live_not_a_key" });
    expect(missing.status).toBe(401);
  });

  it("returns 402 without a wallet when the anonymous cap is exhausted", async () => {
    const built = appFor({ ANON_DAILY_LIMIT: "1" });
    expect((await post(built, "/v1/score", microBody)).status).toBe(200);
    const blocked = await post(built, "/v1/score", microBody);
    expect(blocked.status).toBe(402);
    const body = (await blocked.json()) as { error: { code: string; message: string }; waitlist_url: string };
    expect(body.error.code).toBe("payment_not_configured");
    expect(body.waitlist_url).toBe("http://localhost/pro");
    expect(body.error.message).toContain("$19/mo");
    expect(body.error.message).toContain(body.waitlist_url);
    expect(blocked.headers.get("payment-required")).toBeNull();
  });

  it("verifies and settles x402 after the free cap, then replays the same nonce", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/verify")) {
        return Response.json({ isValid: true, payer: "0x2222222222222222222222222222222222222222" });
      }
      if (url.endsWith("/settle")) {
        return Response.json({
          success: true,
          transaction: "0xabc",
          network: "eip155:8453",
          payer: "0x2222222222222222222222222222222222222222",
        });
      }
      return new Response("missing", { status: 404 });
    };
    const built = appFor({ ANON_DAILY_LIMIT: "1", PAY_TO }, fetchImpl);
    expect((await post(built, "/v1/score", microBody)).status).toBe(200);

    const required = await post(built, "/v1/score", { amount: 40, category: "gift_card", merchant: "https://cards.example/buy" });
    expect(required.status).toBe(402);
    const header = required.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = decodeBase64Json(header!) as {
      x402Version: number;
      accepts: Array<{ amount: string; payTo: string; network: string }>;
      extensions: Record<string, unknown>;
    };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0]?.amount).toBe("1000");
    expect(decoded.accepts[0]?.payTo).toBe(PAY_TO);
    expect(decoded.accepts[0]?.network).toBe("eip155:8453");
    expect(decoded.extensions).toEqual({});
    expect(decoded).not.toHaveProperty("waitlist_url");
    const requiredBody = (await required.json()) as {
      x402Version: number;
      accepts: unknown[];
      extensions: Record<string, unknown>;
      waitlist_url: string;
    };
    expect(requiredBody.x402Version).toBe(2);
    expect(requiredBody.accepts).toHaveLength(1);
    expect(requiredBody.extensions).toEqual({});
    expect(requiredBody.waitlist_url).toBe("http://localhost/pro");

    const nonce = `0x${"ab".repeat(32)}`;
    const paid = await post(
      built,
      "/v1/score",
      { amount: 40, category: "gift_card", merchant: "https://cards.example/buy", agent_id: "agent_demo" },
      { "payment-signature": encodeBase64Json(payment(nonce)) },
    );
    expect(paid.status).toBe(200);
    const paidBody = (await paid.json()) as { verdict: string; detail: { payment: { transaction: string } } };
    expect(paidBody.verdict).toBe("block");
    expect(paidBody.detail.payment.transaction).toBe("0xabc");
    expect(calls.map((call) => call.split(" ")[0] + " " + new URL(call.split(" ")[1]!).pathname)).toEqual([
      "POST /verify",
      "POST /v1/check",
      "POST /settle",
    ]);

    calls.length = 0;
    const replay = await post(
      built,
      "/v1/score",
      { amount: 1, category: "status_check", merchant: "https://www.cloudflare.com" },
      { "payment-signature": encodeBase64Json(payment(nonce)) },
    );
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { verdict: string; detail: { payment: { replayed: boolean } } };
    expect(replayBody.verdict).toBe("block");
    expect(replayBody.detail.payment.replayed).toBe(true);
    expect(calls).toEqual([]);
  });

  it("rejects a payment the facilitator says is invalid", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/verify")) return Response.json({ isValid: false, invalidReason: "insufficient_funds" });
      return Response.json({ success: true, transaction: "0xno", network: "eip155:8453" });
    };
    const built = appFor({ ANON_DAILY_LIMIT: "0", PAY_TO }, fetchImpl);
    const res = await post(built, "/v1/score", microBody, {
      "payment-signature": encodeBase64Json(payment(`0x${"cd".repeat(32)}`)),
    });
    expect(res.status).toBe(402);
  });

  it("serves discovery documents", async () => {
    const built = appFor({ PAY_TO });
    const health = await built.app.request("/health", {}, built.env);
    expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true, service: "spendgate" });

    const policy = await built.app.request("/v1/policy", {}, built.env);
    const policyBody = (await policy.json()) as {
      policy_version: string;
      anonymous_daily_limit: number;
      paycheck: { url: string; attribution: { bundle_client: string } };
    };
    expect(policyBody.policy_version).toBe("1");
    expect(policyBody.anonymous_daily_limit).toBe(100);
    expect(policyBody.paycheck.url).toBe("https://paycheck.toolweather.workers.dev");
    expect(policyBody.paycheck.attribution.bundle_client).toBe("7370656e6467617465");

    const card = await built.app.request("/.well-known/mcp", {}, built.env);
    const cardBody = (await card.json()) as { transport: { endpoint: string }; tools: Array<{ name: string }> };
    expect(cardBody.transport.endpoint).toBe("/mcp");
    expect(cardBody.tools.map((tool) => tool.name)).toEqual(["score_spend", "get_quota", "get_api_key", "set_wallet_allowlist"]);

    const x402 = await built.app.request("/.well-known/x402", {}, built.env);
    const x402Body = (await x402.json()) as { configured: boolean; facilitator: string; resources: unknown[] };
    expect(x402Body.configured).toBe(true);
    expect(x402Body.facilitator).toBe("https://facilitator.payai.network");
    expect(x402Body.resources).toHaveLength(1);

    const llms = await built.app.request("/llms.txt", {}, built.env);
    expect(await llms.text()).toMatch(/When to use/);
    const spec = await built.app.request("/openapi.json", {}, built.env);
    const openapi = (await spec.json()) as { paths: Record<string, unknown> };
    expect(openapi.paths["/v1/score"]).toBeTruthy();
    expect(openapi.paths["/v1/waitlist"]).toBeTruthy();
    expect(openapi.paths["/v1/waitlist/count"]).toBeTruthy();
  });

  it("returns 503 for scores when D1 is not bound", async () => {
    const app = createApp();
    const res = await app.request(
      "/v1/score",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(microBody) },
      testEnv(),
    );
    expect(res.status).toBe(503);
  });
});

describe("PayCheck merchant trust", () => {
  it("keeps an allowlisted https merchant known without calling PayCheck", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return Response.json({ verdict: "block", score: 5 });
    };
    const built = appFor({}, fetchImpl);
    const res = await post(built, "/v1/score", {
      amount: 4,
      category: "api_call",
      merchant: "https://api.openai.com",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verdict: string;
      detail: { merchant_status: string; paycheck_verdict: string | null };
    };
    expect(called).toBe(false);
    expect(body.verdict).toBe("approve");
    expect(body.detail.merchant_status).toBe("known");
    expect(body.detail.paycheck_verdict).toBeNull();
  });

  it("uses a live trusted verdict and blocks http or raw IP when PayCheck says block", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const target = JSON.parse(String(init?.body)) as { target: string };
      if (target.target.startsWith("http://") || target.target.includes("203.0.113.10")) {
        return Response.json({ verdict: "block", score: 8 });
      }
      return Response.json({ verdict: "trusted", score: 100 });
    };
    const built = appFor({}, fetchImpl);

    const trusted = await post(built, "/v1/score", {
      amount: 4,
      category: "api_call",
      merchant: "https://api.perplexity.ai/chat",
    });
    expect(trusted.status).toBe(200);
    const trustedBody = (await trusted.json()) as {
      verdict: string;
      score: number;
      detail: { merchant_status: string; paycheck_verdict: string | null; penalties: { merchant: number } };
    };
    expect(trustedBody.detail.paycheck_verdict).toBe("trusted");
    expect(trustedBody.detail.merchant_status).toBe("known");
    expect(trustedBody.detail.penalties.merchant).toBe(0);
    expect(trustedBody.verdict).toBe("approve");
    expect(trustedBody.score).toBe(71);

    const http = await post(built, "/v1/score", {
      amount: 25,
      category: "saas",
      merchant: "http://pay.example.com/checkout",
    });
    const httpBody = (await http.json()) as {
      verdict: string;
      detail: { paycheck_verdict: string | null; penalties: { merchant: number } };
    };
    expect(http.status).toBe(200);
    expect(httpBody.verdict).toBe("block");
    expect(httpBody.detail.paycheck_verdict).toBe("block");
    expect(httpBody.detail.penalties.merchant).toBeGreaterThan(18);

    const ip = await post(built, "/v1/score", {
      amount: 0.2,
      category: "status_check",
      merchant: "https://203.0.113.10/pay",
    });
    const ipBody = (await ip.json()) as { verdict: string; score: number; detail: { micro_approved: boolean } };
    expect(ipBody.verdict).toBe("block");
    expect(ipBody.score).toBeLessThanOrEqual(24);
    expect(ipBody.detail.micro_approved).toBe(false);
  });

  it("still scores when PayCheck is unreachable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("paycheck down");
    };
    const built = appFor({}, fetchImpl);
    const res = await post(built, "/v1/score", {
      amount: 25,
      category: "saas",
      merchant: "https://pay.example.com/checkout",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verdict: string;
      score: number;
      detail: {
        merchant_status: string;
        paycheck_verdict: string | null;
        paycheck_error: string | null;
        penalties: { merchant: number };
      };
    };
    expect(body.detail.paycheck_verdict).toBeNull();
    expect(body.detail.paycheck_error).toBe("network");
    expect(body.detail.merchant_status).toBe("unknown");
    expect(body.detail.penalties.merchant).toBe(18);
    expect(body.verdict).toBe("block");
    expect(body.score).toBe(35);
  });

  it("uses the PAYCHECK service binding for a non-allowlisted merchant and skips it for openai.com", async () => {
    let publicFetch = 0;
    const fetchImpl: typeof fetch = async () => {
      publicFetch += 1;
      throw new Error("public workers.dev fetch should not run");
    };
    const seen: string[] = [];
    const binding = {
      fetch: async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        const payload = (await request.json()) as { target: string };
        seen.push(payload.target);
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/v1/check");
        return Response.json({ verdict: "suspicious", score: 55 });
      },
    } as Fetcher;
    const built = appFor({ PAYCHECK: binding }, fetchImpl);

    const suspicious = await post(built, "/v1/score", {
      amount: 5,
      category: "saas",
      merchant: "https://qz7k-pay-now-claim.biz",
    });
    expect(suspicious.status).toBe(200);
    const suspiciousBody = (await suspicious.json()) as {
      detail: { paycheck_verdict: string | null; paycheck_error: string | null; penalties: { merchant: number } };
    };
    expect(suspiciousBody.detail.paycheck_verdict).toBe("suspicious");
    expect(suspiciousBody.detail.paycheck_error).toBeNull();
    expect(suspiciousBody.detail.penalties.merchant).toBe(30);
    expect(seen).toEqual(["https://qz7k-pay-now-claim.biz"]);
    expect(publicFetch).toBe(0);

    const known = await post(built, "/v1/score", {
      amount: 5,
      category: "saas",
      merchant: "https://api.openai.com",
    });
    const knownBody = (await known.json()) as {
      detail: { merchant_status: string; paycheck_verdict: string | null; paycheck_error: string | null };
    };
    expect(known.status).toBe(200);
    expect(knownBody.detail.merchant_status).toBe("known");
    expect(knownBody.detail.paycheck_verdict).toBeNull();
    expect(knownBody.detail.paycheck_error).toBeNull();
    expect(seen).toEqual(["https://qz7k-pay-now-claim.biz"]);
    expect(publicFetch).toBe(0);
  });
});

describe("MCP", () => {
  it("initializes, lists tools, and calls score_spend, get_quota, and get_api_key", async () => {
    const built = appFor();
    const init = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initBody.result.protocolVersion).toBe("2025-06-18");
    expect(initBody.result.serverInfo.name).toBe("spendgate");

    const list = await post(built, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual([
      "score_spend",
      "get_quota",
      "get_api_key",
      "set_wallet_allowlist",
    ]);

    const minted = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_api_key", arguments: { label: "mcp" } },
    });
    const mintedBody = (await minted.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(mintedBody.result.isError).toBe(false);
    const key = JSON.parse(mintedBody.result.content[0]!.text) as { api_key: string };
    expect(key.api_key.startsWith("sg_live_")).toBe(true);

    const scored = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "score_spend",
        arguments: { ...microBody, api_key: key.api_key },
      },
    });
    const scoredBody = (await scored.json()) as { result: { content: Array<{ text: string }> } };
    const verdict = JSON.parse(scoredBody.result.content[0]!.text) as { verdict: string };
    expect(verdict.verdict).toBe("approve");

    const quota = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_quota", arguments: { api_key: key.api_key } },
    });
    const quotaBody = JSON.parse(((await quota.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as {
      remaining_today: number;
      tier: string;
    };
    expect(quotaBody.tier).toBe("free");
    expect(quotaBody.remaining_today).toBe(999);
  });
});

const BUNDLE_SECRET = "bundle-proxy-secret-test";
const CLIENT_A = "a".repeat(64);
const CLIENT_B = "b".repeat(64);
const CLIENT_ANON = `anon:${"c".repeat(24)}`;

function bundleHeaders(client: string, secret: string = BUNDLE_SECRET): Record<string, string> {
  return { "x-tw-bundle-secret": secret, "x-tw-bundle-client": client };
}

describe("Toolweather bundle proxy headers", () => {
  it("caps anon: bundle clients at the anonymous daily limit and hex clients at the free-key limit", async () => {
    const built = appFor({ BUNDLE_PROXY_SECRET: BUNDLE_SECRET });

    const anon = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_ANON));
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const anonQuota = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "198.51.100.8", ...bundleHeaders(`ANON:${"c".repeat(24)}`) } },
      built.env,
    );
    const anonQuotaBody = (await anonQuota.json()) as {
      subject: string;
      tier: string;
      daily_limit: number;
      used_today: number;
      remaining_today: number;
    };
    expect(anonQuotaBody.subject).toBe("bundle");
    expect(anonQuotaBody.tier).toBe("bundle");
    expect(anonQuotaBody.daily_limit).toBe(100);
    expect(anonQuotaBody.used_today).toBe(1);
    expect(anonQuotaBody.remaining_today).toBe(99);

    const otherAnon = await post(built, "/v1/score", microBody, bundleHeaders(`anon:${"e".repeat(24)}`));
    expect(((await otherAnon.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const hex = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A));
    expect(hex.status).toBe(200);
    expect(((await hex.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 1000,
      remaining_today: 999,
    });

    const hexQuota = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "198.51.100.9", ...bundleHeaders(CLIENT_A) } },
      built.env,
    );
    expect((await hexQuota.json()) as { subject: string; tier: string; daily_limit: number; used_today: number }).toMatchObject({
      subject: "bundle",
      tier: "bundle",
      daily_limit: 1000,
      used_today: 1,
    });

    const wrong = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_ANON, "not-the-secret"));
    expect(wrong.status).toBe(200);
    expect(((await wrong.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const wrongOtherClient = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A, "not-the-secret"));
    expect(((await wrongOtherClient.json()) as { quota: { remaining_today: number } }).quota.remaining_today).toBe(98);

    const wrongQuota = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "203.0.113.10", ...bundleHeaders(CLIENT_A, "not-the-secret") } },
      built.env,
    );
    expect((await wrongQuota.json()) as { subject: string; tier: string; daily_limit: number; used_today: number }).toMatchObject({
      subject: "anonymous",
      tier: "anonymous",
      daily_limit: 100,
      used_today: 2,
    });
  });

  it("attributes free-key quota to the bundle client when the secret matches", async () => {
    const built = appFor({ BUNDLE_PROXY_SECRET: BUNDLE_SECRET, ANON_DAILY_LIMIT: "100", KEY_DAILY_LIMIT: "5" });

    const first = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { quota: { daily_limit: number; remaining_today: number } };
    expect(firstBody.quota.daily_limit).toBe(5);
    expect(firstBody.quota.remaining_today).toBe(4);
    expect(first.headers.get("x-spendgate-quota-remaining")).toBe("4");

    const again = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A.toUpperCase()));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { quota: { remaining_today: number } }).quota.remaining_today).toBe(3);

    const otherIp = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "198.51.100.20", ...bundleHeaders(CLIENT_A) } },
      built.env,
    );
    expect(((await otherIp.json()) as { used_today: number; tier: string }).used_today).toBe(2);

    const other = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_B));
    expect(other.status).toBe(200);
    expect(((await other.json()) as { quota: { remaining_today: number } }).quota.remaining_today).toBe(4);

    const anonClient = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_ANON));
    expect(anonClient.status).toBe(200);
    expect(((await anonClient.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const longClient = "d".repeat(160);
    const longFirst = await post(built, "/v1/score", microBody, bundleHeaders(longClient));
    expect(((await longFirst.json()) as { quota: { remaining_today: number } }).quota.remaining_today).toBe(4);
    const longPrefix = await post(built, "/v1/score", microBody, bundleHeaders("d".repeat(128)));
    expect(((await longPrefix.json()) as { quota: { remaining_today: number } }).quota.remaining_today).toBe(3);

    const anonQuota = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "203.0.113.10" } },
      built.env,
    );
    const anonBody = (await anonQuota.json()) as { subject: string; tier: string; used_today: number; daily_limit: number };
    expect(anonBody.subject).toBe("anonymous");
    expect(anonBody.tier).toBe("anonymous");
    expect(anonBody.daily_limit).toBe(100);
    expect(anonBody.used_today).toBe(0);

    const badClient = await post(built, "/v1/score", microBody, bundleHeaders("not-a-client-id"));
    expect(badClient.status).toBe(200);
    expect(((await badClient.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const quota = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "203.0.113.10", ...bundleHeaders(CLIENT_A) } },
      built.env,
    );
    const quotaBody = (await quota.json()) as {
      subject: string;
      tier: string;
      key_id: string | null;
      daily_limit: number;
      used_today: number;
      remaining_today: number;
    };
    expect(quota.status).toBe(200);
    expect(quotaBody.subject).toBe("bundle");
    expect(quotaBody.tier).toBe("bundle");
    expect(quotaBody.key_id).toBeNull();
    expect(quotaBody.daily_limit).toBe(5);
    expect(quotaBody.used_today).toBe(2);
    expect(quotaBody.remaining_today).toBe(3);

    const minted = await post(built, "/v1/keys", { label: "direct" });
    const key = (await minted.json()) as { api_key: string };
    const keyed = await post(built, "/v1/score", microBody, {
      authorization: `Bearer ${key.api_key}`,
      ...bundleHeaders(CLIENT_A),
    });
    const keyedBody = (await keyed.json()) as { quota: { daily_limit: number; remaining_today: number } };
    expect(keyed.status).toBe(200);
    expect(keyedBody.quota.daily_limit).toBe(5);
    expect(keyedBody.quota.remaining_today).toBe(4);

    const bundleAfterKey = await built.app.request(
      "/v1/quota",
      { headers: { "cf-connecting-ip": "203.0.113.10", ...bundleHeaders(CLIENT_A) } },
      built.env,
    );
    expect(((await bundleAfterKey.json()) as { used_today: number; tier: string }).used_today).toBe(2);

    const mcp = await post(built, "/mcp", {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "score_spend", arguments: microBody },
    }, bundleHeaders(CLIENT_B));
    const mcpBody = JSON.parse(((await mcp.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as {
      quota: { remaining_today: number };
    };
    expect(mcpBody.quota.remaining_today).toBe(3);
  });

  it("keeps the anonymous bucket when the secret does not match", async () => {
    const built = appFor({ BUNDLE_PROXY_SECRET: BUNDLE_SECRET, ANON_DAILY_LIMIT: "100", KEY_DAILY_LIMIT: "5" });
    const wrong = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A, "not-the-secret"));
    expect(wrong.status).toBe(200);
    const wrongBody = (await wrong.json()) as { quota: { daily_limit: number; remaining_today: number } };
    expect(wrongBody.quota.daily_limit).toBe(100);
    expect(wrongBody.quota.remaining_today).toBe(99);

    const otherClient = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_B, "not-the-secret"));
    expect(((await otherClient.json()) as { quota: { remaining_today: number } }).quota.remaining_today).toBe(98);

    const bare = await post(built, "/v1/score", microBody);
    expect(((await bare.json()) as { quota: { remaining_today: number; daily_limit: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 97,
    });
  });

  it("keeps anonymous and API-key behavior when the bundle secret is absent", async () => {
    const configured = appFor({ BUNDLE_PROXY_SECRET: BUNDLE_SECRET });
    const noHeaders = await post(configured, "/v1/score", microBody);
    expect(noHeaders.status).toBe(200);
    expect(((await noHeaders.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const clientOnly = await post(configured, "/v1/score", microBody, { "x-tw-bundle-client": CLIENT_A });
    expect(((await clientOnly.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 98,
    });

    const unset = appFor();
    const ignored = await post(unset, "/v1/score", microBody, bundleHeaders(CLIENT_A));
    expect(ignored.status).toBe(200);
    expect(((await ignored.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const minted = await post(unset, "/v1/keys", { label: "still-works" });
    const key = (await minted.json()) as { api_key: string; daily_limit: number };
    expect(key.api_key.startsWith("sg_live_")).toBe(true);
    expect(key.daily_limit).toBe(1000);
    const scored = await post(unset, "/v1/score", microBody, { authorization: `Bearer ${key.api_key}` });
    expect(((await scored.json()) as { quota: { daily_limit: number; remaining_today: number } }).quota).toMatchObject({
      daily_limit: 1000,
      remaining_today: 999,
    });
  });

  it("still returns 402 on the bundle cap and mints keys per bundle client", async () => {
    const built = appFor({
      BUNDLE_PROXY_SECRET: BUNDLE_SECRET,
      ANON_DAILY_LIMIT: "100",
      KEY_DAILY_LIMIT: "1",
      KEYS_PER_DAY: "1",
    });
    expect((await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A))).status).toBe(200);
    const blocked = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_A));
    expect(blocked.status).toBe(402);
    const blockedBody = (await blocked.json()) as { error: { code: string }; waitlist_url: string };
    expect(blockedBody.error.code).toBe("payment_not_configured");
    expect(blockedBody.waitlist_url).toBe("http://localhost/pro");

    const other = await post(built, "/v1/score", microBody, bundleHeaders(CLIENT_B));
    expect(other.status).toBe(200);

    const anon = await post(built, "/v1/score", microBody);
    expect(((await anon.json()) as { quota: { remaining_today: number; daily_limit: number } }).quota).toMatchObject({
      daily_limit: 100,
      remaining_today: 99,
    });

    const firstKey = await post(built, "/v1/keys", { label: "a" }, bundleHeaders(CLIENT_A));
    expect(firstKey.status).toBe(201);
    const secondSame = await post(built, "/v1/keys", { label: "a2" }, bundleHeaders(CLIENT_A));
    expect(secondSame.status).toBe(429);
    const otherClient = await post(built, "/v1/keys", { label: "b" }, bundleHeaders(CLIENT_B));
    expect(otherClient.status).toBe(201);
  });
});

describe("SpendGate Pro waitlist", () => {
  it("stores a lowercased email once and returns a public count with no addresses", async () => {
    const built = appFor();
    const empty = await built.app.request("/v1/waitlist/count", {}, built.env);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ count: 0 });

    const created = await post(built, "/v1/waitlist", { email: " Team@Example.com ", source: "pro" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true });

    const again = await post(built, "/v1/waitlist", { email: "team@example.com", source: "landing" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });

    const count = await built.app.request("/v1/waitlist/count", {}, built.env);
    const countBody = (await count.json()) as Record<string, unknown>;
    expect(countBody).toEqual({ count: 1 });
    expect(JSON.stringify(countBody)).not.toContain("example.com");
  });

  it("rejects a bad email, ignores the honeypot, and caps signups per IP per day", async () => {
    const built = appFor();
    const bad = await post(built, "/v1/waitlist", { email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_email");

    const bot = await post(built, "/v1/waitlist", { email: "bot@example.com", hp_field: "https://spam.example" });
    expect(bot.status).toBe(200);
    expect(await bot.json()).toEqual({ ok: true });

    for (let i = 0; i < 10; i += 1) {
      const res = await post(built, "/v1/waitlist", { email: `person${i}@example.com`, source: "pro" });
      expect(res.status).toBe(201);
    }
    const capped = await post(built, "/v1/waitlist", { email: "overflow@example.com" });
    expect(capped.status).toBe(429);

    const otherIp = await post(built, "/v1/waitlist", { email: "overflow@example.com" }, { "cf-connecting-ip": "198.51.100.20" });
    expect(otherIp.status).toBe(201);

    const counted = (await (await built.app.request("/v1/waitlist/count", {}, built.env)).json()) as { count: number };
    expect(counted.count).toBe(11);
  });

  it("accepts a form post and returns 503 when D1 is not bound", async () => {
    const built = appFor();
    const form = await built.app.request(
      "/v1/waitlist",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.10",
        },
        body: "email=ada%40team.example&source=pro&hp_field=",
      },
      built.env,
    );
    expect(form.status).toBe(201);

    const app = createApp();
    const missing = await app.request(
      "/v1/waitlist",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@team.example" }) },
      testEnv(),
    );
    expect(missing.status).toBe(503);
    const count = await app.request("/v1/waitlist/count", {}, testEnv());
    expect(count.status).toBe(503);
  });

  it("points MCP at the waitlist without putting that field in the x402 header", async () => {
    const unpaid = appFor({ ANON_DAILY_LIMIT: "0" });
    const blocked = await post(unpaid, "/mcp", {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "score_spend", arguments: microBody },
    });
    expect(blocked.status).toBe(402);
    const blockedBody = (await blocked.json()) as {
      error: { code: number; message: string; data: { error: { code: string }; waitlist_url: string } };
    };
    expect(blockedBody.error.code).toBe(-32002);
    expect(blockedBody.error.data.error.code).toBe("payment_not_configured");
    expect(blockedBody.error.data.waitlist_url).toBe("http://localhost/pro");
    expect(blockedBody.error.message).toContain(blockedBody.error.data.waitlist_url);

    const paid = appFor({ ANON_DAILY_LIMIT: "0", PAY_TO });
    const required = await post(paid, "/mcp", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "score_spend", arguments: microBody },
    });
    expect(required.status).toBe(402);
    const header = required.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = decodeBase64Json(header!) as { x402Version: number; accepts: unknown[]; extensions: Record<string, unknown> };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.extensions).toEqual({});
    expect(decoded).not.toHaveProperty("waitlist_url");
    const requiredBody = (await required.json()) as { error: { data: { waitlist_url: string; x402Version: number } } };
    expect(requiredBody.error.data.x402Version).toBe(2);
    expect(requiredBody.error.data.waitlist_url).toBe("http://localhost/pro");
  });
});
