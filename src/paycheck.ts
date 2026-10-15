import {
  PAYCHECK_TIMEOUT_MS,
  SPENDGATE_PAYCHECK_CLIENT,
  type Config,
} from "./env.js";
import {
  hostOnAllowlist,
  isDomainHost,
  isIpHost,
  type PaycheckVerdict,
} from "./scoring.js";

const VERDICTS = new Set<PaycheckVerdict>(["trusted", "unknown", "suspicious", "block"]);

/**
 * Target to send PayCheck, or null when the local allowlist already decides
 * or the merchant is not a domain, URL, or 0x wallet.
 *
 * Public https hosts on KNOWN_HOST_SUFFIXES skip the network so they stay
 * known when PayCheck is down. http, raw IPs, userinfo, and non-443 ports
 * still go to PayCheck.
 */
export function paycheckTarget(merchant: string | null): string | null {
  const value = merchant?.trim() ?? "";
  if (!value) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return value;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const plainHttps =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (url.port === "" || url.port === "443") &&
        !isIpHost(host) &&
        host !== "localhost" &&
        !host.endsWith(".local");
      if (plainHttps && hostOnAllowlist(host)) return null;
      return value;
    } catch {
      return null;
    }
  }

  if (isDomainHost(value)) {
    const host = value.replace(/\.$/, "").toLowerCase();
    if (hostOnAllowlist(host)) return null;
    return host;
  }
  return null;
}

function paycheckHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.paycheckApiKey) {
    headers.authorization = `Bearer ${config.paycheckApiKey}`;
    headers["x-api-key"] = config.paycheckApiKey;
    return headers;
  }
  if (config.bundleProxySecret) {
    headers["x-tw-bundle-secret"] = config.bundleProxySecret;
    headers["x-tw-bundle-client"] = SPENDGATE_PAYCHECK_CLIENT;
  }
  return headers;
}

/**
 * Live PayCheck verdict, or null when the call cannot be trusted.
 * Null means the caller should keep local classifyMerchant (fail open).
 * Auth is SpendGate's own key, bundle client, or anonymous — never the end user.
 */
export async function lookupPaycheck(
  fetchImpl: typeof fetch,
  config: Config,
  target: string,
): Promise<PaycheckVerdict | null> {
  const url = `${config.paycheckUrl.replace(/\/$/, "")}/v1/check`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: paycheckHeaders(config),
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(PAYCHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = (await response.json()) as { verdict?: unknown };
    if (typeof body.verdict === "string" && VERDICTS.has(body.verdict as PaycheckVerdict)) {
      return body.verdict as PaycheckVerdict;
    }
    return null;
  } catch {
    return null;
  }
}
