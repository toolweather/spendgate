# Installing SpendGate (remote MCP server, nothing to run locally)

SpendGate is a hosted MCP server. No package or build is required.

Add this to your MCP settings (e.g. Cline `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "spendgate": {
      "type": "streamableHttp",
      "url": "https://spendgate.toolweather.workers.dev/mcp?src=site"
    }
  }
}
```

Optional: for 1,000 free scores/day instead of 100, get a free key with `curl -X POST https://spendgate.toolweather.workers.dev/v1/keys` and add `"headers": {"Authorization": "Bearer <key>"}`.

Verify: call `score_spend` with `{"amount":0.2,"category":"status_check","merchant":"https://www.cloudflare.com"}`. Expect verdict `approve`.

Tools: `score_spend` (approve / ask_human / block before paying), `get_quota`, `get_api_key`.
