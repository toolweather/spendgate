// @ts-nocheck
// Shared source counters. Copy this file (sources.ts here, sources.js in other
// workers) to toolweather, upstream, and paycheck, and keep the table shapes
// and exclusion rules the same.
// source_daily: one aggregated row per (day, src, tool, outcome). No per-call rows, no PII.
// source_callers: one aggregated row per (day, src, caller_hash, outcome). Does not replace source_daily.
// caller_hash is SHA-256 of (UTC day + ":" + API key, or CF-Connecting-IP when there is no key),
// truncated to CALLER_HASH_HEX. Raw IPs and keys are not stored. Rows exist only after deploy
// of the source_callers migration; there is no backfill.
export const SOURCE_TAGS = ["smithery", "glama", "mcpservers", "registry", "awesome", "x", "devto", "hn", "site", "direct"];
const INTERNAL_UA = /toolweather|upstreambot|mcp-health-probe/i;
const CALLER_HASH_HEX = 16;
const CALLER_PREFIX_HEX = 8;
const TOP_CALLERS = 10;
const OUTCOMES = ["ok", "error", "limit"];

export const SOURCES_SQL = `CREATE TABLE IF NOT EXISTS source_daily (
  day TEXT NOT NULL,
  src TEXT NOT NULL,
  tool TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, src, tool, outcome)
);
CREATE TABLE IF NOT EXISTS source_callers (
  day TEXT NOT NULL,
  src TEXT NOT NULL,
  caller_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, src, caller_hash, outcome)
);`;

const NOTE = "Successful tool calls (ok) are counted separately from errors and limit/402 responses. Internal probes, test keys (SOURCES_EXCLUDE_KEY_HASHES), and box IPs (SOURCES_EXCLUDE_IP_HASHES) are excluded. src=direct means no ?src tag. A caller is a truncated SHA-256 of the UTC day plus the API key, or plus CF-Connecting-IP when no key is present. Raw IPs and keys are not stored. The same client is a new caller each UTC day. unique_callers counts those hashes for that day and src. unique_ok, unique_error, and unique_limit count callers with that outcome. top_callers groups by an 8-character prefix, at most 10. Caller rows start at the deploy that added source_callers; earlier calls are not backfilled.";

export function normalizeSrc(raw) {
  if (raw == null || raw === "") return "direct";
  const v = String(raw).trim().toLowerCase();
  return SOURCE_TAGS.includes(v) ? v : "other";
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requestKey(req, url) {
  return req.headers.get("x-api-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("key") || "";
}

function clientIp(req) {
  return (req.headers.get("cf-connecting-ip") || "").trim();
}

function prefixList(raw) {
  return String(raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function hashListed(value, list) {
  if (!value || !list.length) return false;
  const h = await sha256Hex(value);
  return list.some((x) => h.startsWith(x));
}

async function isInternal(req, url, env) {
  if (INTERNAL_UA.test(req.headers.get("user-agent") || "")) return true;
  if (await hashListed(requestKey(req, url), prefixList(env.SOURCES_EXCLUDE_KEY_HASHES))) return true;
  // IP hash is of the address alone, so a static prefix can exclude this box without storing the IP.
  if (await hashListed(clientIp(req), prefixList(env.SOURCES_EXCLUDE_IP_HASHES))) return true;
  return false;
}

function limitish(s) { return /quota|rate.?limit|limit (reached|exceeded)|payment required|\b402\b|x402|daily_limit|limit_reached/i.test(s); }

function classifyRpc(msg) {
  if (!msg || typeof msg !== "object") return "error";
  if (msg.error) return limitish(JSON.stringify(msg.error)) || msg.error.code === 402 ? "limit" : "error";
  const r = msg.result;
  if (r && r.isError) return limitish(JSON.stringify(r).slice(0, 4000)) ? "limit" : "error";
  return "ok";
}

async function mcpTool(req) {
  try {
    const body = await req.clone().json();
    const msgs = Array.isArray(body) ? body : [body];
    const m = msgs.find((x) => x && x.method === "tools/call");
    if (!m) return null;
    return { tool: String((m.params && m.params.name) || "unknown").slice(0, 64), id: m.id };
  } catch { return null; }
}

async function classifyMcpResponse(res, id) {
  if (res.status === 402 || res.status === 429) return "limit";
  if (res.status >= 400) return "error";
  try {
    const text = await res.clone().text();
    const ct = res.headers.get("content-type") || "";
    let msgs = [];
    if (ct.includes("text/event-stream")) {
      for (const line of text.split("\n")) if (line.startsWith("data:")) { try { msgs.push(JSON.parse(line.slice(5))); } catch {} }
    } else {
      const j = JSON.parse(text); msgs = Array.isArray(j) ? j : [j];
    }
    const m = msgs.find((x) => x && x.id === id) || msgs[0];
    return classifyRpc(m);
  } catch { return "error"; }
}

function classifyRest(res) {
  if (res.status === 402 || res.status === 429) return "limit";
  return res.status >= 200 && res.status < 400 ? "ok" : "error";
}

function blankCounts() {
  return { ok: 0, error: 0, limit: 0 };
}

function addCount(bucket, outcome, n) {
  if (OUTCOMES.includes(outcome)) bucket[outcome] += n;
}

function callerGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.day + "\0" + r.src;
    let g = groups.get(key);
    if (!g) {
      g = {
        day: r.day,
        src: r.src,
        counts: blankCounts(),
        seen: new Set(),
        byOutcome: { ok: new Set(), error: new Set(), limit: new Set() },
        callers: new Map(),
      };
      groups.set(key, g);
    }
    const n = Number(r.n) || 0;
    addCount(g.counts, r.outcome, n);
    const hash = String(r.caller_hash || "");
    g.seen.add(hash);
    if (g.byOutcome[r.outcome]) g.byOutcome[r.outcome].add(hash);
    const prefix = hash.slice(0, CALLER_PREFIX_HEX);
    let c = g.callers.get(prefix);
    if (!c) {
      c = { hash: prefix, n: 0, ...blankCounts() };
      g.callers.set(prefix, c);
    }
    c.n += n;
    addCount(c, r.outcome, n);
  }
  return [...groups.values()].map((g) => ({
    day: g.day,
    src: g.src,
    ok: g.counts.ok,
    error: g.counts.error,
    limit: g.counts.limit,
    unique_callers: g.seen.size,
    unique_ok: g.byOutcome.ok.size,
    unique_error: g.byOutcome.error.size,
    unique_limit: g.byOutcome.limit.size,
    top_callers: [...g.callers.values()].sort((a, b) => b.n - a.n || a.hash.localeCompare(b.hash)).slice(0, TOP_CALLERS),
  })).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.src.localeCompare(b.src)));
}

