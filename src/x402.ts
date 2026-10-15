import { encodeBase64Json, decodeBase64Json } from "./crypto.js";
import type { Config } from "./env.js";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
  };
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: {
    url: string;
    description: string;
    mimeType: string;
    serviceName: string;
  };
  accepts: PaymentRequirements[];
  extensions: Record<string, never>;
}

export interface PaymentPayload {
  x402Version: number;
  accepted?: Partial<PaymentRequirements>;
  payload?: {
    signature?: string;
    authorization?: {
      from?: string;
      to?: string;
      value?: string;
      validAfter?: string;
      validBefore?: string;
      nonce?: string;
    };
  };
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export function paymentRequirements(config: Config): PaymentRequirements {
  if (!config.payTo) {
    throw new Error("PAY_TO is not configured");
  }
  return {
    scheme: "exact",
    network: config.network,
    amount: config.priceAtomic,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      name: config.assetName,
      version: config.assetVersion,
    },
  };
}

export function paymentRequired(config: Config, resourceUrl: string, error: string): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: {
      url: resourceUrl,
      description: "One SpendGate spend score after the free daily cap",
      mimeType: "application/json",
      serviceName: "SpendGate",
    },
    accepts: [paymentRequirements(config)],
    extensions: {},
  };
}

export function paymentRequiredHeader(body: PaymentRequired): string {
  return encodeBase64Json(body);
}

export function readPaymentHeader(header: string | null): { ok: true; payload: PaymentPayload } | { ok: false; message: string } {
  if (!header) return { ok: false, message: "PAYMENT-SIGNATURE header is required." };
  try {
    const parsed = decodeBase64Json(header);
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, message: "PAYMENT-SIGNATURE did not contain a JSON object." };
    }
    return { ok: true, payload: parsed as PaymentPayload };
  } catch {
    return { ok: false, message: "PAYMENT-SIGNATURE is not valid base64 JSON." };
  }
}

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

/** Reject payloads that do not match the price we are charging before calling the facilitator. */
export function payloadMismatch(payload: PaymentPayload, requirements: PaymentRequirements): string | null {
  if (payload.x402Version !== 2) return "Only x402Version 2 is accepted.";
  const accepted = payload.accepted;
  if (!accepted) return "Payment payload is missing accepted requirements.";
  if (accepted.scheme !== "exact") return "Only the exact scheme is accepted.";
  if (accepted.network !== requirements.network) return "Payment network does not match this server.";
  if (accepted.amount !== requirements.amount) return "Payment amount does not match the score price.";
  if (!sameAddress(accepted.asset, requirements.asset)) return "Payment asset does not match Base USDC.";
  if (!sameAddress(accepted.payTo, requirements.payTo)) return "Payment recipient does not match PAY_TO.";
  const authorization = payload.payload?.authorization;
  if (!authorization?.nonce || authorization.nonce.length > 200 || !authorization.value || !authorization.to || !authorization.from) {
    return "Payment authorization is missing from, to, value, or nonce.";
  }
  if (authorization.value !== requirements.amount) return "Authorization value does not match the score price.";
  if (!sameAddress(authorization.to, requirements.payTo)) return "Authorization recipient does not match PAY_TO.";
  const signature = payload.payload?.signature ?? "";
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) && !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return "Payment signature is missing.";
  }
  return null;
}

export function paymentNonce(payload: PaymentPayload): string | null {
  const nonce = payload.payload?.authorization?.nonce;
  return nonce && nonce.length <= 200 ? nonce : null;
}

export interface FacilitatorResult<T> {
  ok: true;
  body: T;
}

export interface FacilitatorFailure {
  ok: false;
  status: number;
  message: string;
}

async function postFacilitator<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  idempotencyKey?: string | null,
): Promise<FacilitatorResult<T> | FacilitatorFailure> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { ok: false, status: 502, message: "The payment facilitator could not be reached." };
  }
  let parsed: T;
  try {
    parsed = (await response.json()) as T;
  } catch {
    return { ok: false, status: 502, message: "The payment facilitator returned a non-JSON body." };
  }
  if (!response.ok && response.status >= 500) {
    return { ok: false, status: 502, message: "The payment facilitator failed." };
  }
  return { ok: true, body: parsed };
}

export async function verifyPayment(
  fetchImpl: typeof fetch,
  config: Config,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<{ ok: true; payer?: string } | FacilitatorFailure> {
  const result = await postFacilitator<VerifyResponse>(fetchImpl, `${config.facilitatorUrl}/verify`, {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
  if (!result.ok) return result;
  if (!result.body.isValid) {
    return {
      ok: false,
      status: 402,
      message: result.body.invalidReason
        ? `Payment was rejected: ${result.body.invalidReason}.`
        : "Payment was rejected by the facilitator.",
    };
  }
  return { ok: true, payer: result.body.payer };
}

export async function settlePayment(
  fetchImpl: typeof fetch,
  config: Config,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  idempotencyKey: string | null,
): Promise<{ ok: true; settlement: SettleResponse } | FacilitatorFailure> {
  const result = await postFacilitator<SettleResponse>(
    fetchImpl,
    `${config.facilitatorUrl}/settle`,
    {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    },
    idempotencyKey,
  );
  if (!result.ok) return result;
  const settlement = result.body;
  const pending = settlement.errorReason === "settlement_pending" && Boolean(settlement.transaction);
  if (!settlement.success && !pending) {
    return {
      ok: false,
      status: 402,
      message: settlement.errorReason
        ? `Settlement failed: ${settlement.errorReason}.`
        : "Settlement failed.",
    };
  }
  return {
    ok: true,
    settlement: {
      success: settlement.success || pending,
      errorReason: settlement.errorReason,
      payer: settlement.payer,
      transaction: settlement.transaction ?? "",
      network: settlement.network || config.network,
    },
  };
}
