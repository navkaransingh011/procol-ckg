// The gateway stalls intermittently. These tests fake `fetch` to prove the client does not wait for a
// stalled request: it hedges with a duplicate, takes the first byte that arrives, and aborts the loser.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LLM_BASE_URL = "http://fake.local/v1";
process.env.LLM_MODEL = "FAKE";
process.env.LLM_API_KEY = "sk-test";
process.env.LLM_HEDGE_MS = "150";
process.env.LLM_FIRST_BYTE_MS = "600";
process.env.LLM_FALLBACK_FIRST_BYTE_MS = "900";
process.env.LLM_TIMEOUT_MS = "2000";
process.env.LLM_ATTEMPTS = "2";
const { chat, chatStream, _resetBreaker } = await import("../src/service/llm.mjs");

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
const streamRes = (text, delayMs, signal) => new Response(new ReadableStream({
  start(ctl) {
    const t = setTimeout(() => { ctl.enqueue(new TextEncoder().encode(sse(text))); ctl.close(); }, delayMs);
    signal?.addEventListener("abort", () => { clearTimeout(t); try { ctl.error(new Error("aborted")); } catch {} });
  } }), { status: 200 });
const stalled = (signal) => new Promise((_, rej) => signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));

const withFetch = async (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } };

test("a stalled first request is hedged; the duplicate's answer is used within the hedge window", async () => {
  _resetBreaker();
  let calls = 0; const aborted = [];
  const t0 = Date.now();
  const out = await withFetch(async (_url, init) => {
    calls++;
    init.signal.addEventListener("abort", () => aborted.push(calls));
    if (calls === 1) return stalled(init.signal);            // never answers
    return streamRes("hello", 20, init.signal);              // the hedge answers fast
  }, async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
  assert.equal(out, "hello");
  assert.equal(calls, 2, "exactly one hedge was launched");
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms; should be hedge (150) + small`);
  assert.ok(aborted.length >= 1, "the stalled request was aborted");
});

test("a fast first request wins and no hedge is ever sent", async () => {
  _resetBreaker();
  let calls = 0;
  const out = await withFetch(async (_u, init) => { calls++; return streamRes("quick", 10, init.signal); },
    async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
  await new Promise(r => setTimeout(r, 250));               // past the hedge window: still only one call
  assert.equal(out, "quick"); assert.equal(calls, 1);
});

test("chat() (whole reply) rides the same streaming, hedged path", async () => {
  _resetBreaker();
  let calls = 0;
  const m = await withFetch(async (_u, init) => { calls++; if (calls === 1) return stalled(init.signal); return streamRes("{\"ok\":true}", 20, init.signal); },
    () => chat({ messages: [] }));
  assert.equal(m.content, "{\"ok\":true}"); assert.equal(calls, 2);
});

test("both attempts stalling fails fast (first-byte deadline), not after the 90 s hard timeout", async () => {
  _resetBreaker();
  const t0 = Date.now();
  await assert.rejects(withFetch(async (_u, init) => stalled(init.signal), () => chat({ messages: [] })));
  const took = Date.now() - t0;
  assert.ok(took < 2000, `took ${took} ms`);                // ATTEMPTS=2 x (hedge + first-byte) worst case ~1.5 s here
});

test("a 4xx is not retried", async () => {
  _resetBreaker();
  let calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return new Response("bad key", { status: 401 }); }, () => chat({ messages: [] })), /LLM 401/);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(calls <= 2, `calls=${calls}`);                  // the initial + at most the already-scheduled hedge
});

test("the hedge goes to the fallback model, and one stall opens the breaker so the next call hedges at once", async () => {
  _resetBreaker();
  process.env.LLM_FALLBACK_MODEL = "OTHER";
  const { llmStatus } = await import("../src/service/llm.mjs");
  try {
    let bodies = [];
    const t0 = Date.now();
    const out = await withFetch(async (_u, init) => { const b = JSON.parse(init.body); bodies.push([b.model, Date.now() - t0]);
      if (b.model === "FAKE") return stalled(init.signal); return streamRes("fb", 10, init.signal); },
      async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
    assert.equal(out, "fb");
    assert.deepEqual(bodies.map(b => b[0]), ["FAKE", "OTHER"], "primary first, fallback as the hedge");
    assert.ok(bodies[1][1] >= 140, `hedge launched after the hedge delay (${bodies[1][1]} ms)`);
    // wait for the primary's deadline to fire so the breaker opens
    await new Promise(r => setTimeout(r, 700));
    assert.equal(llmStatus().breaker_open, true, "breaker opened after the primary stalled");
    bodies = []; const t1 = Date.now();
    await withFetch(async (_u, init) => { const b = JSON.parse(init.body); bodies.push([b.model, Date.now() - t1]);
      if (b.model === "FAKE") return stalled(init.signal); return streamRes("fb2", 10, init.signal); },
      async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
    assert.ok(bodies.some(b => b[0] === "OTHER" && b[1] < 100), `with the breaker open the fallback launched immediately (${JSON.stringify(bodies)})`);
  } finally { delete process.env.LLM_FALLBACK_MODEL; }
});

test("a slow-but-alive primary beats a faster hedge: reasoning models are silent while thinking", async () => {
  process.env.LLM_FALLBACK_MODEL = "OTHER";
  try {
    const out = await withFetch(async (_u, init) => {
      const b = JSON.parse(init.body);
      if (b.model === "FAKE") return streamRes("primary-answer", 350, init.signal);   // first byte at 350 ms (< 600 deadline)
      return streamRes("hedge-answer", 5, init.signal);                                 // hedge answers almost instantly at ~155 ms
    }, async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
    assert.equal(out, "primary-answer");
  } finally { delete process.env.LLM_FALLBACK_MODEL; }
});

const emptyRes = (delayMs, signal) => new Response(new ReadableStream({ start(ctl) {
  const t = setTimeout(() => { ctl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`)); ctl.close(); }, delayMs);
  signal?.addEventListener("abort", () => clearTimeout(t)); } }), { status: 200 });