export async function sourcesSummary(env, days = 7) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    "SELECT day, src, tool, outcome, n FROM source_daily WHERE day >= ? ORDER BY day DESC, src, tool, outcome"
  ).bind(since).all();
  const totals = {};
  for (const r of results || []) {
    const t = (totals[r.src] ||= { ok: 0, error: 0, limit: 0 });
    t[r.outcome] = (t[r.outcome] || 0) + r.n;
  }
  const callerRows = await env.DB.prepare(
    "SELECT day, src, caller_hash, outcome, n FROM source_callers WHERE day >= ? ORDER BY day DESC, src, caller_hash, outcome"
  ).bind(since).all();
  return {
    since,
    days,
    note: NOTE,
    tags: SOURCE_TAGS,
    totals,
    rows: results || [],
    callers: callerGroups(callerRows.results || []),
  };
}

// restTools: array of [RegExp on "METHOD /path", toolName]
export function withSources(fetchHandler: any, restTools: any[] = []): (req: Request, env: any, ctx: any) => Promise<Response> {
  return async function (req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/sources" && req.method === "GET") {
      try {
        return new Response(JSON.stringify(await sourcesSummary(env)), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=60" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "sources_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      }
    }
    let target = null;
    if (url.pathname === "/mcp" && req.method === "POST") {
      const t = await mcpTool(req);
      if (t) target = { ...t, mcp: true };
    } else {
      const sig = req.method + " " + url.pathname;
      for (const [re, tool] of restTools) if (re.test(sig)) { target = { tool, mcp: false }; break; }
    }
    const res = await fetchHandler(req, env, ctx);
    if (!target || !env.DB) return res;
    const record = (async () => {
      try {
        if (await isInternal(req, url, env)) return;
        const outcome = target.mcp ? await classifyMcpResponse(res, target.id) : classifyRest(res);
        const day = new Date().toISOString().slice(0, 10);
        const src = normalizeSrc(url.searchParams.get("src"));
        await env.DB.prepare(
          "INSERT INTO source_daily (day, src, tool, outcome, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, src, tool, outcome) DO UPDATE SET n = n + 1"
        ).bind(day, src, target.tool, outcome).run();
        const identity = requestKey(req, url) || clientIp(req);
        const callerHash = (await sha256Hex(day + ":" + identity)).slice(0, CALLER_HASH_HEX);
        await env.DB.prepare(
          "INSERT INTO source_callers (day, src, caller_hash, outcome, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, src, caller_hash, outcome) DO UPDATE SET n = n + 1"
        ).bind(day, src, callerHash, outcome).run();
      } catch {}
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(record); else await record;
    return res;
  };
}
