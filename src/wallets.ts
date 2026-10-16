/**
 * Authorized-wallet guard.
 *
 * Published developer mnemonics are not secrets. Accounts 0–9 below are the
 * ones tutorials and local chains derive at m/44'/60'/0'/0/i. The phrases
 * themselves are not repeated here; the addresses are enough to refuse a spend.
 *
 * - hardhat-anvil: Hardhat and Anvil default mnemonic
 * - ganache: Truffle Ganache / "candy maple…" mnemonic
 * - bip39-test: BIP-39 official test mnemonic ("abandon … about")
 * - truffle-tutorial: Truffle HD-wallet tutorial mnemonic ("myth like bonus…")
 */

export const MAX_ALLOWLIST = 32;

export type WalletReason = "dev_wallet" | "unauthorized_wallet" | "wallet_unverified";

export interface DevWalletGroup {
  name: string;
  note: string;
  addresses: readonly string[];
}

const HARDHAT_ANVIL = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
] as const;

const GANACHE = [
  "0x627306090abaB3A6e1400e9345bC60c78a8BEf57",
  "0xf17f52151EbEF6C7334FAD080c5704D77216b732",
  "0xC5fdf4076b8F3A5357c5E395ab970B5B54098Fef",
  "0x821aEa9a577a9b44299B9c15c88cf3087F3b5544",
  "0x0d1d4e623D10F9FBA5Db95830F7d3839406C6AF2",
  "0x2932b7A2355D6fecc4b5c0B6BD44cC31df247a2e",
  "0x2191eF87E392377ec08E7c08Eb105Ef5448eCED5",
  "0x0F4F2Ac550A1b4e2280d04c21cEa7EBD822934b5",
  "0x6330A553Fc93768F612722BB8c2eC78aC90B3bbc",
  "0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE",
] as const;

const BIP39_TEST = [
  "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
  "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A",
  "0xF3f50213C1d2e255e4B2bAD430F8A38EEF8D718E",
  "0x51cA8ff9f1C0a99f88E86B8112eA3237F55374cA",
  "0xA40cFBFc8534FFC84E20a7d8bBC3729B26a35F6f",
  "0xB191a13bfE648B61002F2e2135867015B71816a6",
  "0x593814d3309e2dF31D112824F0bb5aa7Cb0D7d47",
  "0xB14c391e2bf19E5a26941617ab546FA620A4f163",
  "0x4C1C56443AbFe6dD33de31dAaF0a6E929DBc4971",
] as const;

const TRUFFLE_TUTORIAL = [
  "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
  "0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0",
  "0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b",
  "0xE11BA2b4D45Eaed5996Cd0823791E0C93114882d",
  "0xd03ea8624C8C5987235048901fB614fDcA89b117",
  "0x95cED938F7991cd0dFcb48F0a06a40FA1aF46EBC",
  "0x3E5e9111Ae8eB78Fe1CC3bb8915d5D461F3Ef9A9",
  "0x28a8746e75304c0780E011BEd21C72cD78cd535E",
  "0xACa94ef8bD5ffEE41947b4585a84BdA5a3d3DA6E",
  "0x1dF62f291b2E969fB0849d99D9Ce41e2F137006e",
] as const;

export const DEV_WALLET_GROUPS: readonly DevWalletGroup[] = [
  {
    name: "hardhat-anvil",
    note: "Hardhat and Anvil default mnemonic, accounts 0-9.",
    addresses: HARDHAT_ANVIL,
  },
  {
    name: "ganache",
    note: "Truffle Ganache default mnemonic, accounts 0-9.",
    addresses: GANACHE,
  },
  {
    name: "bip39-test",
    note: "BIP-39 test mnemonic, accounts 0-9.",
    addresses: BIP39_TEST,
  },
  {
    name: "truffle-tutorial",
    note: "Truffle HD-wallet tutorial mnemonic, accounts 0-9.",
    addresses: TRUFFLE_TUTORIAL,
  },
];

const DEV_WALLETS = new Set(
  DEV_WALLET_GROUPS.flatMap((group) => group.addresses.map((address) => address.toLowerCase())),
);

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function isDevWallet(address: string): boolean {
  return DEV_WALLETS.has(address.toLowerCase());
}

export function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!ADDRESS.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export interface WalletDecision {
  fromWallet: string | null;
  /** True when an allowlist exists and contains from_wallet. False when a list exists and does not. Null when there is no list or no wallet. */
  allowlisted: boolean | null;
  reason: WalletReason | null;
}

/**
 * Request `allowed_wallets` wins over the stored list, including an empty array.
 * A published dev account is `dev_wallet` even when that address is on the list.
 * No from_wallet leaves the decision empty so the score stays as it was.
 */
export function decideWallet(args: {
  fromWallet: string | null;
  requestAllowlist: readonly string[] | null;
  storedAllowlist: readonly string[] | null;
}): WalletDecision {
  if (!args.fromWallet) {
    return { fromWallet: null, allowlisted: null, reason: null };
  }
  const list = args.requestAllowlist ?? args.storedAllowlist;
  const allowlisted = list === null ? null : list.includes(args.fromWallet);
  if (isDevWallet(args.fromWallet)) {
    return { fromWallet: args.fromWallet, allowlisted, reason: "dev_wallet" };
  }
  if (list === null) {
    return { fromWallet: args.fromWallet, allowlisted: null, reason: "wallet_unverified" };
  }
  if (!allowlisted) {
    return { fromWallet: args.fromWallet, allowlisted: false, reason: "unauthorized_wallet" };
  }
  return { fromWallet: args.fromWallet, allowlisted: true, reason: null };
}

