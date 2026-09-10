// The agent loop. Emits the typed events from docs/API_CONTRACT.md.
//
// The model's job here is small and bounded: pick tools, then write prose over
// structured results it cannot edit. It never sees source code and never invents
// a fact. Everything it can cite came from a deterministic extractor.
import { findEntity, traceFrom, getEvidence, endpointCoverage, NARRATIVE_EDGES } from "../tools.mjs";
import { chat, chatStream, provider } from "./llm.mjs";

const MAX_ROUNDS = 6;

const SYSTEM = `You answer questions about the Procol codebase using ONLY the tools provided.

HOW TO WORK
1. find_entity to locate a starting node and get its id.
2. trace_from to follow execution. It crosses repo boundaries automatically.
3. get_evidence for every node you cite.

RULES — these are not style preferences, they are the point of the system.
- Never state a fact that did not come from a tool result. You have no knowledge of this
  codebase beyond the tools. Do not fall back on general knowledge of React or Rails.
- Cite file:line for every claim. If get_evidence returns no path for a node, say the node
  is an HTTP endpoint contract with no source location — do not invent one.
- If a trace result contains "unresolved" entries, you MUST report them. Say where the trace
  stops and why. An answer that looks complete when part of it is unresolvable is WRONG,
  even if everything you did say was true.
- If "truncated" is true, say the trace was bounded.
- If "hubs_not_expanded" is non-empty, name those nodes and say they were not expanded
  because too many things call them.
- If find_entity returns weak:true, say the match was approximate and name what you matched.
- If you have no evidence, say "I have no evidence for this." Do not guess.
- Always say which refs you read. Tenants run different code, so an answer about main is
  not an answer about reliance-main.`;

