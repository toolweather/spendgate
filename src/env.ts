export interface Env {
  DB?: D1Database;
  ASSETS?: Fetcher;
  /** Receiving 0x address for x402 USDC. Unset means paid overage is not configured. */
  PAY_TO?: string;
  FACILITATOR_URL?: string;
  NETWORK?: string;
  ASSET?: string;
  ASSET_NAME?: string;
  ASSET_VERSION?: string;
  PRICE_ATOMIC?: string;
  ANON_DAILY_LIMIT?: string;
  KEY_DAILY_LIMIT?: string;
  KEYS_PER_DAY?: string;
  MICRO_THRESHOLD_USD?: string;
  /**
   * Shared secret with the Toolweather Worker. Set with
   * `npx wrangler secret put BUNDLE_PROXY_SECRET`. Never commit the value.
   */
  BUNDLE_PROXY_SECRET?: string;
}

export interface Config {
  payTo: string | null;
  facilitatorUrl: string;
  network: string;
  asset: string;
  assetName: string;
  assetVersion: string;
  priceAtomic: string;
  priceUsd: string;
  anonDailyLimit: number;
  keyDailyLimit: number;
  keysPerDay: number;
  microThresholdUsd: number;
  maxTimeoutSeconds: number;
  /** Null when the Worker secret is unset. Headers are ignored in that case. */
  bundleProxySecret: string | null;
}

const USDC_DECIMALS = 6;

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function numEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function formatUsdFromAtomic(atomic: string): string {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return "0.001";
  const usd = n / 10 ** USDC_DECIMALS;
  return usd.toFixed(USDC_DECIMALS).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export function readConfig(env: Env): Config {
  const payTo = (env.PAY_TO ?? "").trim();
  const payToOk = /^0x[a-fA-F0-9]{40}$/.test(payTo);
  const priceAtomic = (env.PRICE_ATOMIC ?? "").trim() || "1000";
  return {
    payTo: payToOk ? payTo : null,
    facilitatorUrl: (env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, ""),
    network: env.NETWORK || "eip155:8453",
    asset: env.ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetName: env.ASSET_NAME || "USD Coin",
    assetVersion: env.ASSET_VERSION || "2",
    priceAtomic,
    priceUsd: formatUsdFromAtomic(priceAtomic),
    anonDailyLimit: intEnv(env.ANON_DAILY_LIMIT, 100),
    keyDailyLimit: intEnv(env.KEY_DAILY_LIMIT, 1000),
    keysPerDay: intEnv(env.KEYS_PER_DAY, 20),
    microThresholdUsd: numEnv(env.MICRO_THRESHOLD_USD, 1),
    maxTimeoutSeconds: 60,
    bundleProxySecret: (env.BUNDLE_PROXY_SECRET ?? "").trim() || null,
  };
}

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    FACILITATOR_URL: "https://facilitator.payai.network",
    NETWORK: "eip155:8453",
    ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ASSET_NAME: "USD Coin",
    ASSET_VERSION: "2",
    PRICE_ATOMIC: "1000",
    ANON_DAILY_LIMIT: "100",
    KEY_DAILY_LIMIT: "1000",
    KEYS_PER_DAY: "20",
    MICRO_THRESHOLD_USD: "1",
    ...over,
  };
}