test("an empty completion (finish_reason=length, no text) is a failed attempt: the hedge's text is used", async () => {
  process.env.LLM_FALLBACK_MODEL = "OTHER";
  try {
    const out = await withFetch(async (_u, init) => { const b = JSON.parse(init.body);
      if (b.model === "FAKE") return emptyRes(30, init.signal); return streamRes("real-text", 10, init.signal); },
      async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
    assert.equal(out, "real-text");
  } finally { delete process.env.LLM_FALLBACK_MODEL; }
});

test("every attempt empty -> a clear error naming the finish_reason, not a blank answer", async () => {
  await assert.rejects(withFetch(async (_u, init) => emptyRes(5, init.signal), () => chat({ messages: [] })), /produced no text.*finish_reason=length/);
});

test("the fallback model gets its own reasoning_effort", async () => {
  process.env.LLM_FALLBACK_MODEL = "OTHER"; process.env.LLM_REASONING_EFFORT = "minimal"; process.env.LLM_FALLBACK_REASONING_EFFORT = "low";
  const efforts = {};
  try {
    await withFetch(async (_u, init) => { const b = JSON.parse(init.body); efforts[b.model] = b.reasoning_effort;
      if (b.model === "FAKE") return stalled(init.signal); return streamRes("x", 5, init.signal); },
      () => chat({ messages: [] }));
    assert.deepEqual(efforts, { FAKE: "minimal", OTHER: "low" });
  } finally { delete process.env.LLM_FALLBACK_MODEL; delete process.env.LLM_REASONING_EFFORT; delete process.env.LLM_FALLBACK_REASONING_EFFORT; }
});

test("from the second attempt on, the fallback model is used when configured", async () => {
  _resetBreaker();
  process.env.LLM_FALLBACK_MODEL = "OTHER";
  const models = [];
  try {
    const out = await withFetch(async (_u, init) => {
      const body = JSON.parse(init.body); models.push(body.model);
      // attempt 1 (and its hedge) stall; the retry on the fallback model answers
      if (body.model === "FAKE") return stalled(init.signal);
      return streamRes("from-fallback", 10, init.signal);
    }, async () => { let t = ""; for await (const d of chatStream({ messages: [] })) t += d; return t; });
    assert.equal(out, "from-fallback");
    assert.ok(models.includes("OTHER"), `models tried: ${models}`);
    assert.equal(chatStream.lastModel, "OTHER");
  } finally { delete process.env.LLM_FALLBACK_MODEL; }
});
