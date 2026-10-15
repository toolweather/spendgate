# Glama listing

SpendGate's production server is the Cloudflare Worker at `https://spendgate.toolweather.workers.dev/mcp`. Glama's open-source registry ([toolweather/spendgate](https://glama.ai/mcp/servers/toolweather/spendgate)) builds a local process and introspects it over stdio. The root `Dockerfile` is that process.

The container exposes `score_spend`, `get_quota`, and `get_api_key` with the same schemas and descriptions as the Worker. Quota and keys live in memory for the process lifetime. It does not read `PAY_TO` and does not call the x402 facilitator. Worker pricing is unchanged.

`glama.json` claims the listing for the `toolweather` maintainer and carries the short description Glama should show: score a planned spend to `approve`, `ask_human`, or `block`; free tier, then x402 USDC on Base. After this file is on the default branch, open the server page, choose **Claim ownership**, then **Sync Server**.

## Dockerfile admin

If Glama builds the root `Dockerfile` itself, no extra settings are required. Do not set `PAY_TO`.

Glama's [Dockerfile admin](https://glama.ai/mcp/servers/toolweather/spendgate/admin/dockerfile) can instead generate an image, clone this repo into `/app`, and wrap the command with `mcp-proxy`. Use these form values:

| Field | Value |
| --- | --- |
| Build steps | `["npm ci --ignore-scripts", "npm run build:stdio"]` |
| CMD arguments | `["node", "dist/stdio.js"]` |
| Environment variables | none. Leave the schema empty. Do not set `PAY_TO` or any wallet key. |
| Placeholder parameters | `{}` |
| Pinned commit | empty, after **Sync Server** |

The generated command is `mcp-proxy -- node dist/stdio.js`. Stdout is newline-delimited JSON-RPC only. No environment variables are required for `initialize` and `tools/list`.

Deploy, then **Make Release** once the build test passes. That is the check [awesome-mcp-servers #16558](https://github.com/punkpeye/awesome-mcp-servers/pull/16558) is waiting on.

## Local check

```bash
docker build -t spendgate-stdio .
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"glama","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | docker run -i --rm spendgate-stdio
```

The tools list should be `score_spend`, `get_quota`, and `get_api_key`.
