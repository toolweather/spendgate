import type { ServiceOutcome } from "./service.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18"] as const;

export const SERVER_INFO = {
  name: "spendgate",
  title: "SpendGate",
  version: "1.0.0",
};

export const INSTRUCTIONS = [
  "Call score_spend before an agent pays, transfers crypto, buys a gift card, or starts a paid subscription.",
  "Do not call it for a pure read, or for a status_check under $1 that you will not pay.",
  "Pass amount in USD. category overrides purpose. endpoint is used only when merchant is omitted.",
  "approve means pay. ask_human means stop and ask a person. block means do not pay.",
  "Do not reword purpose and call again to fish for a higher score. v1 scoring is deterministic, and each call consumes a score.",
  "Prefer get_quota to read the free daily cap. It does not consume a score.",
  "get_api_key mints one free sg_live_ key. The secret is shown once. Keys do not expire and there is no revoke tool. Do not mint again if you already stored a key.",
  "Anonymous callers get 100 scores per UTC day. A stored key gets 1,000. After that cap, score_spend costs 0.001 USDC on Base via x402. get_quota and get_api_key stay free.",
].join(" ");

const stringProp = (description: string) => ({ type: "string", description });
const numberProp = (description: string) => ({ type: "number", description });

/**
 * MCP clients treat a missing hint as the unsafe default (not read-only,
 * destructive, not idempotent, open-world). These tools never contact the
 * merchant: score_spend records a local verdict and may return 402,
 * get_quota only reads, and get_api_key only inserts a key.
 */
const closedWorld = { destructiveHint: false, openWorldHint: false } as const;

export const TOOLS = [
  {
    name: "score_spend",
    title: "Score a planned spend",
    description: [
      "Score one planned payment before it is sent: a crypto transfer, gift card, subscription, or paid API or merchant.",
      "Do not use it for a pure read, or for a status_check under $1 you will not pay; that still burns a free score and approves unless a budget you pass is exceeded.",
      "Each call uses one free score (anonymous 100/UTC day, sg_live_ key 1,000 from get_api_key).",
      "Past that cap the call is HTTP 402 and costs 0.001 USDC on Base via x402.",
      "It does not pay the merchant. While free quota remains, the same arguments consume another score.",
      "category overrides purpose. When category is omitted, purpose is matched as a category name; any other prose is unknown risk.",
      "merchant overrides endpoint when both are set.",
      "A set daily_budget_remaining or monthly_budget_remaining blocks when amount is greater; omitted budgets are skipped.",
      "Returns score 0-100, verdict approve|ask_human|block, reasons, recommended_action, checked_at, detail, and quota (daily_limit, used_today, remaining_today, paid_today, resets_at).",
      "approve means pay; ask_human means stop for a person; block means do not pay.",
      "Read the cap with get_quota instead of spending a score.",
    ].join(" "),
    annotations: {
      title: "Score a planned spend",
      readOnlyHint: false,
      idempotentHint: false,
      ...closedWorld,
    },
    inputSchema: {
      type: "object",
      properties: {
        amount: numberProp("Planned spend in USD, not token atomic units. Required."),
        currency: stringProp("Payment currency. Defaults to USDC."),
        category: stringProp(
          "Risk class. Wins over purpose. One of status_check, api_call, saas, infra, gift_card, crypto_transfer, irreversible. Any other string is unknown risk.",
        ),
        purpose: stringProp(
          "Short note, max 280 characters. When category is omitted, this text is matched as a category name; other prose is unknown risk. When category is set, this is echoed and not scored.",
        ),
        merchant: stringProp("Payee name or https URL. Used instead of endpoint when both are set. A missing payee is penalized."),
        endpoint: stringProp("Payee used only when merchant is omitted. Ignored if merchant is also set."),
        agent_id: stringProp("Agent or key id. Echoed, not scored in v1."),
        api_key: stringProp(
          "Optional sg_live_ key. Uses the 1,000/day bucket. An unrecognized key returns invalid_api_key instead of falling back to anonymous.",
        ),
        daily_budget_remaining: numberProp("USD left today. When set, a greater amount is blocked. Omit to skip this check."),
        monthly_budget_remaining: numberProp(
          "USD left this month. When set, a greater amount is blocked. Omit to skip this check.",
        ),
        risk_hints: {
          type: "array",
          items: { type: "string" },
          description:
            "Self-reported hints. Raising: new_payee, new_merchant, first_payment, high_velocity, mismatched_purpose, off_platform, shared_wallet. Lowering: trusted_repeat, within_policy, human_preapproved. known_merchant marks the payee known.",
        },
      },
      required: ["amount"],
      additionalProperties: false,
    },
  },
  {
    name: "get_quota",
    title: "Read today's free score quota",
    description: [
      "Read today's free-score balance.",
      "Prefer this over score_spend when you are not judging a specific payment, including before a batch or after a 402: it does not consume a score, returns no verdict, and is never billed.",
      "Do not use it to approve or block a spend.",
      "Pass api_key for that sg_live_ key (tier free, 1,000/UTC day); omit it for this client's anonymous bucket (tier anonymous, 100/UTC day).",
      "An unrecognized or non-sg_live_ key returns invalid_api_key and does not fall back.",
      "Returns subject (anonymous|api_key|bundle), key_id, key_prefix, tier (anonymous|free|bundle), daily_limit, used_today, remaining_today, paid_today, price_usd, price_atomic, asset (USDC), network, resets_at (next UTC midnight), and paid_configured.",
      "Mint a higher cap with get_api_key.",
    ].join(" "),
    annotations: {
      title: "Read today's free score quota",
      readOnlyHint: true,
      idempotentHint: true,
      ...closedWorld,
    },
    inputSchema: {
      type: "object",
      properties: {
        api_key: stringProp(
          "Optional sg_live_ key to read. Omit for the anonymous bucket. Does not mint a key. An unrecognized key returns invalid_api_key.",
        ),
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_api_key",
    title: "Mint a free API key",
    description: [
      "Mint one free sg_live_ key so later score_spend and get_quota calls use 1,000 scores per UTC day instead of the anonymous 100.",
      "Call once per agent when you will score often and have no stored key.",
      "Do not call every turn, do not mint again if you already stored the secret, and do not call just to read remaining scores (use get_quota).",
      "Returns the secret once as api_key, plus key_id, key_prefix, label, tier free, daily_limit, created_at, and note.",
      "Only a hash is stored, so the secret cannot be shown again.",
      "Keys do not expire and there is no revoke tool; a lost key stays valid, and an unknown or non-sg_live_ value later returns invalid_api_key.",
      "At most 20 mints per client per UTC day, then key_mint_limit and no new key.",
      "Minting is free and does not consume a score.",
      "Send the secret later as Authorization: Bearer or as api_key.",
      "label is an optional stored name and does not set a cap, a scope, or an expiry.",
    ].join(" "),
    annotations: {
      title: "Mint a free API key",
      readOnlyHint: false,
      idempotentHint: false,
      ...closedWorld,
    },
    inputSchema: {
      type: "object",
      properties: {
        label: stringProp(
          "Optional name stored with the key, up to 80 characters. Does not set a cap or an expiry. Keys do not expire.",
        ),
      },
      additionalProperties: false,
    },
  },
] as const;

export function serverCard(origin: string) {
  return {
    serverInfo: SERVER_INFO,
    description:
      "SpendGate scores a planned spend before an autonomous agent pays. Verdicts are approve, ask_human, or block.",
    documentationUrl: `${origin}/llms.txt`,
    transport: {
      type: "streamable-http",
      endpoint: "/mcp",
    },
    capabilities: {
      tools: { listChanged: false },
    },
    authentication: {
      required: false,
      schemes: ["bearer", "x402"],
    },
    instructions: INSTRUCTIONS,
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
    })),
  };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

