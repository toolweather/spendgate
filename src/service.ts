import type { Config } from "./env.js";
import { encodeBase64Json, hmacSha256Hex, randomHex, sha256Hex } from "./crypto.js";
import { lookupPaycheck, paycheckTarget } from "./paycheck.js";
import { APPROVE_MIN_SCORE, BUDGET_SCORE_CAP, parseSpendBody, scoreSpend, type ScoreResult } from "./scoring.js";
import type { StoredKey, UsageSnapshot, UsageStore } from "./store.js";
import {
  applyWalletGuard,
  decideWallet,
  parseAllowlistBody,
  parseWalletFields,
  paymentSourceMacMessage,
  type PaymentSourceClaims,
  type WalletDecision,
} from "./wallets.js";
import { waitlistPitch, waitlistUrl } from "./waitlist.js";
import {
  payloadMismatch,
  paymentNonce,
  paymentRequired,
  paymentRequiredHeader,
  readPaymentHeader,
  settlePayment,
  verifyPayment,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "./x402.js";

export interface QuotaView {
  subject: "anonymous" | "api_key" | "bundle";
  key_id: string | null;
  key_prefix: string | null;
  tier: "anonymous" | "free" | "bundle";
  daily_limit: number;
  used_today: number;
  remaining_today: number;
  paid_today: number;
  price_usd: string;
  price_atomic: string;
  asset: string;
  network: string;
  resets_at: string;
  paid_configured: boolean;
}

export interface ScoreResponseBody {
  score: number;
  verdict: ScoreResult["verdict"];
  reasons: string[];
  recommended_action: string;
  checked_at: string;
  detail: {
    check_id: string;
    policy_version: string;
    raw_score: number;
    category: string;
    category_band: string;
    merchant_status: string;
    paycheck_verdict: ScoreResult["paycheck_verdict"];
    /** Set when a PayCheck lookup was attempted and did not return a verdict. */
    paycheck_error: string | null;
    budget_blocked: boolean;
    micro_approved: boolean;
    amount: number;
    currency: string;
    merchant: string | null;
    purpose: string | null;
    agent_id: string | null;
    penalties: ScoreResult["penalties"];
    payment?: {
      payer: string | null;
      transaction: string;
      network: string;
      replayed: boolean;
    };
  };
  payment_source: PaymentSource;
  quota: Pick<QuotaView, "daily_limit" | "used_today" | "remaining_today" | "paid_today" | "resets_at">;
}

export interface PaymentSource extends PaymentSourceClaims {
  /** Lowercase HMAC-SHA256 hex. Present only when BUNDLE_PROXY_SECRET is set. */
  signature?: string;
}

export type ServiceOutcome =
  | {
      status: 200 | 201;
      body: unknown;
      headers: Record<string, string>;
    }
  | {
      status: 400 | 401 | 402 | 429 | 502 | 503;
      body: unknown;
      headers: Record<string, string>;
    };

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function resetsAt(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

function quotaHeaders(quota: QuotaView): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-spendgate-quota-limit": String(quota.daily_limit),
    "x-spendgate-quota-remaining": String(quota.remaining_today),
    "x-spendgate-quota-reset": quota.resets_at,
  };
}

function quotaView(config: Config, auth: AuthContext, now: Date, usage: UsageSnapshot): QuotaView {
  return {
    subject: auth.plan,
    key_id: auth.key?.id ?? null,
    key_prefix: auth.key?.keyPrefix ?? null,
    tier: auth.plan === "api_key" ? "free" : auth.plan,
    daily_limit: auth.limit,
    used_today: usage.scoreCount,
    remaining_today: Math.max(0, auth.limit - usage.scoreCount),
    paid_today: usage.paidCount,
    price_usd: config.priceUsd,
    price_atomic: config.priceAtomic,
    asset: "USDC",
    network: config.network,
    resets_at: resetsAt(now),
    paid_configured: Boolean(config.payTo),
  };
}

async function quotaFor(
  store: UsageStore,
  config: Config,
  auth: AuthContext,
  now: Date,
): Promise<QuotaView> {
  const usage = await store.getUsage(auth.subject, dayOf(now));
  return quotaView(config, auth, now, usage);
}

/**
 * The free upsert already refused this call, so the stored count is at least
 * the limit. A replica SELECT can still report the first insert of the day.
 */
function quotaAtCap(quota: QuotaView, limit: number): QuotaView {
  if (quota.used_today >= limit) return quota;
  return { ...quota, used_today: limit, remaining_today: 0 };
}

