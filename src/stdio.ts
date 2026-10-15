import { readConfig, type Config } from "./env.js";
import { handleMcpMessage } from "./mcp.js";
import { mintKey, readQuota, scoreRequest } from "./service.js";
import { MemoryUsageStore } from "./store.js";

const MAX_BUFFER = 1_048_576;

export interface StdioSession {
  config: Config;
  handle(message: unknown): Promise<unknown | null>;
}

function emptyList(id: string | number | null, key: "resources" | "prompts" | "resourceTemplates") {
  return { jsonrpc: "2.0", id, result: { [key]: [] } };
}

/**
 * Glama starts this process with no wallet and no network it should use.
 * PAY_TO is ignored so a container env cannot reach the x402 facilitator.
 * fetch throws, so a PayCheck lookup fails open to the local merchant rules.
 */
export function createStdioSession(): StdioSession {
  const store = new MemoryUsageStore();
  const config = readConfig({});
  const fetchImpl: typeof fetch = async () => {
    throw new Error("SpendGate stdio introspection does not call payment rails.");
  };

  return {
    config,
    async handle(message: unknown): Promise<unknown | null> {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
      }
      const rpc = message as { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
      const id = rpc.id ?? null;
      if (rpc.method === "resources/list") return emptyList(id, "resources");
      if (rpc.method === "resources/templates/list") return emptyList(id, "resourceTemplates");
      if (rpc.method === "prompts/list") return emptyList(id, "prompts");

      const now = new Date();
      const result = await handleMcpMessage(rpc, {
        protocolVersion: "2025-06-18",
        score: (args) =>
          scoreRequest({
            store,
            config,
            fetchImpl,
            now,
            ip: "glama",
            authorization: null,
            apiKeyArgument: typeof args.api_key === "string" ? args.api_key : null,
            body: args,
            resourceUrl: "stdio://spendgate/score",
            paymentHeader: null,
            idempotencyKey: null,
          }),
        quota: (args) =>
          readQuota({
            store,
            config,
            authorization: null,
            apiKeyArgument: typeof args.api_key === "string" ? args.api_key : null,
            ip: "glama",
            now,
          }),
        mint: (args) => {
          const label =
            typeof args.label === "string" ? args.label.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || null : null;
          return mintKey({ store, config, ip: "glama", now, label });
        },
      });
      return result.body;
    },
  };
}

export function takeStdioMessages(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    if (/^content-length:/i.test(rest)) {
      const match = /\r?\n\r?\n/.exec(rest);
      if (!match || match.index === undefined) break;
      const header = rest.slice(0, match.index);
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      const bodyStart = match.index + match[0].length;
      if (!lengthMatch) {
        rest = rest.slice(bodyStart);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const decoded = sliceUtf8(rest.slice(bodyStart), length);
      if (!decoded) break;
      rest = decoded.tail;
      try {
        messages.push(JSON.parse(decoded.head));
      } catch {
        // Drop a framed body that is not JSON and keep reading.
      }
      continue;
    }

    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl).replace(/\r$/, "").trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Stdout from a wrapper sometimes includes a non-JSON banner. Skip it.
    }
  }
  return { messages, rest };
}

function sliceUtf8(value: string, byteLength: number): { head: string; tail: string } | null {
  if (!Number.isFinite(byteLength) || byteLength < 0) return { head: "", tail: value };
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < byteLength) return null;
  const decoder = new TextDecoder();
  return {
    head: decoder.decode(bytes.slice(0, byteLength)),
    tail: decoder.decode(bytes.slice(byteLength)),
  };
}

function runningAsCli(): boolean {
  const entry = String(process.argv[1] ?? "").replace(/\\/g, "/");
  return /(?:^|\/)stdio\.(?:js|ts)$/.test(entry);
}

export function startStdioServer(): void {
  const session = createStdioSession();
  let buffer = "";
  let chain: Promise<void> = Promise.resolve();

  const write = (body: unknown) => {
    process.stdout.write(`${JSON.stringify(body)}\n`);
  };

  const enqueue = (message: unknown) => {
    chain = chain
      .then(async () => {
        const body = await session.handle(message);
        if (body !== null && body !== undefined) write(body);
      })
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : "SpendGate stdio failed";
        process.stderr.write(`${messageText}\n`);
        write({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "SpendGate failed" } });
      });
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      buffer = "";
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } });
      return;
    }
    const taken = takeStdioMessages(buffer);
    buffer = taken.rest;
    for (const message of taken.messages) enqueue(message);
  });
  process.stdin.on("end", () => {
    void chain.then(() => {
      process.exit(0);
    });
  });
}

if (runningAsCli()) startStdioServer();
