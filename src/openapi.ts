import type { Config } from "./env.js";
import { CATEGORY_BAND } from "./scoring.js";

export function openApiDocument(origin: string, config: Config) {
  return {
    openapi: "3.1.0",
    info: {
      title: "SpendGate",
      version: "1.0.0",
      description:
        "Score a planned spend before an autonomous agent pays. Verdicts are approve, ask_human, or block. Anonymous and free-key calls are capped per UTC day. Further scores use x402 USDC on Base.",
    },
    servers: [{ url: origin }],
    paths: {
      "/health": {
        get: {
          operationId: "health",
          summary: "Liveness and whether D1 and PAY_TO are configured",
          responses: { "200": { description: "Service is up" } },
        },
      },
      "/v1/policy": {
        get: {
          operationId: "getPolicy",
          summary: "Deterministic v1 scoring policy and live quota settings",
          responses: { "200": { description: "Policy document" } },
        },
      },
      "/v1/score": {
        post: {
          operationId: "scoreSpend",
          summary: "Score one planned spend",
          description:
            "Free while under the daily cap. After the cap, respond to HTTP 402 by paying the x402 requirement and retrying with PAYMENT-SIGNATURE. Validation failures do not consume quota.",
          parameters: [
            {
              name: "Authorization",
              in: "header",
              required: false,
              schema: { type: "string" },
              description: "Bearer sg_live_… free key. Omit for the anonymous cap. Wins over bundle proxy headers.",
            },
            {
              name: "X-Tw-Bundle-Secret",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                "Toolweather suite proxy secret. When it matches BUNDLE_PROXY_SECRET, free quota is charged to X-Tw-Bundle-Client: the free-key daily cap for a hex client, the anonymous daily cap for an anon: client. A missing or wrong value keeps anonymous or API-key behavior.",
            },
            {
              name: "X-Tw-Bundle-Client",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                "Client id for bundle quota. A hex id (16–128 characters; longer values use a stable prefix) uses the free-key daily cap. An anon: id uses the anonymous daily cap. Ignored unless X-Tw-Bundle-Secret matches.",
            },
            {
              name: "PAYMENT-SIGNATURE",
              in: "header",
              required: false,
              schema: { type: "string" },
              description: "Base64-encoded x402 v2 PaymentPayload. Used only after the free cap.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ScoreRequest" },
                example: {
                  amount: 25,
                  currency: "USDC",
                  category: "saas",
                  purpose: "Monthly observability seat",
                  merchant: "https://api.openai.com/v1",
                  agent_id: "agent_ops",
                  daily_budget_remaining: 40,
                  risk_hints: [],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Score produced",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ScoreResponse" },
                },
              },
            },
            "400": { description: "Invalid spend body. Quota is not consumed." },
            "401": { description: "API key was presented but not recognized." },
            "402": {
              description:
                "Free cap exhausted. Body and PAYMENT-REQUIRED header carry x402 v2 payment requirements when PAY_TO is set.",
            },
          },
        },
      },
      "/v1/quota": {
        get: {
          operationId: "getQuota",
          summary: "Remaining free scores for today",
          responses: { "200": { description: "Quota" } },
        },
      },
      "/v1/keys": {
        post: {
          operationId: "createKey",
          summary: "Mint a free API key",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { label: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "201": { description: "Key minted. The secret is returned once." },
            "429": { description: "Daily mint cap reached for this client." },
          },
        },
      },
    },
    components: {
      schemas: {
        ScoreRequest: {
          type: "object",
          required: ["amount"],
          properties: {
            amount: { type: "number", minimum: 0 },
            currency: { type: "string", default: "USDC" },
            category: { type: "string", enum: [...Object.keys(CATEGORY_BAND), "other"] },
            purpose: { type: "string" },
            merchant: { type: "string" },
            endpoint: { type: "string" },
            agent_id: { type: "string" },
            daily_budget_remaining: { type: "number", minimum: 0 },
            monthly_budget_remaining: { type: "number", minimum: 0 },
            risk_hints: { type: "array", items: { type: "string" } },
          },
        },
        ScoreResponse: {
          type: "object",
          required: ["score", "verdict", "reasons", "recommended_action", "checked_at"],
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            verdict: { type: "string", enum: ["approve", "ask_human", "block"] },
            reasons: { type: "array", items: { type: "string" } },
            recommended_action: { type: "string" },
            checked_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
    "x-spendgate": {
      price_usd: config.priceUsd,
      network: config.network,
      asset: config.asset,
      facilitator: config.facilitatorUrl,
      paid_configured: Boolean(config.payTo),
    },
  };
}
