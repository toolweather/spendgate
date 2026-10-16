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
            "Free while under the daily cap. After the cap, respond to HTTP 402 by paying the x402 requirement and retrying with PAYMENT-SIGNATURE. Validation failures do not consume quota. A domain, https URL, or 0x merchant not on the local allowlist is checked with PayCheck as SpendGate's own call. A PayCheck outage keeps the local merchant rules.",
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
                "Free cap exhausted. When PAY_TO is set, the JSON body and the PAYMENT-REQUIRED header carry x402 v2 payment requirements. waitlist_url is a sibling of quota on the JSON body and is not added to the PAYMENT-REQUIRED payload. When PAY_TO is unset, the body is payment_not_configured plus waitlist_url.",
            },
          },
        },
      },
      "/v1/wallet-allowlist": {
        post: {
          operationId: "setWalletAllowlist",
          summary: "Store the wallets an API key may spend from",
          description:
            "Replaces the allowlist for one sg_live_ key in a single write. Does not consume a score. Public developer test accounts are rejected. An empty array authorizes no wallet.",
          parameters: [
            {
              name: "Authorization",
              in: "header",
              required: false,
              schema: { type: "string" },
              description: "Bearer sg_live_… key. Required unless api_key is in the body.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WalletAllowlistRequest" },
              },
            },
          },
          responses: {
            "200": { description: "Allowlist replaced." },
            "400": { description: "allowed_wallets was missing, not addresses, or contained a public dev account." },
            "401": { description: "API key missing or not recognized." },
          },
        },
      },
      "/v1/waitlist": {
        post: {
          operationId: "joinWaitlist",
          summary: "Join the SpendGate Pro waitlist",
          description:
            "Stores one lowercased email. A duplicate email is not inserted again. No email is sent and no charge is made. A hidden hp_field that is non-empty is ignored. At most 10 signups per client per UTC day.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email"],
                  properties: {
                    email: { type: "string", format: "email" },
                    source: { type: "string" },
                    hp_field: { type: "string", description: "Honeypot. Leave empty." },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Email stored." },
            "200": { description: "Already on the list, or a honeypot submission that was not stored." },
            "400": { description: "Email or source was not usable." },
            "429": { description: "This client hit the daily signup cap." },
          },
        },
      },
      "/v1/waitlist/count": {
        get: {
          operationId: "waitlistCount",
          summary: "Public count of waitlist emails",
          description: "Returns { count } and no email addresses.",
          responses: { "200": { description: "Signup count" } },
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
            from_wallet: {
              type: "string",
              description: "0x account that would sign or pay gas. Omit to leave the verdict unchanged.",
            },
            allowed_wallets: {
              type: "array",
              items: { type: "string" },
              description: "Allowlist for this call. Omit to use the stored per-key list.",
            },
          },
        },
        WalletAllowlistRequest: {
          type: "object",
          required: ["allowed_wallets"],
          properties: {
            allowed_wallets: { type: "array", items: { type: "string" } },
            api_key: { type: "string", description: "sg_live_ key. Optional when Authorization is set." },
          },
        },
        ScoreResponse: {
          type: "object",
          required: ["score", "verdict", "reasons", "recommended_action", "checked_at", "payment_source"],
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            verdict: { type: "string", enum: ["approve", "ask_human", "block"] },
            reasons: { type: "array", items: { type: "string" } },
            recommended_action: { type: "string" },
            checked_at: { type: "string", format: "date-time" },
            payment_source: { $ref: "#/components/schemas/PaymentSource" },
          },
        },
        PaymentSource: {
          type: "object",
          required: ["from_wallet", "allowlisted", "checked_at", "reason"],
          properties: {
            from_wallet: { type: ["string", "null"] },
            allowlisted: { type: ["boolean", "null"] },
            checked_at: { type: "string", format: "date-time" },
            reason: {
              type: ["string", "null"],
              enum: ["dev_wallet", "unauthorized_wallet", "wallet_unverified", null],
            },
            signature: {
              type: "string",
              description: "HMAC-SHA256 hex. Present only when BUNDLE_PROXY_SECRET is set.",
            },
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
      paycheck_url: config.paycheckUrl,
    },
  };
}
