// Provider-agnostic LLM client. Everything speaks the OpenAI-compatible /v1/chat/completions shape,
// so a local Ollama, a project key, or the platform gateway are the SAME code and three env vars:
//   LLM_BASE_URL=http://slingring.procol.tech/v1  LLM_MODEL=FAST_SMALLER  LLM_API_KEY=sk-...
//   LLM_BASE_URL=mock                              (no model, no key -- for FE development)
//
// Resilience (measured need: the gateway answers the same one-word request in 0.1 s or hangs for
// 2+ minutes, unpredictably, while the other model answers in 11 s at the same moment):
//   LLM_FIRST_BYTE_MS  an attempt with no first token by then is a stall (default 20 s)
//   LLM_HEDGE_MS       launch a duplicate attempt after this long without a first token (default 8 s);
//                      first token wins, the loser is aborted
//   LLM_TIMEOUT_MS     hard cap per attempt (default 90 s)
//   LLM_ATTEMPTS       attempts in total (default 3)
//   LLM_FALLBACK_MODEL model used from the 2nd attempt on (default: none). A congested model is congested
//                      for its duplicate too; a different model is the real escape hatch.
// Every call streams, even "whole reply" ones: a non-streaming reply only arrives when generation is
// complete, so a first-byte deadline would kill slow-but-healthy replies. Streaming makes the first byte
// the first token, which is what a stall detector must watch.

const cfg = () => {
  const BASE = process.env.LLM_BASE_URL || "mock";
  return { BASE, MODEL: process.env.LLM_MODEL || (BASE === "mock" ? "mock" : "unspecified"),
           KEY: process.env.LLM_API_KEY || "", AZURE_VERSION: process.env.LLM_AZURE_API_VERSION || "",
           FALLBACK: process.env.LLM_FALLBACK_MODEL || "" };
};
export const provider = () => { const c = cfg(); return { base: c.BASE, model: c.MODEL, mock: c.BASE === "mock", fallback: c.FALLBACK || null }; };

const TIMEOUT_MS = () => Number(process.env.LLM_TIMEOUT_MS    || 90000);
const FIRST_BYTE = () => Number(process.env.LLM_FIRST_BYTE_MS || 12000);
const BREAKER_MS = () => Number(process.env.LLM_BREAKER_MS    || 180000);   // after a primary stall, hedge immediately for this long

// Circuit breaker: the moment the primary model stalls, remember it. While the breaker is open, every call
// launches the fallback at t=0 alongside the primary, so a congested spell costs one fallback latency per
// call instead of two deadlines. The primary still competes and wins the moment it recovers.
let primaryStalledAt = 0;
export const llmStatus = () => ({ breaker_open: Date.now() - primaryStalledAt < BREAKER_MS(), primary_stalled_at: primaryStalledAt || null });
export const _resetBreaker = () => { primaryStalledAt = 0; };   // tests only
const HEDGE_MS   = () => Number(process.env.LLM_HEDGE_MS      || 6000);
const FALLBACK_FIRST_BYTE = () => Number(process.env.LLM_FALLBACK_FIRST_BYTE_MS || 30000);   // last resort: be patient with it
const FALLBACK_EFFORT = () => process.env.LLM_FALLBACK_REASONING_EFFORT ?? "minimal";       // "" to omit the parameter
// LUNA reasons at length and its reasoning tokens count against max_tokens: at 1500 it returned NO TEXT in 6 of 8
// probes (finish_reason=length). Give the fallback several times the primary's budget so text actually appears.
const FALLBACK_BUDGET = (n) => Math.min(Number(process.env.LLM_FALLBACK_MAX_TOKENS || 8000), Math.max(n * 3, 6000));
const ATTEMPTS   = () => Number(process.env.LLM_ATTEMPTS      || 3);

