import { DEFAULT_PAYCHECK_URL, PAYCHECK_TIMEOUT_MS, SPENDGATE_PAYCHECK_CLIENT } from "./env.js";

/**
 * SpendGate scoring policy v1.
 *
 * Deterministic given the same PayCheck verdict (or a miss). Start at 100 and subtract
 * penalties. Thresholds, then hard overrides:
 *
 * 1. If amount is greater than a supplied daily or monthly budget remaining, verdict is block
 *    and the published score is at most 24.
 * 2. Else if PayCheck returned block, verdict is block and the published score is at most 24.
 * 3. Else if amount is strictly under the free micro threshold (default $1), verdict is approve
 *    and the published score is at least 80.
 *
 * Otherwise:
 *   score >= 70 approve
 *   score >= 40 ask_human
 *   score <  40 block
 *
 * Amount penalty: min(75, round(25 * log10(1 + amount_usd))). Higher spend lowers the score.
 * Merchant: known 0, unknown 18, missing 24. Insecure URL (not https, IP, or local) adds 12.
 * PayCheck trusted counts as known. suspicious is 30. block is 42. Both still add the
 * insecure extra. unknown and a failed lookup keep this local classification.
 * Category: low 0, medium 12, high 30, unknown 18.
 *   high: crypto_transfer, irreversible, gift_card
 *   medium: api_call, saas, infra
 *   low: status_check
 * Currency: USD and USDC 0, other stables (USDT, DAI, USDP, PYUSD) 6, anything else 12.
 * Risk hints are self-reported. Each raising hint adds 6, capped at 18.
 * Each lowering hint subtracts 6, capped at 12. known_merchant marks the merchant known.
 */

export const POLICY_VERSION = "1";
export const APPROVE_MIN_SCORE = 70;
export const ASK_HUMAN_MIN_SCORE = 40;
export const BUDGET_SCORE_CAP = 24;
export const MICRO_SCORE_FLOOR = 80;

export const CATEGORY_BAND = {
  crypto_transfer: "high",
  irreversible: "high",
  gift_card: "high",
  api_call: "medium",
  saas: "medium",
  infra: "medium",
  status_check: "low",
} as const;

export type CategoryName = keyof typeof CATEGORY_BAND;
export type CategoryBand = "low" | "medium" | "high" | "unknown";
export type Verdict = "approve" | "ask_human" | "block";
export type MerchantStatus = "known" | "unknown" | "missing";
export type PaycheckVerdict = "trusted" | "unknown" | "suspicious" | "block";

export const MERCHANT_PENALTY = {
  known: 0,
  unknown: 18,
  missing: 24,
  insecure_extra: 12,
  paycheck_suspicious: 30,
  paycheck_block: 42,
} as const;

const BAND_PENALTY: Record<CategoryBand, number> = {
  low: 0,
  medium: 12,
  high: 30,
  unknown: 18,
};

const USD_LIKE = new Set(["USD", "USDC"]);
const OTHER_STABLE = new Set(["USDT", "DAI", "USDP", "PYUSD"]);

const HINTS_UP = new Set([
  "new_payee",
  "new_merchant",
  "first_payment",
  "high_velocity",
  "mismatched_purpose",
  "off_platform",
  "shared_wallet",
]);

const HINTS_DOWN = new Set(["trusted_repeat", "within_policy", "human_preapproved"]);

/** Hosts treated as known merchants in v1. Subdomains count. */
export const KNOWN_HOST_SUFFIXES = [
  "openai.com",
  "anthropic.com",
  "cloudflare.com",
  "amazon.com",
  "amazonaws.com",
  "google.com",
  "github.com",
  "microsoft.com",
  "azure.com",
  "stripe.com",
  "vercel.com",
  "netlify.com",
  "digitalocean.com",
  "hetzner.com",
  "fly.io",
  "railway.app",
  "supabase.com",
  "npmjs.com",
  "docker.com",
  "datadoghq.com",
  "sentry.io",
];

const KNOWN_NAMES = new Set([
  "openai",
  "anthropic",
  "cloudflare",
  "aws",
  "amazon web services",
  "google",
  "google cloud",
  "github",
  "microsoft",
  "azure",
  "stripe",
  "vercel",
  "netlify",
  "digitalocean",
  "hetzner",
  "supabase",
]);

