import type { ServiceOutcome } from "./service.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18"] as const;

export const SERVER_INFO = {
  name: "spendgate",
  title: "SpendGate",
  version: "1.0.0",
};

export const INSTRUCTIONS = [
  "Call score_spend before an agent pays, transfers crypto, buys a gift card, or starts a paid subscription.",
  "Pass the amount in USD, the category, the merchant or endpoint, and any daily or monthly budget still remaining.",
  "approve means pay. ask_human means stop and ask a person. block means do not pay.",
  "Do not reword the purpose and call again to fish for a higher score. v1 scoring is deterministic.",
  "get_quota reads the free daily cap. get_api_key mints a free key once; store the secret.",
  "After the free cap, score_spend requires an x402 USDC payment on Base. get_quota and get_api_key stay free.",
].join(" ");

const stringProp = (description: string) => ({ type: "string", description });
const numberProp = (description: string) => ({ type: "number", description });

export const TOOLS = [
  {
    name: "score_spend",
    description:
      "Score a planned payment before sending it. Call this before any tool that transfers crypto, buys a gift card, starts a subscription, or pays an API or merchant. Pass amount in USD, category, merchant or endpoint URL, and any budget remaining. Returns score 0-100, verdict approve | ask_human | block, reasons, and recommended_action.",
    inputSchema: {
      type: "object",
      properties: {
        amount: numberProp("Planned spend in USD, not in token atomic units."),
        currency: stringProp("Payment currency. Defaults to USDC."),
        category: stringProp(
          "One of status_check, api_call, saas, infra, gift_card, crypto_transfer, irreversible. Unknown categories are scored as unknown risk.",
        ),
        purpose: stringProp("Short human description. Used as the category when category is omitted."),
        merchant: stringProp("Merchant name or https endpoint URL that will receive the spend."),
        endpoint: stringProp("Alias of merchant when the payee is an API URL."),
        agent_id: stringProp("Your agent or key id. Echoed, not scored in v1."),
        api_key: stringProp("Optional SpendGate key (sg_live_…). Anonymous callers share a smaller daily cap."),
        daily_budget_remaining: numberProp("USD still available today. Amount above this is blocked."),
        monthly_budget_remaining: numberProp("USD still available this month. Amount above this is blocked."),
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
    description:
      "Read how many free SpendGate scores remain today for this anonymous caller or API key. Does not consume a score and is not billed.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: stringProp("Optional sg_live_ key. Omit to read the anonymous quota for this client."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_api_key",
    description:
      "Mint a free SpendGate API key. The secret is returned once. Store it and send it as Authorization: Bearer, or as api_key on later score_spend calls. Do not call this on every turn.",
    inputSchema: {
      type: "object",
      properties: {
        label: stringProp("Optional label stored with the key, up to 80 characters."),
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
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
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
    const params = (message.params ?? {}) as { protocolVersion?: string };
    const requested = params.protocolVersion;
    const version = MCP_PROTOCOL_VERSIONS.includes(requested as (typeof MCP_PROTOCOL_VERSIONS)[number])
      ? requested!
      : handlers.protocolVersion;
    if (requested && !MCP_PROTOCOL_VERSIONS.includes(requested as (typeof MCP_PROTOCOL_VERSIONS)[number])) {
      return {
        status: 400,
        headers: {},
        body: rpcError(id, -32602, `Unsupported protocol version. Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}.`),
      };
    }
    return {
      status: 200,
      headers: { "mcp-protocol-version": version },
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
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
  if (!header) return { ok: true, version: "2025-03-26" };
  if (!MCP_PROTOCOL_VERSIONS.includes(header as (typeof MCP_PROTOCOL_VERSIONS)[number])) {
    return { ok: false, message: `Unsupported MCP-Protocol-Version. Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}.` };
  }
  return { ok: true, version: header };
}
