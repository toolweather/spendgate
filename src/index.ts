import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env.js";
import { readConfig } from "./env.js";
import { llmsFull, llmsTxt } from "./llms.js";
import { handleMcpMessage, negotiateProtocol, serverCard } from "./mcp.js";
import { openApiDocument } from "./openapi.js";
import { policyDocument } from "./scoring.js";
import { mintKey, readQuota, scoreRequest, type ServiceOutcome } from "./service.js";
import { D1UsageStore, type UsageStore } from "./store.js";
import { paymentRequirements } from "./x402.js";

export interface AppOptions {
  store?: UsageStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  ids?: () => string;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 16_384) return { ok: false, message: "Request body is limited to 16 KB." };
  const text = await request.text();
  if (text.length > 16_384) return { ok: false, message: "Request body is limited to 16 KB." };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: "Body must be JSON." };
  }
}

function send(c: { json: (body: unknown, status?: number, headers?: Record<string, string>) => Response }, outcome: ServiceOutcome): Response {
  if (outcome.body === null) return new Response(null, { status: outcome.status, headers: outcome.headers });
  return c.json(outcome.body, outcome.status, outcome.headers);
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Accept",
        "PAYMENT-SIGNATURE",
        "X-PAYMENT",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
        "Idempotency-Key",
      ],
      exposeHeaders: [
        "PAYMENT-REQUIRED",
        "PAYMENT-RESPONSE",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
        "X-SpendGate-Quota-Limit",
        "X-SpendGate-Quota-Remaining",
        "X-SpendGate-Quota-Reset",
      ],
    }),
  );

  function storeFor(env: Env): UsageStore | null {
    if (options.store) return options.store;
    if (env.DB) return new D1UsageStore(env.DB);
    return null;
  }

  function unavailable(): ServiceOutcome {
    return {
      status: 503,
      headers: { "cache-control": "no-store" },
      body: {
        error: {
          code: "database_unavailable",
          message: "D1 is not ready. Apply migrations with wrangler d1 migrations apply spendgate --local.",
        },
      },
    };
  }

  app.get("/health", async (c) => {
    const config = readConfig(c.env);
    let db: "ok" | "missing" | "error" = c.env.DB ? "error" : "missing";
    if (options.store) db = "ok";
    else if (c.env.DB) {
      try {
        await c.env.DB.prepare("SELECT 1 AS ok").first();
        db = "ok";
      } catch {
        db = "error";
      }
    }
    return c.json({
      ok: true,
      service: "spendgate",
      db,
      paid_configured: Boolean(config.payTo),
    });
  });

  app.get("/v1/policy", (c) => {
    const config = readConfig(c.env);
    return c.json({
      ...policyDocument(config.microThresholdUsd),
      anonymous_daily_limit: config.anonDailyLimit,
      free_key_daily_limit: config.keyDailyLimit,
      keys_per_day: config.keysPerDay,
      price_usd: config.priceUsd,
      price_atomic: config.priceAtomic,
      asset: config.asset,
      asset_name: config.assetName,
      network: config.network,
      facilitator: config.facilitatorUrl,
      paid_configured: Boolean(config.payTo),
    });
  });

  app.get("/openapi.json", (c) => {
    const origin = originOf(c.req.url);
    return c.json(openApiDocument(origin, readConfig(c.env)));
  });

  app.get("/llms.txt", (c) => {
    const config = readConfig(c.env);
    return c.text(llmsTxt(originOf(c.req.url), config), 200, { "content-type": "text/plain; charset=utf-8" });
  });

  app.get("/llms-full.txt", (c) => {
    const config = readConfig(c.env);
    return c.text(llmsFull(originOf(c.req.url), config), 200, { "content-type": "text/plain; charset=utf-8" });
  });

  app.get("/.well-known/mcp", (c) => c.json(serverCard(originOf(c.req.url))));
  app.get("/.well-known/mcp.json", (c) => c.json(serverCard(originOf(c.req.url))));

  app.get("/.well-known/x402", (c) => {
    const config = readConfig(c.env);
    const origin = originOf(c.req.url);
    const accepts = config.payTo ? [paymentRequirements(config)] : [];
    return c.json({
      x402Version: 2,
      facilitator: config.facilitatorUrl,
      configured: Boolean(config.payTo),
      payTo: config.payTo,
      resources: [
        {
          resource: `${origin}/v1/score`,
          type: "http",
          method: "POST",
          x402Version: 2,
          description: "One spend score after the free daily cap",
          accepts,
          lastUpdated: "2026-10-15T00:00:00.000Z",
        },
      ],
    });
  });

  app.get("/v1/quota", async (c) => {
    const store = storeFor(c.env);
    if (!store) return send(c, unavailable());
    const outcome = await readQuota({
      store,
      config: readConfig(c.env),
      authorization: c.req.header("authorization") ?? null,
      ip: clientIp(c.req.raw),
      now: options.now?.() ?? new Date(),
    });
    return send(c, outcome);
  });

  app.post("/v1/keys", async (c) => {
    const store = storeFor(c.env);
    if (!store) return send(c, unavailable());
    const body = await readBody(c.req.raw);
    if (!body.ok) {
      return c.json({ error: { code: "invalid_json", message: body.message } }, 400);
    }
    const record = body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : {};
    let label: string | null = null;
    if (record.label !== undefined) {
      if (typeof record.label !== "string") {
        return c.json({ error: { code: "invalid_label", message: "label must be a string." } }, 400);
      }
      label = record.label.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || null;
    }
    const outcome = await mintKey({
      store,
      config: readConfig(c.env),
      ip: clientIp(c.req.raw),
      now: options.now?.() ?? new Date(),
      label,
      ids: options.ids,
    });
    return send(c, outcome);
  });

  app.post("/v1/score", async (c) => {
    const store = storeFor(c.env);
    if (!store) return send(c, unavailable());
    const body = await readBody(c.req.raw);
    if (!body.ok) {
      return c.json({ error: { code: "invalid_json", message: body.message } }, 400);
    }
    const outcome = await scoreRequest({
      store,
      config: readConfig(c.env),
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now?.() ?? new Date(),
      ip: clientIp(c.req.raw),
      authorization: c.req.header("authorization") ?? null,
      body: body.value,
      resourceUrl: `${originOf(c.req.url)}/v1/score`,
      paymentHeader: c.req.header("payment-signature") ?? c.req.header("x-payment") ?? null,
      idempotencyKey: c.req.header("idempotency-key") ?? null,
      ids: options.ids,
    });
    return send(c, outcome);
  });

  app.get("/mcp", (c) =>
    c.json(
      { error: { code: "method_not_allowed", message: "SpendGate MCP uses POST /mcp. This server does not stream server-initiated messages." } },
      405,
      { allow: "POST, DELETE" },
    ),
  );

  app.delete("/mcp", () => new Response(null, { status: 204 }));

  app.post("/mcp", async (c) => {
    const protocol = negotiateProtocol(c.req.header("mcp-protocol-version") ?? null);
    if (!protocol.ok) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32602, message: protocol.message } }, 400);
    }
    const store = storeFor(c.env);
    const body = await readBody(c.req.raw);
    if (!body.ok) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: body.message } }, 400);
    }
    const message = body.value;
    if (Array.isArray(message)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC batches are not supported." } }, 400);
    }
    if (!message || typeof message !== "object") {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
    }

    const config = readConfig(c.env);
    const now = options.now?.() ?? new Date();
    const ip = clientIp(c.req.raw);
    const authorization = c.req.header("authorization") ?? null;
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment") ?? null;
    const idempotencyKey = c.req.header("idempotency-key") ?? null;
    const resourceUrl = `${originOf(c.req.url)}/v1/score`;

    const requireStore = (): UsageStore | ServiceOutcome => store ?? unavailable();

    const result = await handleMcpMessage(message as { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }, {
      protocolVersion: protocol.version,
      score: async (args) => {
        const ready = requireStore();
        if (!("getUsage" in ready)) return ready;
        return scoreRequest({
          store: ready,
          config,
          fetchImpl: options.fetchImpl ?? fetch,
          now,
          ip,
          authorization,
          apiKeyArgument: typeof args.api_key === "string" ? args.api_key : null,
          body: args,
          resourceUrl,
          paymentHeader,
          idempotencyKey,
          ids: options.ids,
        });
      },
      quota: async (args) => {
        const ready = requireStore();
        if (!("getUsage" in ready)) return ready;
        return readQuota({
          store: ready,
          config,
          authorization,
          apiKeyArgument: typeof args.api_key === "string" ? args.api_key : null,
          ip,
          now,
        });
      },
      mint: async (args) => {
        const ready = requireStore();
        if (!("getUsage" in ready)) return ready;
        const label = typeof args.label === "string" ? args.label.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || null : null;
        return mintKey({ store: ready, config, ip, now, label, ids: options.ids });
      },
    });

    const headers = new Headers(result.headers);
    headers.set("cache-control", "no-store");
    if (!headers.has("mcp-protocol-version")) headers.set("mcp-protocol-version", protocol.version);
    if (result.body === null) return new Response(null, { status: result.status, headers });
    return c.json(result.body, result.status as 200 | 400 | 402 | 500 | 503, Object.fromEntries(headers.entries()));
  });

  app.all("*", async (c) => {
    if (!c.env.ASSETS || c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: { code: "not_found", message: "No such SpendGate route." } }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}

export default createApp();
