# SpendGate

[![Toolweather](https://toolweather.toolweather.workers.dev/badge/io.github.toolweather/spendgate.svg)](https://toolweather.pages.dev/servers/io.github.toolweather--spendgate/)

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/toolweather/spendgate)

SpendGate helps an autonomous agent decide whether to approve a planned spend **before** it pays.

It returns a score from 0 to 100, a verdict of `approve`, `ask_human`, or `block`, short reasons, a `recommended_action`, and `checked_at`. The score is deterministic. Rewording the purpose will not fish for a better verdict.

SpendGate does not send the merchant payment and does not hold a wallet key. Overage fees, when configured, are x402 USDC payments on Base to the `PAY_TO` address you set.

## When an agent should use it

Call `score_spend` or `POST /v1/score` before a tool transfers crypto, buys a gift card, starts a subscription, or pays an API or merchant.

- Pass the amount in **USD**, the category, the merchant or endpoint URL, and any daily or monthly budget you still have. If the amount is over a budget you supply, the verdict is `block`.
- `approve` means pay. `ask_human` means stop and ask a person. `block` means do not pay.
- Amounts strictly under the free micro threshold (default **$1**) return `approve`, unless they exceed a budget you passed in.
- Skip it for pure reads that do not spend. If you do check a health probe, use category `status_check`.
- Keep your own hard cap. SpendGate is a second look, not the only lock.
- Do not retry with a softer purpose to change the score. v1 does not store the body, and the math does not depend on prose.

Free spend watches are not in v1.

## Scoring v1

Start at 100, then subtract. Policy version `1`. Full constants: `GET /v1/policy`.

| Input | Effect |
| --- | --- |
| Amount | `min(75, round(25 * log10(1 + usd)))`. Higher spend lowers the score. |
| Merchant | Known host or `known_merchant` hint: 0. Unknown: 18. Missing: 24. Non-https, IP, or local URL: +12. PayCheck `suspicious`: 30. PayCheck `block`: 42, verdict `block`, score at most 24. |
| Category | High 30: `crypto_transfer`, `irreversible`, `gift_card`. Medium 12: `api_call`, `saas`, `infra`. Low 0: `status_check`. Anything else: 18. |
| Currency | `USD` and `USDC`: 0. `USDT`, `DAI`, `USDP`, `PYUSD`: 6. Other: 12. Default `USDC`. |
| Risk hints | Raising hints add 6 each, cap 18. Lowering hints subtract 6 each, cap 12. Hints are self-reported. |

Thresholds after penalties: **70** approve, **40** ask a human, below that block.

Hard overrides, applied after the raw score:

1. Amount greater than `daily_budget_remaining` or `monthly_budget_remaining` forces `block` and caps the published score at 24. Omitted budgets are not checked. Equal to the remaining budget is allowed.
2. Otherwise, amount strictly under the micro threshold forces `approve` and raises the published score to at least 80.

`agent_id` is echoed and not scored.

### Authorized wallet

Pass `from_wallet` (the `0x` account that would sign or pay gas) when the spend leaves a wallet. Omit it and the verdict is unchanged, including for callers that already integrate `POST /v1/score`.

`allowed_wallets` on the call is the allowlist for that check. An empty array authorizes no wallet. When the field is omitted, an `sg_live_` key uses the list stored by `set_wallet_allowlist` (`POST /v1/wallet-allowlist`). That route replaces one row per key and does not consume a score. A key with no stored row has no allowlist.

| Case | Verdict | Reason |
| --- | --- | --- |
| Published Hardhat, Anvil, Ganache, BIP-39 test, or Truffle tutorial account (indexes 0–9), even if that address is on the allowlist, and even under $1 | `block` | `dev_wallet` |
| `from_wallet` is not on the effective allowlist | `block` | `unauthorized_wallet` |
| `from_wallet` is set and there is no allowlist on the call or the key | `ask_human` | `wallet_unverified` |
| `from_wallet` is on the allowlist and is not a published dev account | unchanged | none |

`wallet_unverified` does not turn an existing budget or PayCheck block into `ask_human`. A wallet block caps the published score at 24, same as the other hard blocks.

The response includes `payment_source`: `from_wallet`, `allowlisted`, `checked_at`, and `reason`. `allowlisted` is list membership, so a dev account that was named on the list is still `dev_wallet` with `allowlisted: true`. `signature` is a lowercase HMAC-SHA256 hex over those claims and the verdict. It is added only when `BUNDLE_PROXY_SECRET` is already set. No new secret is required, and `PAY_TO` is not a signing key.

Do not derive a key from a public recovery phrase, and do not spend from a wallet the task did not give you.

This free call returns `block` with reason `unauthorized_wallet`. The payer is not the allowlisted account, and the amount is under the $1 micro threshold that would otherwise approve:

```bash
curl -s 'https://spendgate.toolweather.workers.dev/v1/score?src=x' \
  -H 'content-type: application/json' \
  -d '{"amount":0.4,"currency":"USDC","category":"crypto_transfer","purpose":"deploy on sepolia","from_wallet":"0x2222222222222222222222222222222222222222","allowed_wallets":["0x3333333333333333333333333333333333333333"]}'
```

### PayCheck

When the merchant is a domain, an http(s) URL, or a `0x` wallet, and it is not already a public https host on the local known-host list, SpendGate calls [PayCheck](https://paycheck.toolweather.workers.dev) `POST /v1/check` with `{ "target": "..." }`. The deployed Worker uses the `PAYCHECK` service binding (`service = "paycheck"`). A public `*.workers.dev` fetch from another worker on the same account fails, so that URL is only the fallback for tests and for a process with no binding.

| PayCheck verdict | SpendGate |
| --- | --- |
| `trusted` | Known merchant, same as the allowlist or `known_merchant`. |
| `unknown` | Today's unknown-merchant handling. Not auto-trusted. |
| `suspicious` | Merchant penalty 30 (plus 12 if the URL is insecure). Not known. |
| `block` | Merchant penalty 42 (plus 12 if insecure). Verdict `block`, published score at most 24, including under the $1 micro threshold. |

`openai.com` and the other `KNOWN_HOST_SUFFIXES` stay known with no network call, so a PayCheck outage does not change them. Any other PayCheck failure (timeout, non-OK, bad JSON) falls back to the local merchant rules and `score_spend` still returns a score. `detail.paycheck_error` is `timeout`, `http_status:<code>`, `parse`, or `network` on that fallback, and the Worker logs `paycheck lookup failed: …`. A raw IP or `http` URL keeps the insecure penalty on that fallback.

The lookup is SpendGate's internal call, not a second charge to the caller. It does not forward the caller's `sg_live_` key or `x-tw-bundle-client`. Auth, in order: optional `PAYCHECK_API_KEY`; else `BUNDLE_PROXY_SECRET` with SpendGate's own bundle client `7370656e6467617465` (hex for `spendgate`, 1,000 PayCheck checks per UTC day); else PayCheck's anonymous free tier (100 per UTC day). No new secret is required. `PAYCHECK_URL` defaults to `https://paycheck.toolweather.workers.dev`.

## Free tier and x402

| Tier | Cap | How |
| --- | --- | --- |
| Anonymous | 100 scores / UTC day | No key |
| Free key | 1,000 scores / UTC day | `POST /v1/keys` |
| Toolweather key (hex client) | 1,000 scores / UTC day | Matching `x-tw-bundle-secret` plus a hex `x-tw-bundle-client` |
| Toolweather anonymous caller | 100 scores / UTC day | Matching secret plus an `anon:` client id. Same cap as anonymous. `get_quota` still reports subject and tier `bundle`. |
| Overage | $0.001 USDC per score | x402 on Base after the cap |

The Toolweather Worker proxies `score_spend`, `get_quota`, and `spendgate_get_api_key` to this server. When it sends `x-tw-bundle-secret` equal to this Worker's `BUNDLE_PROXY_SECRET`, quota is charged to `x-tw-bundle-client`. A hex client (a Toolweather API key hash, 16–128 hex characters; a longer value uses a stable 128-character prefix) gets the free-key cap of 1,000 scores per UTC day. An anonymous Toolweather caller (`anon:` plus that hash) gets the same 100 scores per UTC day as a direct anonymous caller, so a rotating egress address does not mint a fresh 1,000-score bucket. `get_quota` reports subject and tier `bundle` for both, with `daily_limit` set to the cap that applies. The raw client id is not stored. A presented `sg_live_…` key still wins. A missing, unset, or wrong secret keeps the anonymous IP bucket and does not return an error just because the headers are absent. Key minting through the proxy uses the same client id for the daily mint cap.

- Network `eip155:8453` (Base mainnet).
- Asset USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (EIP-712 name `USD Coin`, version `2`).
- Facilitator [https://facilitator.payai.network](https://facilitator.payai.network) (`POST /verify`, then `POST /settle`).
- Price is 1000 atomic units (6 decimals).
- Quota reads, key mints, docs, and MCP discovery are not billed.
- Set `PAY_TO` to the 0x address that should receive USDC. If it is unset, over-cap scores return `402` with `payment_not_configured`. The server will not invent a wallet.

A paid retry:

1. `POST /v1/score` with no payment header.
2. Read HTTP 402 and the base64 `PAYMENT-REQUIRED` header (the JSON body mirrors it).
3. Sign EIP-3009 `TransferWithAuthorization` for the accepted requirement.
4. Retry with `PAYMENT-SIGNATURE` set to the base64 x402 v2 payment payload.
5. The score comes back with `PAYMENT-RESPONSE` after settle. The same nonce returns the original score and does not settle again.

## API

```bash
curl -s http://127.0.0.1:43123/v1/score \
  -H 'content-type: application/json' \
  -d '{
    "amount": 12,
    "currency": "USDC",
    "category": "api_call",
    "purpose": "embeddings for the planner",
    "merchant": "https://api.openai.com/v1",
    "agent_id": "agent_planner",
    "daily_budget_remaining": 40,
    "risk_hints": []
  }'
```

```bash
curl -s http://127.0.0.1:43123/v1/keys \
  -H 'content-type: application/json' \
  -d '{"label":"planner"}'

curl -s http://127.0.0.1:43123/v1/quota \
  -H "authorization: Bearer sg_live_..."
```

Other routes:

- `GET /health`
- `POST /v1/waitlist` with `{ "email", "source"? }`. Stores a lowercased address once. No email is sent.
- `GET /v1/waitlist/count` returns `{ "count" }` and no addresses.
- `GET /v1/policy`
- `GET /openapi.json`
- `GET /llms.txt` and `GET /llms-full.txt`
- `GET /.well-known/mcp` (and `/.well-known/mcp.json`)
- `GET /.well-known/x402`
- `POST /mcp` streamable HTTP, protocol `2025-06-18` (also accepts `2025-03-26`)

### MCP

```bash
curl -s http://127.0.0.1:43123/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example","version":"0"}}}'

curl -s http://127.0.0.1:43123/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"score_spend","arguments":{"amount":0.2,"category":"status_check","merchant":"https://www.cloudflare.com","agent_id":"agent_demo"}}}'
```

Tools: `score_spend`, `get_quota`, `get_api_key`, `set_wallet_allowlist`.

After the free cap, `tools/call` on `score_spend` returns HTTP 402 with a JSON-RPC error (`-32002`) and the `PAYMENT-REQUIRED` header. The error names the SpendGate Pro waitlist (`https://spendgate.toolweather.workers.dev/pro` on this deployment). `waitlist_url` is on the JSON body, not inside the x402 payload. `get_quota`, `get_api_key`, and `set_wallet_allowlist` stay free.

## Run locally

Requires Node 20+.

```bash
npm install
npx wrangler d1 migrations apply spendgate --local
npm run dev
```

The site and API listen on [http://127.0.0.1:43123](http://127.0.0.1:43123).

Optional receiving wallet, in `.dev.vars` (gitignored, copy from `.dev.vars.example`):

```bash
PAY_TO=0xYourAddress
```

```bash
npm test
npm run typecheck
```

## Deploy

Free Cloudflare plan: one Worker, one D1 database, static assets from `public/`. No paid SaaS and no secrets in the repo.

```bash
npx wrangler d1 create spendgate
# Put the returned database_id in wrangler.toml (the committed id is a placeholder).
npx wrangler d1 migrations apply spendgate --remote
npx wrangler secret put PAY_TO
npx wrangler secret put BUNDLE_PROXY_SECRET
npx wrangler deploy
```

The Pro waitlist page is [https://spendgate.toolweather.workers.dev/pro](https://spendgate.toolweather.workers.dev/pro). The signup count, with no addresses, is `GET https://spendgate.toolweather.workers.dev/v1/waitlist/count`. Apply the remote migrations before deploy so `waitlist` and `wallet_allowlist` exist. `migrations/0004_wallet_allowlist.sql` is the per-key allowlist. Do not put `PAY_TO` or `BUNDLE_PROXY_SECRET` in the repo, and do not change those secrets for this migration. Scores that omit `from_wallet` keep working before `0004` is applied. `set_wallet_allowlist` and the stored-list fallback need the new table.

```bash
npx wrangler d1 migrations apply spendgate --remote
npx wrangler deploy
```

`BUNDLE_PROXY_SECRET` must be the same value as on the Toolweather Worker. Set it after merge, then redeploy. Do not commit the value. Until that secret is set, proxied calls without an `sg_live_…` key keep sharing the anonymous daily bucket. The same secret, when set, also attributes SpendGate's PayCheck lookups to SpendGate's internal bundle client. `PAYCHECK_URL` is already in `[vars]`. `PAYCHECK_API_KEY` is optional (`npx wrangler secret put PAYCHECK_API_KEY`) and is not required for the anonymous PayCheck tier.

`npm run dry-run` bundles the Worker the way a deploy would, without publishing.

To host the HTML on Pages by itself: `npx wrangler pages deploy public`. The API still needs the Worker. Serving both from the Worker is the setup `wrangler.toml` uses.

`database_id` in `wrangler.toml` is a placeholder UUID. Replace it before a real remote deploy. Do not put a production wallet in `[vars]`.