export interface NormalizedSpend {
  amount: number;
  currency: string;
  category: string | null;
  purpose: string | null;
  merchant: string | null;
  agentId: string | null;
  dailyBudgetRemaining: number | null;
  monthlyBudgetRemaining: number | null;
  riskHints: string[];
}

export interface ScoreResult {
  score: number;
  verdict: Verdict;
  reasons: string[];
  recommended_action: string;
  checked_at: string;
  check_id: string;
  policy_version: typeof POLICY_VERSION;
  raw_score: number;
  category: string;
  category_band: CategoryBand;
  merchant_status: MerchantStatus;
  /** Live PayCheck verdict, or null when the allowlist skipped it or the lookup failed. */
  paycheck_verdict: PaycheckVerdict | null;
  budget_blocked: boolean;
  micro_approved: boolean;
  amount: number;
  currency: string;
  agent_id: string | null;
  merchant: string | null;
  purpose: string | null;
  penalties: {
    amount: number;
    merchant: number;
    category: number;
    currency: number;
    hints_up: number;
    hints_down: number;
  };
}

export function amountPenalty(amount: number): number {
  if (amount <= 0) return 0;
  return Math.min(75, Math.round(25 * Math.log10(1 + amount)));
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function resolveCategory(category: string | null, purpose: string | null): {
  category: string;
  band: CategoryBand;
} {
  const raw = category?.trim() || purpose?.trim() || "";
  if (!raw) return { category: "unspecified", band: "unknown" };
  const key = slug(raw);
  if (key in CATEGORY_BAND) {
    return { category: key, band: CATEGORY_BAND[key as CategoryName] };
  }
  return { category: key.slice(0, 64), band: "unknown" };
}

export function isIpHost(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

/** A DNS hostname with a dot. Raw IPs, localhost, and single labels are not domains. */
export function isDomainHost(host: string): boolean {
  const h = host.replace(/\.$/, "").toLowerCase();
  if (!h || h.length > 253 || !h.includes(".") || isIpHost(h)) return false;
  const labels = h.split(".");
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function hostOnAllowlist(host: string): boolean {
  const h = host.replace(/\.$/, "").toLowerCase();
  return KNOWN_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

export function classifyMerchant(
  merchant: string | null,
  hints: readonly string[],
): { status: MerchantStatus; insecure: boolean; penalty: number; label: string } {
  const hintKnown = hints.includes("known_merchant");
  const value = merchant?.trim() ?? "";
  if (!value) {
    if (hintKnown) {
      return { status: "known", insecure: false, penalty: MERCHANT_PENALTY.known, label: "caller-marked known merchant" };
    }
    return { status: "missing", insecure: false, penalty: MERCHANT_PENALTY.missing, label: "no merchant" };
  }

  let known = hintKnown || KNOWN_NAMES.has(value.toLowerCase());
  let insecure = false;
  let label = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      label = host || value;
      known = known || hostOnAllowlist(host);
      insecure =
        url.protocol !== "https:" ||
        isIpHost(host) ||
        host === "localhost" ||
        host.endsWith(".local");
    } catch {
      known = hintKnown;
    }
  } else if (isDomainHost(value)) {
    label = value.replace(/\.$/, "").toLowerCase();
    known = known || hostOnAllowlist(label);
  }

  const penalty =
    (known ? MERCHANT_PENALTY.known : MERCHANT_PENALTY.unknown) +
    (insecure ? MERCHANT_PENALTY.insecure_extra : 0);
  return { status: known ? "known" : "unknown", insecure, penalty, label };
}

export interface MerchantAssessment {
  status: MerchantStatus;
  insecure: boolean;
  penalty: number;
  label: string;
  paycheck: PaycheckVerdict | null;
}

/**
 * Local classification, then a live PayCheck verdict when one was returned.
 * `null` and `unknown` keep today's rules. Negative verdicts beat a caller
 * `known_merchant` hint. `trusted` is the allowlist effect, plus any insecure extra.
 */
export function assessMerchant(
  merchant: string | null,
  hints: readonly string[],
  paycheck: PaycheckVerdict | null,
): MerchantAssessment {
  const local = classifyMerchant(merchant, hints);
  if (paycheck === null || paycheck === "unknown") {
    return { ...local, paycheck };
  }
  if (paycheck === "trusted") {
    return {
      status: "known",
      insecure: local.insecure,
      penalty: local.insecure ? MERCHANT_PENALTY.insecure_extra : MERCHANT_PENALTY.known,
      label: local.label,
      paycheck,
    };
  }
  const base = paycheck === "block" ? MERCHANT_PENALTY.paycheck_block : MERCHANT_PENALTY.paycheck_suspicious;
  return {
    status: local.status === "missing" ? "missing" : "unknown",
    insecure: local.insecure,
    penalty: base + (local.insecure ? MERCHANT_PENALTY.insecure_extra : 0),
    label: local.label,
    paycheck,
  };
}

function currencyPenalty(currency: string): number {
  if (USD_LIKE.has(currency)) return 0;
  if (OTHER_STABLE.has(currency)) return 6;
  return 12;
}

function money(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function verdictFor(score: number): Verdict {
  if (score >= APPROVE_MIN_SCORE) return "approve";
  if (score >= ASK_HUMAN_MIN_SCORE) return "ask_human";
  return "block";
}

function actionFor(
  verdict: Verdict,
  budgetBlocked: boolean,
  paycheckBlocked: boolean,
  microApproved: boolean,
): string {
  if (budgetBlocked) {
    return "Do not pay. Lower the amount or wait until the remaining budget can cover it.";
  }
  if (paycheckBlocked) return "Do not pay. PayCheck blocked this payee.";
  if (microApproved) return "Pay. This amount is under the free micro threshold.";
  if (verdict === "approve") return "Pay. The planned spend fits the v1 policy.";
  if (verdict === "ask_human") return "Do not pay yet. Ask a human to confirm this spend.";
  return "Do not pay. The planned spend fails the v1 policy.";
}

export function scoreSpend(
  input: NormalizedSpend,
  clock: { now: Date; checkId: string; microThresholdUsd: number },
  paycheck: PaycheckVerdict | null = null,
): ScoreResult {
  const category = resolveCategory(input.category, input.purpose);
  const merchant = assessMerchant(input.merchant, input.riskHints, paycheck);
  const amount = amountPenalty(input.amount);
  const categoryPenalty = BAND_PENALTY[category.band];
  const currency = currencyPenalty(input.currency);

  const upHits = input.riskHints.filter((hint) => HINTS_UP.has(hint));
  const downHits = input.riskHints.filter((hint) => HINTS_DOWN.has(hint));
  const hintsUp = Math.min(18, upHits.length * 6);
  const hintsDown = Math.min(12, downHits.length * 6);

  const raw = Math.max(
    0,
    Math.min(100, 100 - amount - merchant.penalty - categoryPenalty - currency - hintsUp + hintsDown),
  );

  const overDaily =
    input.dailyBudgetRemaining !== null && input.amount > input.dailyBudgetRemaining;
  const overMonthly =
    input.monthlyBudgetRemaining !== null && input.amount > input.monthlyBudgetRemaining;
  const budgetBlocked = overDaily || overMonthly;
  const paycheckBlocked = merchant.paycheck === "block";
  const microApproved = !budgetBlocked && !paycheckBlocked && input.amount < clock.microThresholdUsd;

  let score = raw;
  let verdict = verdictFor(raw);
  if (budgetBlocked) {
    score = Math.min(raw, BUDGET_SCORE_CAP);
    verdict = "block";
  } else if (paycheckBlocked) {
    score = Math.min(raw, BUDGET_SCORE_CAP);
    verdict = "block";
  } else if (microApproved) {
    score = Math.max(raw, MICRO_SCORE_FLOOR);
    verdict = "approve";
  }

  const reasons: string[] = [];
  if (overDaily) {
    reasons.push(
      `Amount ${money(input.amount)} is over the remaining daily budget of ${money(input.dailyBudgetRemaining ?? 0)}.`,
    );
  }
  if (overMonthly) {
    reasons.push(
      `Amount ${money(input.amount)} is over the remaining monthly budget of ${money(input.monthlyBudgetRemaining ?? 0)}.`,
    );
  }
  if (microApproved) {
    reasons.push(
      `Amount ${money(input.amount)} is under the ${money(clock.microThresholdUsd)} free micro threshold.`,
    );
  } else if (!budgetBlocked) {
    reasons.push(`Spend of ${money(input.amount)} lowers the score by ${amount}.`);
  }

  if (merchant.paycheck === "block") {
    reasons.push(`PayCheck blocks ${merchant.label}. Do not pay this payee.`);
  } else if (merchant.paycheck === "suspicious") {
    reasons.push(`PayCheck marks ${merchant.label} suspicious.`);
  } else if (merchant.status === "missing") {
    reasons.push("No merchant or endpoint was provided.");
  } else if (merchant.status === "unknown") {
    reasons.push(`Merchant ${merchant.label} is not on the v1 known list.`);
  } else {
    reasons.push(`Merchant ${merchant.label} is treated as known.`);
  }
  if (merchant.paycheck === "trusted") {
    reasons.push("PayCheck verdict is trusted.");
  }
  if (merchant.insecure) {
    reasons.push("Merchant URL is not a public https endpoint.");
  }

  const bandText =
    category.band === "unknown"
      ? `Category ${category.category} has no v1 risk band.`
      : `Category ${category.category} is ${category.band} risk.`;
  reasons.push(bandText);

  if (currency > 0) {
    reasons.push(`Currency ${input.currency} adds a penalty of ${currency}.`);
  }
  if (upHits.length > 0) {
    reasons.push(`Risk hints ${upHits.join(", ")} raise caution.`);
  }
  if (downHits.length > 0) {
    reasons.push(`Risk hints ${downHits.join(", ")} lower caution.`);
  }
  if (!input.agentId) {
    reasons.push("No agent id was supplied. It is echoed only and not scored in v1.");
  }

  return {
    score,
    verdict,
    reasons,
    recommended_action: actionFor(verdict, budgetBlocked, paycheckBlocked, microApproved),
    checked_at: clock.now.toISOString(),
    check_id: clock.checkId,
    policy_version: POLICY_VERSION,
    raw_score: raw,
    category: category.category,
    category_band: category.band,
    merchant_status: merchant.status,
    paycheck_verdict: merchant.paycheck,
    budget_blocked: budgetBlocked,
    micro_approved: microApproved,
    amount: input.amount,
    currency: input.currency,
    agent_id: input.agentId,
    merchant: input.merchant,
    purpose: input.purpose,
    penalties: {
      amount,
      merchant: merchant.penalty,
      category: categoryPenalty,
      currency,
      hints_up: hintsUp,
      hints_down: hintsDown,
    },
  };
}

export type ParseResult =
  | { ok: true; spend: NormalizedSpend }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function readText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function firstText(body: Record<string, unknown>, keys: string[], max: number): string | null | undefined {
  for (const key of keys) {
    if (body[key] !== undefined) return readText(body[key], max);
  }
  return null;
}

export function parseSpendBody(body: unknown): ParseResult {
  if (!isRecord(body)) {
    return { ok: false, code: "invalid_body", message: "Score body must be a JSON object." };
  }

  const amount = readNumber(body.amount);
  if (amount === undefined || amount === null) {
    return { ok: false, code: "invalid_amount", message: "amount is required and must be a finite number of USD." };
  }
  if (amount < 0 || amount > 1_000_000_000) {
    return { ok: false, code: "invalid_amount", message: "amount must be between 0 and 1000000000 USD." };
  }

  const currencyRaw = readText(body.currency, 16);
  if (currencyRaw === undefined) {
    return { ok: false, code: "invalid_currency", message: "currency must be a short string." };
  }
  const currency = (currencyRaw ?? "USDC").toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(currency)) {
    return { ok: false, code: "invalid_currency", message: "currency must be 2–16 letters or digits." };
  }

  const category = firstText(body, ["category"], 64);
  const purpose = firstText(body, ["purpose"], 280);
  const merchant = firstText(body, ["merchant", "merchant_url", "endpoint", "endpoint_url"], 500);
  const agentId = firstText(body, ["agent_id", "key_id", "agent"], 128);
  if (category === undefined || purpose === undefined || merchant === undefined || agentId === undefined) {
    return { ok: false, code: "invalid_body", message: "category, purpose, merchant, and agent_id must be strings when set." };
  }

  const daily = readNumber(body.daily_budget_remaining ?? body.daily_remaining);
  const monthly = readNumber(body.monthly_budget_remaining ?? body.monthly_remaining);
  if (daily === undefined || monthly === undefined) {
    return { ok: false, code: "invalid_budget", message: "Budget remaining values must be finite numbers when set." };
  }
  if ((daily !== null && daily < 0) || (monthly !== null && monthly < 0)) {
    return { ok: false, code: "invalid_budget", message: "Budget remaining cannot be negative." };
  }

  let riskHints: string[] = [];
  if (body.risk_hints !== undefined) {
    if (!Array.isArray(body.risk_hints)) {
      return { ok: false, code: "invalid_hints", message: "risk_hints must be an array of strings." };
    }
    if (body.risk_hints.length > 12) {
      return { ok: false, code: "invalid_hints", message: "risk_hints accepts at most 12 entries." };
    }
    for (const hint of body.risk_hints) {
      if (typeof hint !== "string") {
        return { ok: false, code: "invalid_hints", message: "Each risk hint must be a string." };
      }
      const normalized = slug(hint).slice(0, 64);
      if (normalized) riskHints.push(normalized);
    }
  }
  riskHints = [...new Set(riskHints)];

  return {
    ok: true,
    spend: {
      amount,
      currency,
      category,
      purpose,
      merchant,
      agentId,
      dailyBudgetRemaining: daily,
      monthlyBudgetRemaining: monthly,
      riskHints,
    },
  };
}

export function policyDocument(microThresholdUsd: number, paycheckUrl = DEFAULT_PAYCHECK_URL) {
  return {
    policy_version: POLICY_VERSION,
    micro_threshold_usd: microThresholdUsd,
    approve_min_score: APPROVE_MIN_SCORE,
    ask_human_min_score: ASK_HUMAN_MIN_SCORE,
    budget_score_cap: BUDGET_SCORE_CAP,
    micro_score_floor: MICRO_SCORE_FLOOR,
    categories: CATEGORY_BAND,
    known_host_suffixes: KNOWN_HOST_SUFFIXES,
    paycheck: {
      url: paycheckUrl,
      check: "POST /v1/check",
      target_field: "target",
      target: "domain, https URL, or 0x wallet",
      timeout_ms: PAYCHECK_TIMEOUT_MS,
      local_allowlist:
        "A public https host on known_host_suffixes (no userinfo, port 443 or default) is known with no network call, including when PayCheck is down.",
      on_failure:
        "Unreachable, timed out, or non-OK PayCheck responses use local classifyMerchant. score_spend still returns.",
      caller_billing:
        "The lookup is SpendGate's internal call. It does not use the caller's sg_live_ key or x-tw-bundle-client, and it is not a second x402 charge on the score.",
      attribution: {
        api_key_env: "PAYCHECK_API_KEY",
        bundle_secret_env: "BUNDLE_PROXY_SECRET",
        bundle_client: SPENDGATE_PAYCHECK_CLIENT,
        bundle_client_note:
          "Hex for spendgate. Used only when PAYCHECK_API_KEY is unset and BUNDLE_PROXY_SECRET is set. PayCheck counts that client at 1,000 checks per UTC day.",
        anonymous:
          "When neither secret is set, PayCheck's anonymous free tier applies (100 checks per UTC day). No new secret is required.",
      },
      verdicts: {
        trusted: "Known merchant (penalty 0), plus insecure_extra when the URL is not public https.",
        unknown: "Local v1 merchant rules. Not auto-trusted.",
        suspicious: "Penalty 30 plus insecure_extra. Not known, even if the caller sent known_merchant.",
        block:
          "Penalty 42 plus insecure_extra. Verdict block and published score at most 24, including under the micro threshold. Prefer this over allowing.",
      },
    },
    scoring: {
      amount_penalty: "min(75, round(25 * log10(1 + amount_usd)))",
      merchant_penalty: MERCHANT_PENALTY,
      category_penalty: BAND_PENALTY,
      currency_penalty: { USD_USDC: 0, other_stable: 6, other: 12 },
      other_stable: [...OTHER_STABLE],
      hints_up: [...HINTS_UP],
      hint_up_each: 6,
      hint_up_cap: 18,
      hints_down: [...HINTS_DOWN],
      hint_down_each: 6,
      hint_down_cap: 12,
      known_merchant_hint:
        "Marks the merchant known and removes the unknown or missing penalty. A PayCheck suspicious or block verdict overrides it.",
      budget:
        "If amount is greater than daily_budget_remaining or monthly_budget_remaining, verdict is block and score is capped at 24. Omitted budgets are not checked. Equal to the remaining budget is allowed.",
      micro:
        "If amount is strictly under the micro threshold and no supplied budget is exceeded and PayCheck did not block, verdict is approve and score is at least 80.",
      agent_id: "Echoed and not scored in v1.",
    },
  };
}