async function exhaustedQuota(
  store: UsageStore,
  config: Config,
  auth: AuthContext,
  now: Date,
): Promise<QuotaView> {
  return quotaAtCap(await quotaFor(store, config, auth, now), auth.limit);
}

function quotaSlice(quota: QuotaView): ScoreResponseBody["quota"] {
  return {
    daily_limit: quota.daily_limit,
    used_today: quota.used_today,
    remaining_today: quota.remaining_today,
    paid_today: quota.paid_today,
    resets_at: quota.resets_at,
  };
}

export function toScoreBody(
  result: ScoreResult,
  quota: QuotaView,
  paycheckError: string | null = null,
  paymentSource: PaymentSource,
): ScoreResponseBody {
  return {
    score: result.score,
    verdict: result.verdict,
    reasons: result.reasons,
    recommended_action: result.recommended_action,
    checked_at: result.checked_at,
    payment_source: paymentSource,
    detail: {
      check_id: result.check_id,
      policy_version: result.policy_version,
      raw_score: result.raw_score,
      category: result.category,
      category_band: result.category_band,
      merchant_status: result.merchant_status,
      paycheck_verdict: result.paycheck_verdict,
      paycheck_error: paycheckError,
      budget_blocked: result.budget_blocked,
      micro_approved: result.micro_approved,
      amount: result.amount,
      currency: result.currency,
      merchant: result.merchant,
      purpose: result.purpose,
      agent_id: result.agent_id,
      penalties: result.penalties,
    },
    quota: quotaSlice(quota),
  };
}

interface AuthContext {
  subject: string;
  limit: number;
  key: StoredKey | null;
  ownerHint: string;
  plan: "anonymous" | "api_key" | "bundle";
}

/**
 * Upstream accepts 16–128 hex chars. Toolweather also sends `anon:` plus that
 * hash for callers with no Toolweather key. A longer value keeps a stable prefix.
 */
export function bundleClientId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (/^[a-f0-9]{16,128}$/.test(trimmed)) return trimmed;
  if (/^anon:[a-f0-9]{16,128}$/.test(trimmed)) return trimmed;
  if (/^[a-f0-9]{129,}$/.test(trimmed)) return trimmed.slice(0, 128);
  const anonLong = /^anon:([a-f0-9]{129,})$/.exec(trimmed);
  if (anonLong?.[1]) return `anon:${anonLong[1].slice(0, 128)}`;
  return null;
}

