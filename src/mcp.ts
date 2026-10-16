import type { ServiceOutcome } from "./service.js";
import { waitlistPitch } from "./waitlist.js";

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
  "Anonymous callers get 100 scores per UTC day. A stored key gets 1,000. After that cap, score_spend costs 0.001 USDC on Base via x402. get_quota, get_api_key, and set_wallet_allowlist stay free.",
  "Pass from_wallet when the spend leaves a wallet. A published developer test account is block (dev_wallet). A wallet that is not allowlisted is block (unauthorized_wallet). A wallet with no allowlist is ask_human (wallet_unverified). Store the per-key list with set_wallet_allowlist. Do not derive keys from public recovery phrases, and do not spend from a wallet the task did not give you.",
].join(" ");

const stringProp = (description: string) => ({ type: "string", description });
const numberProp = (description: string) => ({ type: "number", description });

/**
 * MCP clients treat a missing hint as the unsafe default (not read-only,
 * destructive, not idempotent, open-world). These tools never contact the
 * merchant. score_spend may ask PayCheck (a fixed trust service) about a
 * domain, https URL, or 0x payee, may return 402, get_quota only reads,
 * get_api_key only inserts a key, and set_wallet_allowlist replaces one
 * allowlist row for that key. PayCheck outages stay on local rules.
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
      "It does not pay the merchant. A domain, https URL, or 0x payee that is not on the local known-host list is checked with PayCheck. Trusted counts as a known merchant. Block means do not pay, including under the micro threshold. If PayCheck is unreachable, local merchant rules are used and the score still returns. While free quota remains, the same arguments consume another score.",
      "category overrides purpose. When category is omitted, purpose is matched as a category name; any other prose is unknown risk.",
      "merchant overrides endpoint when both are set.",
      "A set daily_budget_remaining or monthly_budget_remaining blocks when amount is greater; omitted budgets are skipped.",
      "Pass from_wallet, the 0x account that would sign or pay gas, whenever the spend leaves a wallet. Omit from_wallet and the verdict is unchanged.",
      "Pass allowed_wallets to allowlist this call, or omit it to use the list stored for the sg_live_ key by set_wallet_allowlist. An empty allowed_wallets array authorizes no wallet. Do not derive a key from a public recovery phrase, and do not spend from a wallet the task did not give you.",
      "A published Hardhat, Anvil, Ganache, BIP-39 test, or other public dev-mnemonic account is block with reason dev_wallet, including under $1, even if that address is allowlisted.",
      "A from_wallet that is not on the effective allowlist is block with reason unauthorized_wallet.",
      "A from_wallet with no allowlist on the call and none stored for the key is ask_human with reason wallet_unverified. Stop and ask a person. Do not broadcast.",
      "Returns score 0-100, verdict approve|ask_human|block, reasons, recommended_action, checked_at, payment_source (from_wallet, allowlisted, checked_at, reason, and signature only when the server already has BUNDLE_PROXY_SECRET), detail, and quota (daily_limit, used_today, remaining_today, paid_today, resets_at).",
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
        from_wallet: stringProp(
          "0x account that would sign or pay gas. Omit to score as before, with no wallet verdict. A published Hardhat, Anvil, Ganache, or other public dev-mnemonic account is block, reason dev_wallet.",
        ),
        allowed_wallets: {
          type: "array",
          items: { type: "string" },
          description:
            "0x addresses allowed to spend on this call. When set, including an empty array, this list is used instead of the stored per-key allowlist. Omit to use the list from set_wallet_allowlist.",
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
  {
    name: "set_wallet_allowlist",
    title: "Store wallets this key may spend from",
    description: [
      "Store the 0x wallets this sg_live_ key is allowed to spend from.",
      "Call it when an operator names those wallets, once, not on every spend, and not to approve a payment.",
      "score_spend still has to run before any transfer. A block or ask_human from score_spend means do not broadcast.",
      "Pass allowed_wallets. This replaces the stored list for that key in one write.",
      "An empty array stores an allowlist that authorizes no wallet, so a later score with from_wallet and no call-level list returns block, reason unauthorized_wallet.",
      "allowed_wallets is required. At most 32 addresses.",
      "A published developer test account (Hardhat/Anvil default accounts, Ganache, BIP-39 test, and other public test mnemonics) is rejected with dev_wallet and is not stored.",
      "Requires api_key, or Authorization: Bearer sg_live_. Anonymous and bundle callers cannot store a list; they can pass allowed_wallets on score_spend instead.",
      "An unrecognized key returns invalid_api_key. A missing key returns api_key_required.",
      "Does not consume a score and is never billed.",
      "Returns key_id, key_prefix, allowed_wallets, and updated_at.",
      "A new key starts with no list, which makes a later from_wallet ask_human with reason wallet_unverified until you set one.",
      "Do not put a private key or a recovery phrase in this tool. Addresses only.",
    ].join(" "),
    annotations: {
      title: "Store wallets this key may spend from",
      readOnlyHint: false,
      idempotentHint: true,
      ...closedWorld,
    },
    inputSchema: {
      type: "object",
      properties: {
        allowed_wallets: {
          type: "array",
          items: { type: "string" },
          description:
            "0x addresses this key may spend from. Replaces the stored list. An empty array authorizes none. Public developer test accounts are rejected and not stored.",
        },
        api_key: stringProp(
          "sg_live_ key this list belongs to. You can also send Authorization: Bearer. Required. Anonymous callers cannot store a list.",
        ),
      },
      required: ["allowed_wallets"],
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

function paymentRequiredMessage(body: unknown): string {
  if (body && typeof body === "object" && "waitlist_url" in body) {
    const url = (body as { waitlist_url: unknown }).waitlist_url;
    if (typeof url === "string" && url) return `Payment required. ${waitlistPitch(url)}`;
  }
  return "Payment required";
}

function toolText(outcome: ServiceOutcome): McpHttpResult {
  if (outcome.status === 402) {
    return {
      status: 402,
      headers: outcome.headers,
      body: rpcError(null, -32002, paymentRequiredMessage(outcome.body), outcome.body),
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
    allowlist: (args: Record<string, unknown>) => Promise<ServiceOutcome>;
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
            : params.name === "set_wallet_allowlist"
              ? handlers.allowlist
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
