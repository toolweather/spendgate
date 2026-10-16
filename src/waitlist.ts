import type { ServiceOutcome } from "./service.js";
import type { UsageStore } from "./store.js";
import { sha256Hex } from "./crypto.js";

/** Public page for the two-week SpendGate Pro demand test. */
export const WAITLIST_PATH = "/pro";

/** Proposed team price shown on /pro and in the free-cap 402 line. */
export const PRO_PRICE_LABEL = "$19/mo";

/** Used when the caller is not on an http(s) origin, including stdio. */
export const PUBLIC_WAITLIST_URL = "https://spendgate.toolweather.workers.dev/pro";

/**
 * Signups per client per UTC day. The cap is enforced inside the insert,
 * so a new address is still one D1 write. The free plan shares 100k writes/day.
 */
export const WAITLIST_IP_DAILY_CAP = 10;

/** Hidden form field. A non-empty value is treated as a bot and not stored. */
export const HONEYPOT_FIELD = "hp_field";

const EMAIL_RE =
  /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

export function waitlistUrl(resourceUrl: string): string {
  try {
    const url = new URL(resourceUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${WAITLIST_PATH}`;
  } catch {
    /* Fall through to the public page. */
  }
  return PUBLIC_WAITLIST_URL;
}

export function waitlistPitch(url: string): string {
  return `SpendGate Pro is ${PRO_PRICE_LABEL} for teams (higher limits, spend policies, and alerts). Join the waitlist: ${url}`;
}

export function normalizeEmail(value: unknown): { ok: true; email: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "Enter a valid email address." };
  const email = value.trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  if (email.length > 254 || local.length > 64 || email.includes("..") || !EMAIL_RE.test(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  return { ok: true, email };
}

export function normalizeSource(value: unknown): { ok: true; source: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") return { ok: true, source: null };
  if (typeof value !== "string") return { ok: false, message: "source must be a string." };
  const source = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 64);
  return { ok: true, source: source || null };
}

export function honeypotTripped(body: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, HONEYPOT_FIELD)) return false;
  const value = body[HONEYPOT_FIELD];
  if (typeof value !== "string") return true;
  return value.trim() !== "";
}

export async function waitlistIpHash(ip: string | null, day: string): Promise<string> {
  return sha256Hex(`spendgate-waitlist-v1:${day}:${ip ?? "unknown"}`);
}

export async function submitWaitlist(args: {
  store: UsageStore;
  now: Date;
  ip: string | null;
  body: unknown;
}): Promise<ServiceOutcome> {
  const record = args.body && typeof args.body === "object" && !Array.isArray(args.body) ? (args.body as Record<string, unknown>) : {};
  if (honeypotTripped(record)) {
    return { status: 200, headers: { "cache-control": "no-store" }, body: { ok: true } };
  }
  const email = normalizeEmail(record.email);
  if (!email.ok) {
    return {
      status: 400,
      headers: { "cache-control": "no-store" },
      body: { error: { code: "invalid_email", message: email.message } },
    };
  }
  const source = normalizeSource(record.source);
  if (!source.ok) {
    return {
      status: 400,
      headers: { "cache-control": "no-store" },
      body: { error: { code: "invalid_source", message: source.message } },
    };
  }
  const day = args.now.toISOString().slice(0, 10);
  const result = await args.store.joinWaitlist({
    email: email.email,
    createdAt: args.now.toISOString(),
    source: source.source,
    ipHash: await waitlistIpHash(args.ip, day),
    ipDailyCap: WAITLIST_IP_DAILY_CAP,
  });
  if (result === "rate_limited") {
    return {
      status: 429,
      headers: { "cache-control": "no-store" },
      body: {
        error: {
          code: "waitlist_rate_limit",
          message: "Too many waitlist signups from this network today.",
        },
      },
    };
  }
  return {
    status: result === "created" ? 201 : 200,
    headers: { "cache-control": "no-store" },
    body: { ok: true },
  };
}

export async function waitlistCount(store: UsageStore): Promise<ServiceOutcome> {
  const count = await store.countWaitlist();
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: { count },
  };
}