function secretsEqual(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

async function bundleIdentity(
  config: Config,
  day: string,
  bundleSecret: string | null | undefined,
  bundleClient: string | null | undefined,
): Promise<{ subject: string; ownerHint: string; limit: number } | null> {
  const expected = config.bundleProxySecret;
  if (!expected || !bundleSecret || !secretsEqual(expected, bundleSecret)) return null;
  const clientId = bundleClientId(bundleClient);
  if (!clientId) return null;
  return {
    subject: `bundle:${await sha256Hex(`spendgate-bundle-v1:${day}:${clientId}`)}`,
    ownerHint: await sha256Hex(`spendgate-owner-v1:${day}:bundle:${clientId}`),
    // `anon:` ids rotate with egress. They use the anonymous cap, not a fresh key bucket.
    limit: clientId.startsWith("anon:") ? config.anonDailyLimit : config.keyDailyLimit,
  };
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

async function ownerHint(ip: string | null, day: string): Promise<string> {
  return sha256Hex(`spendgate-owner-v1:${day}:${ip ?? "unknown"}`);
}

export async function resolveAuth(args: {
  store: UsageStore;
  config: Config;
  authorization: string | null;
  apiKeyArgument?: string | null;
  ip: string | null;
  now: Date;
  bundleSecret?: string | null;
  bundleClient?: string | null;
}): Promise<{ ok: true; auth: AuthContext } | { ok: false; outcome: ServiceOutcome }> {
  const day = dayOf(args.now);
  const hint = await ownerHint(args.ip, day);
  const headerKey = bearerToken(args.authorization);
  const presented = headerKey || args.apiKeyArgument?.trim() || null;
  if (!presented) {
    const bundled = await bundleIdentity(args.config, day, args.bundleSecret, args.bundleClient);
    if (bundled) {
      return {
        ok: true,
        auth: {
          subject: bundled.subject,
          limit: bundled.limit,
          key: null,
          ownerHint: bundled.ownerHint,
          plan: "bundle",
        },
      };
    }
    const subject = `anon:${await sha256Hex(`spendgate-anon-v1:${day}:${args.ip ?? "unknown"}`)}`;
    return {
      ok: true,
      auth: { subject, limit: args.config.anonDailyLimit, key: null, ownerHint: hint, plan: "anonymous" },
    };
  }
  if (!presented.startsWith("sg_live_")) {
    return {
      ok: false,
      outcome: {
        status: 401,
        headers: { "cache-control": "no-store" },
        body: { error: { code: "invalid_api_key", message: "API keys start with sg_live_." } },
      },
    };
  }
  const key = await args.store.getKeyByHash(await sha256Hex(presented));
  if (!key) {
    return {
      ok: false,
      outcome: {
        status: 401,
        headers: { "cache-control": "no-store" },
        body: { error: { code: "invalid_api_key", message: "That API key is not recognized." } },
      },
    };
  }
  return {
    ok: true,
    auth: { subject: `key:${key.id}`, limit: key.dailyLimit, key, ownerHint: hint, plan: "api_key" },
  };
}

async function signedPaymentSource(
  secret: string | null,
  source: PaymentSourceClaims,
  verdict: string,
): Promise<PaymentSource> {
  if (!secret) return source;
  return { ...source, signature: await hmacSha256Hex(secret, paymentSourceMacMessage(source, verdict)) };
}

function errorOutcome(status: 400 | 401 | 402 | 502 | 503, code: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>): ServiceOutcome {
  return {
    status,
    headers: { "cache-control": "no-store", ...headers },
    body: { error: { code, message }, ...extra },
  };
}

export async function readQuota(args: {
  store: UsageStore;
  config: Config;
  authorization: string | null;
  apiKeyArgument?: string | null;
  ip: string | null;
  now: Date;
  bundleSecret?: string | null;
  bundleClient?: string | null;
}): Promise<ServiceOutcome> {
  const auth = await resolveAuth(args);
  if (!auth.ok) return auth.outcome;
  const quota = await quotaFor(args.store, args.config, auth.auth, args.now);
  return { status: 200, body: quota, headers: quotaHeaders(quota) };
}

export async function mintKey(args: {
  store: UsageStore;
  config: Config;
  ip: string | null;
  now: Date;
  label: string | null;
  ids?: () => string;
  bundleSecret?: string | null;
  bundleClient?: string | null;
}): Promise<ServiceOutcome> {
  const day = dayOf(args.now);
  const bundled = await bundleIdentity(args.config, day, args.bundleSecret, args.bundleClient);
  const hint = bundled?.ownerHint ?? (await ownerHint(args.ip, day));
  const since = `${day}T00:00:00.000Z`;
  const minted = await args.store.countKeysSince(hint, since);
  if (minted >= args.config.keysPerDay) {
    return {
      status: 429,
      headers: { "cache-control": "no-store" },
      body: {
        error: {
          code: "key_mint_limit",
          message: `This client already minted ${args.config.keysPerDay} free keys today.`,
        },
      },
    };
  }
  const nextId = args.ids ?? randomHex;
  const secretBody = nextId(32);
  const apiKey = `sg_live_${secretBody}`;
  const row: StoredKey = {
    id: `key_${nextId(8)}`,
    keyHash: await sha256Hex(apiKey),
    keyPrefix: `sg_live_${secretBody.slice(0, 8)}`,
    label: args.label,
    tier: "free",
    dailyLimit: args.config.keyDailyLimit,
    createdAt: args.now.toISOString(),
    ownerHint: hint,
  };
  await args.store.insertKey(row);
  return {
    status: 201,
    headers: { "cache-control": "no-store" },
    body: {
      api_key: apiKey,
      key_id: row.id,
      key_prefix: row.keyPrefix,
      label: row.label,
      tier: row.tier,
      daily_limit: row.dailyLimit,
      created_at: row.createdAt,
      note: "Store this key now. SpendGate keeps only a hash and cannot show it again.",
    },
  };
}

export async function setWalletAllowlist(args: {
  store: UsageStore;
  config: Config;
  authorization: string | null;
  apiKeyArgument?: string | null;
  ip: string | null;
  now: Date;
  body: unknown;
  bundleSecret?: string | null;
  bundleClient?: string | null;
}): Promise<ServiceOutcome> {
  const parsed = parseAllowlistBody(args.body);
  if (!parsed.ok) return errorOutcome(400, parsed.code, parsed.message);

  const auth = await resolveAuth(args);
  if (!auth.ok) return auth.outcome;
  if (!auth.auth.key) {
    return errorOutcome(
      401,
      "api_key_required",
      "An sg_live_ API key is required to store a wallet allowlist. Anonymous callers can pass allowed_wallets on a score instead.",
    );
  }

  const updatedAt = args.now.toISOString();
  await args.store.setWalletAllowlist(auth.auth.key.id, parsed.wallets, updatedAt);
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: {
      key_id: auth.auth.key.id,
      key_prefix: auth.auth.key.keyPrefix,
      allowed_wallets: parsed.wallets,
      updated_at: updatedAt,
    },
  };
}

export async function scoreRequest(args: {
  store: UsageStore;
  config: Config;
  fetchImpl: typeof fetch;
  /** PayCheck service binding. Used instead of fetchImpl when present. */
  paycheck?: Fetcher;
  now: Date;
  ip: string | null;
  authorization: string | null;
  apiKeyArgument?: string | null;
  bundleSecret?: string | null;
  bundleClient?: string | null;
  body: unknown;
  resourceUrl: string;
  paymentHeader: string | null;
  idempotencyKey: string | null;
  ids?: () => string;
}): Promise<ServiceOutcome> {
  const parsed = parseSpendBody(args.body);
  if (!parsed.ok) {
    return errorOutcome(400, parsed.code, parsed.message);
  }
  const walletFields = parseWalletFields(args.body);
  if (!walletFields.ok) {
    return errorOutcome(400, walletFields.code, walletFields.message);
  }

  const auth = await resolveAuth(args);
  if (!auth.ok) return auth.outcome;

  let storedAllowlist: string[] | null = null;
  if (walletFields.fromWallet && walletFields.allowedWallets === null && auth.auth.key) {
    storedAllowlist = await args.store.getWalletAllowlist(auth.auth.key.id);
  }
  const walletDecision: WalletDecision = decideWallet({
    fromWallet: walletFields.fromWallet,
    requestAllowlist: walletFields.allowedWallets,
    storedAllowlist,
  });

  const day = dayOf(args.now);
  const consumed = await args.store.tryConsumeFree(auth.auth.subject, day, auth.auth.limit);

  let payer: string | null = null;
  let nonce: string | null = null;
  let pending: { payload: PaymentPayload; requirements: PaymentRequirements } | null = null;

  if (!consumed) {
    if (!args.config.payTo) {
      const quota = await exhaustedQuota(args.store, args.config, auth.auth, args.now);
      const url = waitlistUrl(args.resourceUrl);
      return errorOutcome(
        402,
        "payment_not_configured",
        `The free daily cap is exhausted and PAY_TO is not set, so this server cannot accept USDC yet. ${waitlistPitch(url)}`,
        { quota: quotaSlice(quota), waitlist_url: url },
        quotaHeaders(quota),
      );
    }

    const decoded = readPaymentHeader(args.paymentHeader);
    if (!decoded.ok) {
      const required = paymentRequired(args.config, args.resourceUrl, decoded.message);
      const quota = await exhaustedQuota(args.store, args.config, auth.auth, args.now);
      return {
        status: 402,
        headers: {
          ...quotaHeaders(quota),
          "PAYMENT-REQUIRED": paymentRequiredHeader(required),
        },
        // waitlist_url sits beside quota. It is not part of the x402 header payload.
        body: { ...required, quota: quotaSlice(quota), waitlist_url: waitlistUrl(args.resourceUrl) },
      };
    }

    nonce = paymentNonce(decoded.payload);
    if (nonce) {
      const existing = await args.store.getPayment(nonce);
      if (existing) {
        if (existing.subject !== auth.auth.subject) {
          return errorOutcome(402, "payment_replay", "That payment nonce was already used.");
        }
        const stored = JSON.parse(existing.responseJson) as ScoreResponseBody;
        stored.detail.payment = {
          payer: existing.payer,
          transaction: existing.txHash ?? "",
          network: args.config.network,
          replayed: true,
        };
        const quota = await exhaustedQuota(args.store, args.config, auth.auth, args.now);
        stored.quota = quotaSlice(quota);
        const headers = quotaHeaders(quota);
        if (existing.txHash) {
          headers["PAYMENT-RESPONSE"] = encodeBase64Json({
            success: true,
            transaction: existing.txHash,
            network: args.config.network,
            payer: existing.payer,
          });
        }
        return { status: 200, body: stored, headers };
      }
    }

    const requirements = paymentRequired(args.config, args.resourceUrl, "Payment payload did not match the score price.").accepts[0]!;
    const mismatch = payloadMismatch(decoded.payload, requirements);
    if (mismatch) {
      const required = paymentRequired(args.config, args.resourceUrl, mismatch);
      const quota = await exhaustedQuota(args.store, args.config, auth.auth, args.now);
      return {
        status: 402,
        headers: { ...quotaHeaders(quota), "PAYMENT-REQUIRED": paymentRequiredHeader(required) },
        body: { ...required, error: mismatch, quota: quotaSlice(quota) },
      };
    }

    const verified = await verifyPayment(args.fetchImpl, args.config, decoded.payload, requirements);
    if (!verified.ok) {
      const required = paymentRequired(args.config, args.resourceUrl, verified.message);
      const quota = await exhaustedQuota(args.store, args.config, auth.auth, args.now);
      return {
        status: verified.status === 502 ? 502 : 402,
        headers: { ...quotaHeaders(quota), "PAYMENT-REQUIRED": paymentRequiredHeader(required) },
        body:
          verified.status === 502
            ? { error: { code: "facilitator_error", message: verified.message } }
            : { ...required, quota: quotaSlice(quota) },
      };
    }
    if (!nonce) {
      return errorOutcome(402, "invalid_payload", "Payment authorization nonce is missing.");
    }
    payer = verified.payer ?? decoded.payload.payload?.authorization?.from ?? null;
    pending = { payload: decoded.payload, requirements };
  }

  const checkId = `chk_${(args.ids ?? randomHex)(10)}`;
  const target = paycheckTarget(parsed.spend.merchant);
  const paycheck = target
    ? await lookupPaycheck(args.fetchImpl, args.config, target, args.paycheck)
    : { verdict: null, error: null };
  const scored = scoreSpend(
    parsed.spend,
    {
      now: args.now,
      checkId,
      microThresholdUsd: args.config.microThresholdUsd,
    },
    paycheck.verdict,
  );
  const result = applyWalletGuard(scored, walletDecision, {
    block: BUDGET_SCORE_CAP,
    ask: APPROVE_MIN_SCORE - 1,
  });

  let settlement: SettleResponse | null = null;
  if (pending) {
    const settled = await settlePayment(
      args.fetchImpl,
      args.config,
      pending.payload,
      pending.requirements,
      args.idempotencyKey ?? nonce,
    );
    if (!settled.ok) {
      const required = paymentRequired(args.config, args.resourceUrl, settled.message);
      const quota = await exhaustedQuota(args.store, args.config, auth.auth, args.now);
      return {
        status: settled.status === 502 ? 502 : 402,
        headers: { ...quotaHeaders(quota), "PAYMENT-REQUIRED": paymentRequiredHeader(required) },
        body:
          settled.status === 502
            ? { error: { code: "facilitator_error", message: settled.message } }
            : { ...required, quota: quotaSlice(quota) },
      };
    }
    settlement = settled.settlement;
    payer = settlement.payer ?? payer;
  }

  const quota = consumed
    ? quotaView(args.config, auth.auth, args.now, consumed)
    : await exhaustedQuota(args.store, args.config, auth.auth, args.now);
  if (settlement && nonce) {
    quota.paid_today += 1;
  }
  const paymentSource = await signedPaymentSource(
    args.config.bundleProxySecret,
    {
      from_wallet: walletDecision.fromWallet,
      allowlisted: walletDecision.allowlisted,
      checked_at: result.checked_at,
      reason: walletDecision.reason,
    },
    result.verdict,
  );
  const body = toScoreBody(result, quota, paycheck.error, paymentSource);
  if (settlement) {
    body.detail.payment = {
      payer,
      transaction: settlement.transaction,
      network: settlement.network,
      replayed: false,
    };
  }

  if (settlement && nonce) {
    await args.store.recordPayment({
      nonce,
      subject: auth.auth.subject,
      payer,
      txHash: settlement.transaction || null,
      amount: args.config.priceAtomic,
      responseJson: JSON.stringify(body),
      createdAt: args.now.toISOString(),
    });
    await args.store.addPaid(auth.auth.subject, day);
  }

  const headers = quotaHeaders(quota);
  if (settlement) {
    headers["PAYMENT-RESPONSE"] = encodeBase64Json(settlement);
  }
  return { status: 200, body, headers };
}