const TOOL_SCHEMAS = [
  { type: "function", function: { name: "find_entity",
      description: "Locate a node by name, fqn, or path fragment. Returns ids and a match_reason.",
      parameters: { type: "object", properties: {
        query: { type: "string" }, kind: { type: "string" },
        repo: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } } },
  { type: "function", function: { name: "trace_from",
      description: "Follow execution from a node id. Crosses repos. direction=reverse for impact.",
      parameters: { type: "object", properties: {
        entity_id: { type: "integer" },
        direction: { type: "string", enum: ["forward", "reverse"] },
        depth: { type: "integer" },
        min_confidence: { type: "string", enum: ["any", "low", "medium", "high"] },
        refs: { type: "array", items: { type: "string" } },
        expand_hubs: { type: "boolean" } }, required: ["entity_id"] } } },
  { type: "function", function: { name: "get_evidence",
      description: "Resolve node ids to repo, path, line, commit, ref, extractor.",
      parameters: { type: "object", properties: {
        ids: { type: "array", items: { type: "integer" } } }, required: ["ids"] } } },
  { type: "function", function: { name: "endpoint_coverage",
      description: "Counts of endpoints joined / called-but-not-served / served-but-not-called.",
      parameters: { type: "object", properties: {
        refs: { type: "array", items: { type: "string" } } } } } },
];

const HANDLERS = { find_entity: findEntity, trace_from: traceFrom, get_evidence: getEvidence,
                   endpoint_coverage: endpointCoverage };

/**
 * Runs one question. `emit(event)` receives the contract's typed events.
 * Returns a summary once done.
 */
export async function ask({ question, refs = ["main"], emit }) {
  const t0 = Date.now();
  const p = provider();
  const collectedEvidence = new Map();
  const collectedUnresolved = [];
  let toolCallCount = 0;

  if (p.mock) return mockRun({ question, refs, emit, t0 });

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Refs in scope: ${refs.join(", ")}\n\nQuestion: ${question}` },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    emit({ type: "status", text: round === 0 ? "looking up the code graph" : "following the trace" });
    const msg = await chat({ messages, tools: TOOL_SCHEMAS });
    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      // No more tools wanted: stream the final answer.
      const finalMessages = [...messages.slice(0, -1),
        { role: "user", content: "Write the final answer now, following the RULES exactly." }];
      let text = "";
      for await (const delta of chatStream({ messages: finalMessages })) {
        text += delta;
        emit({ type: "token", text: delta });
      }
      if (!text && msg.content) { emit({ type: "token", text: msg.content }); text = msg.content; }
      break;
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      // Never string-match a serialised tool input; escaping varies by model.
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* keep {} */ }
      if (name === "trace_from" && !args.refs) args.refs = refs;
      if (name === "endpoint_coverage" && !args.refs) args.refs = refs;

      emit({ type: "status", text: `${name}(${Object.values(args).slice(0, 2).join(", ").slice(0, 60)})` });
      toolCallCount++;

      let result;
      try {
        const fn = HANDLERS[name];
        result = fn ? await fn(args) : { error: `unknown tool ${name}` };
      } catch (e) {
        result = { error: `${e.name}: ${e.message}` };
      }

      // Surface the honesty signals to the CLIENT directly, not only to the model.
      // If the model omits them, the UI still shows them.
      for (const u of result?.unresolved ?? []) {
        collectedUnresolved.push(u);
        emit({ type: "unresolved", ...u });
      }
      if (result?.truncated) emit({ type: "truncated", reason: "node limit reached", at_depth: result.depth });
      for (const ev of result?.evidence ?? []) {
        collectedEvidence.set(String(ev.id), ev);
        emit({ type: "evidence", id: ev.id, repo: ev.repo, path: ev.path, line: ev.start_line,
               commit: ev.commit_sha?.slice(0, 8), ref: ev.refs, extractor: ev.extractor });
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 24000) });
    }
  }

  const summary = { type: "done", claim_count: 0, evidence_count: collectedEvidence.size,
                    tool_calls: toolCallCount, unresolved_count: collectedUnresolved.length,
                    refs, provider: `${p.base} ${p.model}`, ms: Date.now() - t0 };
  emit(summary);
  return summary;
}

/**
 * Mock provider: no model, no key. Runs a FIXED tool chain and emits every event
 * type in the contract so the dashboard module can be built and styled today.
 * It is deliberately obvious that it is a mock -- it must never be mistaken for
 * a real answer.
 */
async function mockRun({ question, refs, emit, t0 }) {
  emit({ type: "status", text: "MOCK PROVIDER — no model configured" });

  const found = await findEntity({ query: question.slice(0, 40), limit: 3 });
  emit({ type: "status", text: `find_entity → ${found.count} matches (weak: ${found.weak})` });

  let trace = { nodes: [], edges: [], unresolved: [], truncated: false, hubs_not_expanded: [] };
  const seed = found.matches.find((m) => m.kind === "HTTP_CALL_SITE") ?? found.matches[0];
  if (seed) {
    emit({ type: "status", text: `trace_from(${seed.id})` });
    trace = await traceFrom({ entity_id: Number(seed.id), refs, depth: 6 });
  }

  const ids = [seed?.id, ...trace.nodes.map((n) => n.id)].filter(Boolean).slice(0, 8).map(Number);
  const ev = ids.length ? await getEvidence({ ids }) : { evidence: [] };

  for (const e of ev.evidence) {
    emit({ type: "evidence", id: e.id, repo: e.repo, path: e.path, line: e.start_line,
           commit: e.commit_sha?.slice(0, 8), ref: e.refs, extractor: e.extractor });
  }
  for (const u of trace.unresolved ?? []) emit({ type: "unresolved", ...u });
  if (trace.truncated) emit({ type: "truncated", reason: "node limit reached", at_depth: trace.depth });

  const claims = [];
  if (seed) {
    claims.push({ id: "c1", text: `[MOCK] Entry point is ${seed.name || seed.fqn}.`,
                  evidence_ids: [Number(seed.id)], confidence: Number(seed.confidence) });
  }
  trace.nodes.slice(0, 6).forEach((n, i) => {
    claims.push({ id: `c${i + 2}`, text: `[MOCK] Step ${n.depth}: ${n.kind} ${n.name || n.fqn}.`,
                  evidence_ids: [Number(n.id)], confidence: 0.95 });
  });
  for (const c of claims) { emit({ type: "claim", ...c }); emit({ type: "token", text: c.text + " " }); }

  const summary = { type: "done", claim_count: claims.length, evidence_count: ev.evidence.length,
                    tool_calls: 3, unresolved_count: (trace.unresolved ?? []).length,
                    refs, provider: "mock", ms: Date.now() - t0 };
  emit(summary);
  return summary;
}