function endpoint() {
  const { BASE, AZURE_VERSION } = cfg();
  return AZURE_VERSION ? `${BASE}/chat/completions?api-version=${AZURE_VERSION}` : `${BASE}/chat/completions`;
}
function headers() {
  const { KEY, AZURE_VERSION } = cfg();
  const h = { "content-type": "application/json" };
  if (!KEY) return h;
  if (AZURE_VERSION) h["api-key"] = KEY; else h.authorization = `Bearer ${KEY}`;
  return h;
}

/**
 * Incremental reader over an OpenAI-style SSE body that yields CONTENT deltas only. Tracks finish_reason
 * and any other delta keys (e.g. reasoning_content) for diagnostics, and copes with a gateway that answers a
 * stream request with one JSON body (a whole completion, or an error wrapped in HTTP 200).
 */
class ContentReader {
  constructor(reader, model) { this.reader = reader; this.model = model; this.dec = new TextDecoder(); this.buf = ""; this.queue = []; this.ended = false; this.finish = null; this.other = new Set(); this.probed = false; this.chars = 0; }
  async next() {
    for (;;) {
      if (this.queue.length) { const d = this.queue.shift(); this.chars += d.length; return d; }
      if (this.ended) return null;
      const { done, value } = await this.reader.read();
      if (done) { this.ended = true; continue; }
      if (!this.probed) {
        this.probed = true;
        const head = new TextDecoder().decode(value);
        if (!/^\s*(data:|:|event:)/.test(head)) {            // not an event stream: read it all, act on what it is
          let body = head;
          for (;;) { const r = await this.reader.read(); if (r.done) break; body += this.dec.decode(r.value, { stream: true }); }
          this.ended = true;
          let j = null; try { j = JSON.parse(body); } catch { /* not json */ }
          if (j?.error) throw new Error(`LLM body error: ${JSON.stringify(j.error).slice(0, 300)}`);
          const content = j?.choices?.[0]?.message?.content;
          if (typeof content === "string" && content) { console.error(`[llm] ${this.model} answered a stream request with a JSON completion; using it`); this.queue.push(content); continue; }
          throw new Error(`LLM returned a non-SSE body: ${body.slice(0, 200)}`);
        }
      }
      this.buf += this.dec.decode(value, { stream: true });
      const lines = this.buf.split("\n"); this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { this.ended = true; break; }
        try {
          const ch = JSON.parse(payload).choices?.[0] ?? {};
          if (ch.finish_reason) this.finish = ch.finish_reason;
          for (const [k, v] of Object.entries(ch.delta ?? {})) if (v && k !== "content" && k !== "role") this.other.add(k);
          if (ch.delta?.content) this.queue.push(ch.delta.content);
        } catch { /* keep-alive or partial frame */ }
      }
    }
  }
  emptyReason() { return `LLM produced no text (finish_reason=${this.finish ?? "none"}${this.other.size ? `, delta keys: ${[...this.other].join(",")}` : ""}) -- likely the token budget went to hidden reasoning, or an empty completion`; }
}

