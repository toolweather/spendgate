import { describe, expect, it } from "vitest";
import { TOOLS } from "./mcp.js";
import { createStdioSession, takeStdioMessages } from "./stdio.js";

function textBody(response: unknown): unknown {
  const rpc = response as {
    result?: { content?: { text: string }[]; isError?: boolean };
    error?: { code: number; data?: { error?: { code?: string } } };
  };
  if (rpc.error) return rpc.error;
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error("missing tool text");
  return JSON.parse(text) as unknown;
}

describe("stdio introspection", () => {
  it("lists the same tools as the Worker", async () => {
    const session = createStdioSession();
    const listed = (await session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: unknown };
    };
    expect(listed.result.tools).toEqual(TOOLS);
    expect(TOOLS.map((tool) => tool.name)).toEqual(["score_spend", "get_quota", "get_api_key"]);
  });

  it("scores with in-memory storage and does not configure x402", async () => {
    const previous = process.env.PAY_TO;
    process.env.PAY_TO = "0x1111111111111111111111111111111111111111";
    const session = createStdioSession();
    if (previous === undefined) delete process.env.PAY_TO;
    else process.env.PAY_TO = previous;
    expect(session.config.payTo).toBeNull();
    expect(session.config.priceAtomic).toBe("1000");
    expect(session.config.anonDailyLimit).toBe(100);

    const quota = textBody(
      await session.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_quota", arguments: {} },
      }),
    ) as { paid_configured: boolean; remaining_today: number };
    expect(quota.paid_configured).toBe(false);
    expect(quota.remaining_today).toBe(100);

    const scored = textBody(
      await session.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "score_spend",
          arguments: { amount: 0.2, category: "status_check", merchant: "https://www.cloudflare.com" },
        },
      }),
    ) as { verdict: string; score: number };
    expect(scored.verdict).toBe("approve");
    expect(scored.score).toBeGreaterThanOrEqual(80);
  });

  it("returns payment_not_configured instead of calling a facilitator when the free cap is gone", async () => {
    const session = createStdioSession();
    for (let i = 0; i < 100; i += 1) {
      await session.handle({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "score_spend", arguments: { amount: 0.2, category: "status_check" } },
      });
    }
    const denied = (await session.handle({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "score_spend", arguments: { amount: 0.2, category: "status_check" } },
    })) as { error?: { code: number; data?: { error?: { code?: string } } } };
    expect(denied.error?.code).toBe(-32002);
    expect(denied.error?.data?.error?.code).toBe("payment_not_configured");
  });

  it("reads newline JSON and Content-Length frames", () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const framed = `Content-Length: ${new TextEncoder().encode(ping).length}\r\n\r\n${ping}`;
    const mixed = `not json\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n${framed}`;
    const taken = takeStdioMessages(mixed);
    expect(taken.rest).toBe("");
    expect(taken.messages).toEqual([
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
    ]);

    const partial = takeStdioMessages('{"jsonrpc":"2.0","id":3,"method":"pi');
    expect(partial.messages).toEqual([]);
    const rest = takeStdioMessages(`${partial.rest}ng"}\n`);
    expect(rest.messages).toEqual([{ jsonrpc: "2.0", id: 3, method: "ping" }]);
  });
});