export interface McpHttpResult {
  status: number;
  body: unknown | null;
  headers: Record<string, string>;
}

function toolText(outcome: ServiceOutcome): McpHttpResult {
  if (outcome.status === 402) {
    return {
      status: 402,
      headers: outcome.headers,
      body: rpcError(null, -32002, "Payment required", outcome.body),
    };
  }
  if (outcome.status >= 500) {
    return {
      status: outcome.status,
      headers: outcome.headers,
      body: rpcError(null, -32603, "SpendGate failed", outcome.body),
    };
  }
  const isError = outcome.status >= 400;
  return {
    status: 200,
    headers: outcome.headers,
    body: rpcResult(null, {
      content: [{ type: "text", text: JSON.stringify(outcome.body) }],
      isError,
    }),
  };
}

export function handleMcpMessage(
  message: JsonRpcRequest,
  handlers: {
    score: (args: Record<string, unknown>) => Promise<ServiceOutcome>;
    quota: (args: Record<string, unknown>) => Promise<ServiceOutcome>;
    mint: (args: Record<string, unknown>) => Promise<ServiceOutcome>;
    protocolVersion: string;
  },
): Promise<McpHttpResult> | McpHttpResult {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { status: 400, headers: {}, body: rpcError(message.id ?? null, -32600, "Invalid Request") };
  }
  const id = message.id ?? null;
  const method = message.method;

  if (method.startsWith("notifications/")) {
    return { status: 202, headers: {}, body: null };
  }

  if (method === "initialize") {
    // Match Upstream: accept any client protocolVersion and echo it (or fall back).
    // Strict rejection breaks directory validators that probe older/newer drafts.
    const params = (message.params ?? {}) as { protocolVersion?: string };
    const version = params.protocolVersion || handlers.protocolVersion || "2025-06-18";
    return {
      status: 200,
      headers: { "mcp-protocol-version": version },
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_INFO.name,
          title: SERVER_INFO.title,
          version: SERVER_INFO.version,
          description:
            "Score a planned spend before an agent pays. Verdicts: approve, ask_human, or block.",
        },
        instructions: INSTRUCTIONS,
      }),
    };
  }

  if (method === "ping") {
    return { status: 200, headers: {}, body: rpcResult(id, {}) };
  }

  if (method === "tools/list") {
    return { status: 200, headers: {}, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === "tools/call") {
    const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (!params.name) {
      return { status: 200, headers: {}, body: rpcError(id, -32602, "tools/call requires a name.") };
    }
    const args = params.arguments ?? {};
    const run =
      params.name === "score_spend"
        ? handlers.score
        : params.name === "get_quota"
          ? handlers.quota
          : params.name === "get_api_key"
            ? handlers.mint
            : null;
    if (!run) {
      return { status: 200, headers: {}, body: rpcError(id, -32602, `Unknown tool: ${params.name}`) };
    }
    return run(args).then((outcome) => {
      const wrapped = toolText(outcome);
      if (wrapped.body && typeof wrapped.body === "object" && wrapped.body !== null && "id" in wrapped.body) {
        (wrapped.body as { id: string | number | null }).id = id;
      }
      return wrapped;
    });
  }

  return { status: 200, headers: {}, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

export function negotiateProtocol(header: string | null): { ok: true; version: string } | { ok: false; message: string } {
  // Prefer a known version when the client sends one; otherwise keep going with a default.
  // Unknown draft versions are accepted so marketplace validators can connect.
  if (!header) return { ok: true, version: "2025-06-18" };
  return { ok: true, version: header };
}