/** Start one streaming attempt; resolve once the FIRST CONTENT TOKEN has arrived. An empty completion rejects. */
function attempt(body) {
  const controller = new AbortController();
  const overall = setTimeout(() => controller.abort(new Error("attempt timeout")), TIMEOUT_MS());
  const p = (async () => {
    const res = await fetch(endpoint(), { method: "POST", headers: headers(), signal: controller.signal, body: JSON.stringify(body) });
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`LLM ${res.status}: ${t.slice(0, 400)}`); }
    const it = new ContentReader(res.body.getReader(), body.model);
    const first = await it.next();
    if (first === null) throw new Error(it.emptyReason());
    return { it, first, controller, overall, model: body.model };
  })();
  p.controller = controller;
  return p;
}
const withDeadline = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no first token in ${ms} ms`)), ms))]);

/**
 * Primary-preferred race. A reasoning model sends NOTHING while it thinks and then the whole answer, so its
 * first content token means "done thinking" -- often 5-12 s on a big payload while perfectly healthy. A hedge
 * that could win on speed would steal healthy answers for the fallback model, so: the hedge (fallback model, or
 * the same model if none) launches after HEDGE_MS -- or at once while the breaker is open -- but is only USED
 * when the primary fails (stall, empty completion, HTTP error) or misses its deadline. Losers are aborted.
 */
async function raceFirstByte(primaryBody, hedgeBody) {
  const attempts = [];
  const launch = (body, ms) => { const a = attempt(body); attempts.push(a); return withDeadline(a, ms); };
  const delay = llmStatus().breaker_open ? 0 : HEDGE_MS();
  const primary = launch(primaryBody, FIRST_BYTE());
  let hedgeTimer = null, hedge = null;
  // a hedge on a DIFFERENT model is the last resort and gets the patient deadline; a same-model duplicate does not
  const hedgeDeadline = hedgeBody.model !== primaryBody.model ? FALLBACK_FIRST_BYTE() : FIRST_BYTE();
  const hedgeReady = new Promise((resolve) => { hedgeTimer = setTimeout(() => { hedge = launch(hedgeBody, hedgeDeadline); hedge.catch(() => {}); resolve(); }, delay); });
  primary.catch(() => { if (primaryBody.model === cfg().MODEL) primaryStalledAt = Date.now(); });   // open the breaker
  let winner;
  try { winner = await primary; }
  catch {
    try { await hedgeReady; winner = await hedge; }
    catch (e2) { for (const a of attempts) a.controller.abort(new Error("all attempts failed")); throw e2; }
  } finally { if (hedge === null) clearTimeout(hedgeTimer); }
  for (const a of attempts) if (a.controller !== winner.controller) a.controller.abort(new Error("lost the race"));
  return winner;
}

async function withRetries(fn) {
  let last;
  for (let i = 0; i < ATTEMPTS(); i++) {
    try { return await fn(i); }
    catch (e) { last = e; if (/LLM 4\d\d/.test(String(e.message))) throw e; }   // auth / bad request: do not retry
  }
  throw last;
}

/** Final answer (or any round), streamed token by token when the gateway streams. */
export async function* chatStream({ messages, tools, temperature = 0.1, max_tokens = 2000, reasoning_effort = null }) {
  const { BASE, MODEL, FALLBACK } = cfg();
  if (BASE === "mock") return;
  // LLM_REASONING_EFFORT (none | minimal | low | medium | high) caps hidden thinking on reasoning models so text
  // arrives sooner and the budget is not spent before any text appears. The fallback model gets its own setting.
  const primaryEffort = reasoning_effort || process.env.LLM_REASONING_EFFORT;
  const bodyFor = (model) => {
    const isFallback = FALLBACK && model === FALLBACK && model !== MODEL;
    const eff = isFallback ? FALLBACK_EFFORT() : primaryEffort;
    return { model, messages, temperature, max_tokens: isFallback ? FALLBACK_BUDGET(max_tokens) : max_tokens, stream: true,
             ...(eff && eff !== "none" ? { reasoning_effort: eff } : {}),
             ...(tools?.length ? { tools, tool_choice: "auto" } : {}) };
  };
  // attempt 0: primary, hedged by the fallback. later attempts: fallback first, primary as the hedge.
  const { it, first, overall, model } = await withRetries((i) =>
    i === 0 || !FALLBACK ? raceFirstByte(bodyFor(MODEL), bodyFor(FALLBACK || MODEL)) : raceFirstByte(bodyFor(FALLBACK), bodyFor(MODEL)));
  chatStream.lastModel = model;                       // agent reports when a fallback model answered
  try {
    yield first;
    for (;;) { const d = await it.next(); if (d === null) return; yield d; }
  } finally { clearTimeout(overall); }
}

/** One round returned whole -- over the same streaming, hedged, failover path. */
export async function chat({ messages, tools, temperature = 0.1, max_tokens = 2000, reasoning_effort = null }) {
  if (cfg().BASE === "mock") throw new Error("mock provider: use mockRound() instead");
  let content = "";
  for await (const d of chatStream({ messages, tools, temperature, max_tokens, reasoning_effort })) content += d;
  return { content };
}
