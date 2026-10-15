import type { Config } from "./env.js";

export function llmsTxt(origin: string, config: Config): string {
  return `# SpendGate

> Score a planned spend before an autonomous agent pays. Verdicts are approve, ask_human, or block.

SpendGate is a decision check, not a wallet and not the payment itself. Call it before a tool moves money. The underlying merchant charge is still yours to make or refuse.

## When to use

- Before a crypto transfer, gift card, irreversible purchase, subscription, or paid API call.
- When a planner proposes a spend and you have a daily or monthly budget left. Pass that remaining budget. Over budget is a block.
- When the amount is under the free micro threshold (default $1) and you still want a recorded check. Those return approve unless they exceed a budget you supplied.
- Skip it for pure reads that do not spend. status_check is the low-risk category when you do call.

Do not reword purpose and retry to fish for approve. v1 scoring is deterministic.

## Verdicts

- approve: pay.
- ask_human: do not pay yet. Ask a person.
- block: do not pay.

## Free tier

- Anonymous: ${config.anonDailyLimit} scores per UTC day, no key.
- Free key: POST ${origin}/v1/keys, then Authorization: Bearer sg_live_…. ${config.keyDailyLimit} scores per UTC day.
- Toolweather bundle proxy: a matching x-tw-bundle-secret charges x-tw-bundle-client. A hex client (Toolweather API key hash) gets the free-key cap (${config.keyDailyLimit} scores per UTC day). An anonymous Toolweather caller whose client id starts with anon: gets the anonymous cap (${config.anonDailyLimit} scores per UTC day). get_quota still reports subject and tier bundle, with daily_limit set to that cap. A missing or wrong secret stays on the anonymous IP cap. An sg_live_ key still wins.
- After the cap, each score costs ${config.priceUsd} USDC on Base (${config.network}) via x402. Facilitator: ${config.facilitatorUrl}.
- get_quota, get_api_key, docs, and this file are not billed.
- Paid calls require PAY_TO on the server. If it is unset, over-cap scores return 402 payment_not_configured and do not invent a wallet.

## API

- [Score a spend](${origin}/v1/score): POST JSON { amount, currency?, category?, purpose?, merchant?, agent_id?, daily_budget_remaining?, monthly_budget_remaining?, risk_hints? }
- [Quota](${origin}/v1/quota): GET remaining free scores.
- [Mint a key](${origin}/v1/keys): POST { label? }
- [Policy](${origin}/v1/policy): GET the v1 formula.
- [OpenAPI](${origin}/openapi.json)
- [MCP server card](${origin}/.well-known/mcp)
- [x402 discovery](${origin}/.well-known/x402)

## MCP

Endpoint: ${origin}/mcp (streamable HTTP, protocol 2025-06-18).

Tools: score_spend, get_quota, get_api_key.

## Categories

High risk: crypto_transfer, irreversible, gift_card.
Medium risk: api_call, saas, infra.
Low risk: status_check.
Anything else is unknown risk.

## Optional later

Free spend watches are not in v1.
`;
}

export function llmsFull(origin: string, config: Config): string {
  return `${llmsTxt(origin, config)}
## Scoring v1

Start at 100.

- Amount penalty = min(75, round(25 * log10(1 + amount_usd))). Higher spend lowers the score.
- Merchant: known 0, unknown 18, missing 24. A non-https, IP, or local URL adds 12.
- PayCheck (POST ${config.paycheckUrl}/v1/check, field target) runs for a domain, https URL, or 0x payee that is not already on the local known-host list. The Worker uses the PAYCHECK service binding; the public URL is only a fallback. trusted counts as known. suspicious adds 30. block adds 42, forces block, and caps the score at 24, including under the micro threshold. unknown is not auto-trusted. If PayCheck is down or not OK, local merchant rules are used, detail.paycheck_error says why, and the score still returns.
- That PayCheck call is SpendGate's, not a second bill for the caller. It uses PAYCHECK_API_KEY when set, otherwise BUNDLE_PROXY_SECRET with SpendGate's own bundle client, otherwise PayCheck's anonymous free tier. The caller's key and x-tw-bundle-client are not forwarded.
- Category: low 0, medium 12, high 30, unknown 18.
- Currency: USD/USDC 0, USDT/DAI/USDP/PYUSD 6, other 12.
- Raising hints add 6 each, cap 18: new_payee, new_merchant, first_payment, high_velocity, mismatched_purpose, off_platform, shared_wallet.
- Lowering hints subtract 6 each, cap 12: trusted_repeat, within_policy, human_preapproved.
- known_merchant marks the payee known. Hints are self-reported.
- score >= 70 approve, >= 40 ask_human, else block.
- Over a supplied remaining budget: block, score capped at 24. This beats the micro rule.
- Strictly under the micro threshold ($${config.microThresholdUsd}): approve, score at least 80, unless a budget blocks.

Known merchant hosts are listed on GET ${origin}/v1/policy.

## x402 retry

1. POST ${origin}/v1/score with no payment.
2. If the free cap remains, you receive the score.
3. If not, HTTP 402 and a base64 PAYMENT-REQUIRED header (also mirrored in the JSON body).
4. Sign an EIP-3009 TransferWithAuthorization for the accepted requirement. Base mainnet USDC domain name is "USD Coin", version "2", asset ${config.asset}.
5. Retry with PAYMENT-SIGNATURE set to the base64 PaymentPayload (x402Version 2).
6. A successful settle returns the score and a PAYMENT-RESPONSE header.

The same nonce returns the original score and is not billed twice.
`;
}