export type WalletFieldParse =
  | { ok: true; fromWallet: string | null; allowedWallets: string[] | null }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAddressList(
  value: unknown,
  code: string,
): { ok: true; wallets: string[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, code, message: "allowed_wallets must be an array of 0x addresses." };
  }
  if (value.length > MAX_ALLOWLIST) {
    return { ok: false, code, message: `allowed_wallets accepts at most ${MAX_ALLOWLIST} addresses.` };
  }
  const wallets: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, code, message: "Each allowed wallet must be a 0x address." };
    }
    const normalized = normalizeAddress(entry);
    if (!normalized) {
      return { ok: false, code, message: "Each allowed wallet must be a 0x address (40 hex characters)." };
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      wallets.push(normalized);
    }
  }
  return { ok: true, wallets };
}

/** Optional score fields. Omitted means "not provided", which is not an empty list. */
export function parseWalletFields(body: unknown): WalletFieldParse {
  if (!isRecord(body)) {
    return { ok: false, code: "invalid_body", message: "Score body must be a JSON object." };
  }
  let fromWallet: string | null = null;
  if (body.from_wallet !== undefined && body.from_wallet !== null && body.from_wallet !== "") {
    if (typeof body.from_wallet !== "string") {
      return { ok: false, code: "invalid_wallet", message: "from_wallet must be a 0x address." };
    }
    const normalized = normalizeAddress(body.from_wallet);
    if (!normalized) {
      return { ok: false, code: "invalid_wallet", message: "from_wallet must be a 0x address (40 hex characters)." };
    }
    fromWallet = normalized;
  }

  if (body.allowed_wallets === undefined || body.allowed_wallets === null) {
    return { ok: true, fromWallet, allowedWallets: null };
  }
  const list = parseAddressList(body.allowed_wallets, "invalid_wallets");
  if (!list.ok) return list;
  return { ok: true, fromWallet, allowedWallets: list.wallets };
}

/** Body for set_wallet_allowlist. Public dev accounts are refused and not stored. */
export function parseAllowlistBody(
  body: unknown,
): { ok: true; wallets: string[] } | { ok: false; code: string; message: string } {
  if (!isRecord(body)) {
    return { ok: false, code: "invalid_wallets", message: "Allowlist body must be a JSON object." };
  }
  if (body.allowed_wallets === undefined) {
    return { ok: false, code: "invalid_wallets", message: "allowed_wallets is required." };
  }
  const list = parseAddressList(body.allowed_wallets, "invalid_wallets");
  if (!list.ok) return list;
  const dev = list.wallets.find((address) => isDevWallet(address));
  if (dev) {
    return {
      ok: false,
      code: "dev_wallet",
      message: `Public developer test account ${dev} cannot be allowlisted. Its key is published.`,
    };
  }
  return list;
}

interface GuardedScore {
  score: number;
  verdict: "approve" | "ask_human" | "block";
  reasons: string[];
  recommended_action: string;
  micro_approved: boolean;
}

function walletSentence(decision: WalletDecision): string {
  const wallet = decision.fromWallet ?? "";
  if (decision.reason === "dev_wallet") {
    return `Wallet ${wallet} is a well-known public developer test account.`;
  }
  if (decision.reason === "unauthorized_wallet") {
    return `Wallet ${wallet} is not on the allowed wallets for this spend.`;
  }
  return `Wallet ${wallet} has no allowlist, so a person must confirm it before any spend.`;
}

/**
 * Apply the wallet decision on top of a finished score.
 * `block` is the published budget cap. `ask` is the highest score that is still ask_human.
 * A wallet block replaces approve, including the micro-threshold approve.
 * wallet_unverified does not turn an existing block into ask_human.
 */
export function applyWalletGuard<T extends GuardedScore>(
  result: T,
  decision: WalletDecision,
  caps: { block: number; ask: number },
): T {
  if (!decision.reason) return result;
  const reasons = [decision.reason, walletSentence(decision), ...result.reasons];
  if (decision.reason === "dev_wallet" || decision.reason === "unauthorized_wallet") {
    return {
      ...result,
      score: Math.min(result.score, caps.block),
      verdict: "block",
      reasons,
      recommended_action:
        decision.reason === "dev_wallet"
          ? "Do not pay. This is a published developer test account, so anyone can derive its key."
          : "Do not pay. This wallet is not on the allowlist.",
      micro_approved: false,
    };
  }
  const keepBlock = result.verdict === "block";
  return {
    ...result,
    score: result.verdict === "approve" ? Math.min(result.score, caps.ask) : result.score,
    verdict: keepBlock ? "block" : "ask_human",
    reasons,
    recommended_action: keepBlock
      ? result.recommended_action
      : "Do not pay yet. No allowlist covers this wallet. Ask a human before spending from it.",
    micro_approved: false,
  };
}

export interface PaymentSourceClaims {
  from_wallet: string | null;
  allowlisted: boolean | null;
  checked_at: string;
  reason: WalletReason | null;
}

/** Canonical HMAC input. Versioned so the field order can change later. */
export function paymentSourceMacMessage(source: PaymentSourceClaims, verdict: string): string {
  return [
    "spendgate-payment-source-v1",
    source.from_wallet ?? "",
    source.allowlisted === null ? "" : String(source.allowlisted),
    source.checked_at,
    source.reason ?? "",
    verdict,
  ].join("\n");
}
