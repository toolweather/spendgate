# SpendGate

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
| Merchant | Known host or `known_merchant` hint: 0. Unknown: 18. Missing: 24. Non-https, IP, or local URL: +12. |
| Category | High 30: `crypto_transfer`, `irreversible`, `gift_card`. Medium 12: `api_call`, `saas`, `infra`. Low 0: `status_check`. Anything else: 18. |
| Currency | `USD` and `USDC`: 0. `USDT`, `DAI`, `USDP`, `PYUSD`: 6. Other: 12. Default `USDC`. |
| Risk hints | Raising hints add 6 each, cap 18. Lowering hints subtract 6 each, cap 12. Hints are self-reported. |

Thresholds after penalties: **70** approve, **40** ask a human, below that block.

Hard overrides, applied after the raw score:

1. Amount greater than `daily_budget_remaining` or `monthly_budget_remaining` forces `block` and caps the published score at 24. Omitted budgets are not checked. Equal to the remaining budget is allowed.
2. Otherwise, amount strictly under the micro threshold forces `approve` and raises the published score to at least 80.

`agent_id` is echoed and not scored.

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

Tools: `score_spend`, `get_quota`, `get_api_key`.

After the free cap, `tools/call` on `score_spend` returns HTTP 402 with a JSON-RPC error (`-32002`) and the `PAYMENT-REQUIRED` header. `get_quota` and `get_api_key` stay free.

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

`BUNDLE_PROXY_SECRET` must be the same value as on the Toolweather Worker. Set it after merge, then redeploy. Do not commit the value. Until that secret is set, proxied calls without an `sg_live_…` key keep sharing the anonymous daily bucket.

`npm run dry-run` bundles the Worker the way a deploy would, without publishing.

To host the HTML on Pages by itself: `npx wrangler pages deploy public`. The API still needs the Worker. Serving both from the Worker is the setup `wrangler.toml` uses.

`database_id` in `wrangler.toml` is a placeholder UUID. Replace it before a real remote deploy. Do not put a production wallet in `[vars]`.
