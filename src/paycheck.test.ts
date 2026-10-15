import { describe, expect, it } from "vitest";
import { readConfig, SPENDGATE_PAYCHECK_CLIENT, testEnv } from "./env.js";
import { lookupPaycheck, paycheckTarget } from "./paycheck.js";

describe("paycheckTarget", () => {
  it("skips the local https allowlist and still checks http, IPs, wallets, and other domains", () => {
    expect(paycheckTarget("https://api.openai.com/v1")).toBeNull();
    expect(paycheckTarget("https://api.openai.com")).toBeNull();
    expect(paycheckTarget("openai.com")).toBeNull();
    expect(paycheckTarget("openai")).toBeNull();
    expect(paycheckTarget(null)).toBeNull();
    expect(paycheckTarget("  ")).toBeNull();

    expect(paycheckTarget("https://api.perplexity.ai/chat")).toBe("https://api.perplexity.ai/chat");
    expect(paycheckTarget("pay.example.com")).toBe("pay.example.com");
    expect(paycheckTarget("http://api.openai.com/v1")).toBe("http://api.openai.com/v1");
    expect(paycheckTarget("http://pay.example.com")).toBe("http://pay.example.com");
    expect(paycheckTarget("https://1.2.3.4/pay")).toBe("https://1.2.3.4/pay");
    expect(paycheckTarget("https://api.openai.com:8443/v1")).toBe("https://api.openai.com:8443/v1");
    expect(paycheckTarget("https://user:pass@api.openai.com/v1")).toBe("https://user:pass@api.openai.com/v1");
    expect(paycheckTarget("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  });
});

describe("lookupPaycheck", () => {
  it("reads a verdict and attributes the call to SpendGate, not the end user", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return Response.json({ verdict: "trusted", score: 100 });
    };
    const config = readConfig(testEnv({ BUNDLE_PROXY_SECRET: "suite-secret", PAYCHECK_API_KEY: "" }));
    const verdict = await lookupPaycheck(fetchImpl, config, "https://api.perplexity.ai");
    expect(verdict).toEqual({ verdict: "trusted", error: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://paycheck.toolweather.workers.dev/v1/check");
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("x-tw-bundle-secret")).toBe("suite-secret");
    expect(headers.get("x-tw-bundle-client")).toBe(SPENDGATE_PAYCHECK_CLIENT);
    expect(headers.get("authorization")).toBeNull();
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ target: "https://api.perplexity.ai" });
  });

  it("prefers PAYCHECK_API_KEY over the bundle secret", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer pc_live_test");
      expect(headers.get("x-api-key")).toBe("pc_live_test");
      expect(headers.get("x-tw-bundle-secret")).toBeNull();
      expect(headers.get("x-tw-bundle-client")).toBeNull();
      return Response.json({ verdict: "suspicious" });
    };
    const config = readConfig(testEnv({ BUNDLE_PROXY_SECRET: "suite-secret", PAYCHECK_API_KEY: "pc_live_test" }));
    expect(await lookupPaycheck(fetchImpl, config, "pay.example.com")).toEqual({ verdict: "suspicious", error: null });
  });

  it("stays anonymous when no secret is configured", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-tw-bundle-secret")).toBeNull();
      return Response.json({ verdict: "unknown" });
    };
    const config = readConfig(testEnv());
    expect(config.paycheckUrl).toBe("https://paycheck.toolweather.workers.dev");
    expect(config.paycheckApiKey).toBeNull();
    expect(await lookupPaycheck(fetchImpl, config, "pay.example.com")).toEqual({ verdict: "unknown", error: null });
  });

  it("fails open on a non-OK response, a bad body, or a thrown fetch", async () => {
    const config = readConfig(testEnv());
    const down: typeof fetch = async () => new Response("nope", { status: 503 });
    const junk: typeof fetch = async () => Response.json({ verdict: "maybe" });
    const boom: typeof fetch = async () => {
      throw new Error("paycheck down");
    };
    expect(await lookupPaycheck(down, config, "https://pay.example.com")).toEqual({
      verdict: null,
      error: "http_status:503",
    });
    expect(await lookupPaycheck(junk, config, "https://pay.example.com")).toEqual({ verdict: null, error: "parse" });
    expect(await lookupPaycheck(boom, config, "https://pay.example.com")).toEqual({ verdict: null, error: "network" });
  });

  it("prefers the service binding and does not call the public fetch", async () => {
    let publicCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      publicCalls += 1;
      throw new Error("public fetch");
    };
    let seen: Request | null = null;
    const binding = {
      fetch: async (input: RequestInfo | URL) => {
        seen = input instanceof Request ? input : new Request(input);
        return Response.json({ verdict: "suspicious", score: 40 });
      },
    } as Fetcher;
    const config = readConfig(testEnv({ BUNDLE_PROXY_SECRET: "suite-secret" }));
    const lookup = await lookupPaycheck(fetchImpl, config, "https://qz7k-pay-now-claim.biz", binding);
    expect(lookup).toEqual({ verdict: "suspicious", error: null });
    expect(publicCalls).toBe(0);
    expect(seen).toBeInstanceOf(Request);
    expect(new URL(seen!.url).pathname).toBe("/v1/check");
    expect(await seen!.json()).toEqual({ target: "https://qz7k-pay-now-claim.biz" });
    expect(seen!.headers.get("x-tw-bundle-client")).toBe(SPENDGATE_PAYCHECK_CLIENT);
    expect(seen!.method).toBe("POST");
  });
});
