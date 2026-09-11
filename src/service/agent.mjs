// The agent loop. Emits the typed events from docs/API_CONTRACT.md.
//
// The model's job here is small and bounded: pick tools, then write prose over
// structured results it cannot edit. It never sees source code and never invents
// a fact. Everything it can cite came from a deterministic extractor.
import { findEntity, traceFrom, getEvidence, endpointCoverage, resolveScope, listEntities, ownersOf, getSummaries, endpointFamily, readSource, grepSource, semanticAnchor, NARRATIVE_EDGES } from "../tools.mjs";
import { q } from "../db.mjs";
import { runSql, SCHEMA_DOC } from "../sqltool.mjs";
import { chat, chatStream, provider } from "./llm.mjs";

const MAX_ROUNDS = 6;

// 'guided'  the SERVICE runs the tool chain; the model only writes prose over results
//           it cannot influence. Works with ANY model, including weak free tiers,
//           because nothing depends on the model calling tools correctly.
// 'agent'   the model chooses tools. Needs a capable model; fails closed if it
//           answers without calling any.
const mode = () => process.env.LLM_MODE || "guided";

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
export async function ask({ question, refs = ["main"], emit, style = "auto" }) {
  const t0 = Date.now();
  const p = provider();
  const collectedEvidence = new Map();
  const collectedUnresolved = [];
  let toolCallCount = 0;
  const intent = resolveIntent(question, style);           // 'simple' | 'code'
  emit({ type: "intent", intent, chosen: style });

  if (p.mock) return mockRun({ question, refs, emit, t0 });
  if (mode() === "sql") return sqlRun({ question, refs, emit, t0, p });
  if (mode() === "auto") return routeAuto({ question, refs, emit, t0, p, intent });
  if (mode() === "plan") return planRun({ question, refs, emit, t0, p, intent });
  if (mode() === "guided") return guidedRun({ question, refs, emit, t0, p, intent });

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Refs in scope: ${refs.join(", ")}\n\nQuestion: ${question}` },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    emit({ type: "status", text: round === 0 ? "looking up the code graph" : "following the trace" });
    const msg = await chat({ messages, tools: TOOL_SCHEMAS });
    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (!calls.length && round === 0) {
      // Fail closed. A model that answers without touching the graph is answering
      // from generic React/Rails knowledge -- which is the exact failure this system
      // exists to prevent. Do not let that reach the user as an answer.
      emit({ type: "error", code: "model_skipped_tools",
             message: "The model answered without querying the code graph, so the answer "
                    + "would not be grounded in your codebase. Set LLM_MODE=guided to have "
                    + "the service run the tool chain instead." });
      const summary = { type: "done", claim_count: 0, evidence_count: 0, tool_calls: 0,
                        unresolved_count: 0, refs, provider: `${p.base} ${p.model}`,
                        ms: Date.now() - t0, failed: "model_skipped_tools" };
      emit(summary);
      return summary;
    }
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

  const edgeInto = new Map((trace.edges || []).map((e) => [String(e.dst), e.kind]));
  const claims = [];
  if (seed) {
    claims.push({ id: "c1", text: `[MOCK] Entry point is ${seed.name || seed.fqn}.`,
                  kind: seed.kind, name: seed.name || seed.fqn, path: seed.path,
                  line: seed.start_line, edge: null, depth: 0,
                  evidence_ids: [Number(seed.id)], confidence: Number(seed.confidence) });
  }
  trace.nodes.slice(0, 6).forEach((n, i) => {
    claims.push({ id: `c${i + 2}`, text: `[MOCK] Step ${n.depth}: ${n.kind} ${n.name || n.fqn}.`,
                  kind: n.kind, name: n.name || n.fqn, path: n.path, line: n.line,
                  edge: edgeInto.get(String(n.id)) || null, depth: n.depth,
                  evidence_ids: [Number(n.id)], confidence: 0.95 });
  });
  for (const c of claims) { emit({ type: "claim", ...c }); emit({ type: "token", text: c.text + " " }); }

  const summary = { type: "done", claim_count: claims.length, evidence_count: ev.evidence.length,
                    tool_calls: 3, unresolved_count: (trace.unresolved ?? []).length,
                    refs, provider: "mock", ms: Date.now() - t0 };
  emit(summary);
  return summary;
}


// ---- anchoring: turn a plain-English question into the ONE graph node to start from.
// Deterministic. Pulls identifier-like tokens out of the question, most specific first
// (Class#method, /routes, file paths, CamelCase, snake_case, then words), and prefers an
// exact name hit over any fuzzy match. This is where "semantic query" lives before any LLM.
const STOP = new Set(("what does the when which how is are a an of to in into and or that this do did it its for with from on by " +
  "happens happen serves serve served called call calls code path paths lead leads table contain contains route routes file " +
  "function method class where who why can should would about show me tell explain describe list all any").split(" "));

function candidates(question) {
  const toks = (question.match(/\/[\w/.:*-]+|[A-Za-z_][\w:#.$/-]*/g) || [])
    .map((t) => t.replace(/[?!,.:;]+$/, ""))
    .filter((t) => t.length >= 3 && !STOP.has(t.toLowerCase()));
  const specificity = (t) =>
    (/[#.]/.test(t) && /[A-Z]/.test(t) ? 5 : 0) + (t.startsWith("/") ? 4 : 0) +
    (/[a-z][A-Z]/.test(t) ? 3 : 0) + (/_/.test(t) || /\.\w+$/.test(t) ? 3 : 0) + Math.min(t.length, 30) / 30;
  return [...new Set(toks)].sort((a, b) => specificity(b) - specificity(a));
}

const SEED_PREF = ["HTTP_CALL_SITE", "HANDLER", "HTTP_ENDPOINT", "DB_TABLE", "SYMBOL", "OBSERVED_DEFECT"];
const pickSeed = (ms) => SEED_PREF.map((k) => ms.find((m) => m.kind === k)).find(Boolean) ?? ms[0];

export async function anchor(question, refs) {
  const cands = candidates(question);
  // pass 1: an exact name/fqn hit on any token wins outright
  for (const t of cands) {
    const f = await findEntity({ query: t, limit: 10, refs });
    const exact = f.matches.filter((m) =>
      m.match_reason === "exact_fqn" ||
      (m.name && m.name.toLowerCase() === t.toLowerCase()) ||
      (/[/.]/.test(t) && m.match_reason === "path_substring" && m.path && m.path.toLowerCase().endsWith(t.toLowerCase())));
    if (exact.length) return { seed: pickSeed(exact), token: t, weak: false };
  }
  // pass 2: best fuzzy hit on the most specific token that matches anything
  for (const t of cands) {
    const f = await findEntity({ query: t, limit: 10, refs });
    if (f.matches.length) return { seed: pickSeed(f.matches), token: t, weak: true };
  }
  const f = await findEntity({ query: question, limit: 10, refs });
  return f.matches.length ? { seed: pickSeed(f.matches), token: question, weak: true } : { seed: null, token: null, weak: true };
}

/**
 * GUIDED MODE — the service owns the tool chain; the model only narrates.
 *
 * This removes the single biggest risk with a cheap or free model: it cannot skip
 * the graph, cannot pick the wrong tool, and cannot decline to report the gaps,
 * because the gaps are computed here and emitted before it is asked anything.
 * The model's only job is turning structured facts into a readable paragraph.
 */
async function guidedRun({ question, refs, emit, t0, p, intent = "code" }) {
  emit({ type: "status", text: "searching the code graph" });

  // 1. anchor
  const { seed, token, weak } = await anchor(question, refs);
  if (!seed) {
    emit({ type: "token", text: "I have no evidence for this. Nothing in the indexed code graph "
                               + "matches that question, so I cannot answer it from your codebase." });
    const summary = { type: "done", claim_count: 0, evidence_count: 0, tool_calls: 1,
                      unresolved_count: 0, refs, provider: `${p.base} ${p.model}`, ms: Date.now() - t0 };
    emit(summary);
    return summary;
  }
  const found = { weak };
  if (weak) emit({ type: "status", text: `approximate match on "${token}": ${seed.name || seed.fqn} (${seed.match_reason})` });
  else emit({ type: "status", text: `anchored on ${seed.kind.toLowerCase().replace(/_/g, " ")} ${seed.name || seed.fqn}` });

  // If the anchor itself cannot be resolved, say so -- and if it is a call site, list its
  // unresolvable siblings in the same file, because that is the question the user is really asking.
  if (seed.resolution === "AMBIGUOUS") {
    emit({ type: "unresolved", fqn: seed.fqn, path: seed.path, line: seed.start_line,
           reason: "path built at runtime; not statically resolvable" });
  }
  if (seed.kind === "HTTP_CALL_SITE" && seed.path) {
    const sibs = await q(`select fqn, path, start_line from ckg.entities
                           where kind='HTTP_CALL_SITE' and resolution='AMBIGUOUS' and path=$1 and id<>$2
                             and encode(commit_sha,'hex') = any($3::text[]) order by start_line limit 12`,
                         [seed.path, seed.id, (await resolveScope(refs)).commits]);
    for (const sb of sibs) emit({ type: "unresolved", fqn: sb.fqn, path: sb.path, line: sb.start_line,
                                  reason: "path built at runtime; not statically resolvable" });
  }

  // 2. trace both ways
  emit({ type: "status", text: `tracing from ${seed.name || seed.fqn}` });
  const fwd = await traceFrom({ entity_id: Number(seed.id), refs, depth: 6, direction: "forward" });
  const rev = await traceFrom({ entity_id: Number(seed.id), refs, depth: 3, direction: "reverse" });

  // 3. evidence for everything we will cite
  // Upstream callers are handed to the model, so they must be citable too -- otherwise
  // it can name a file the UI has no evidence chip for. Anything we send, we prove.
  const ids = [Number(seed.id),
               ...fwd.nodes.map((n) => Number(n.id)),
               ...rev.nodes.slice(0, 10).map((n) => Number(n.id))].slice(0, 35);
  const ev = await getEvidence({ ids });
  for (const e of ev.evidence) {
    emit({ type: "evidence", id: e.id, repo: e.repo, path: e.path, line: e.start_line,
           commit: e.commit_sha?.slice(0, 8), ref: e.refs, extractor: e.extractor });
  }

  // 4. the gaps -- emitted BEFORE the model is asked anything, so they reach the
  //    client whether or not the model mentions them.
  for (const u of fwd.unresolved ?? []) emit({ type: "unresolved", ...u });
  if (fwd.truncated) emit({ type: "truncated", reason: "node limit reached", at_depth: fwd.depth });
  if (fwd.hubs_not_expanded?.length) {
    emit({ type: "status", text: `not expanded through hubs: ${fwd.hubs_not_expanded.join(", ")}` });
  }

  // 5. structured claims, built from the graph -- not from the model
  // Which edge brought us to each node -- lets the UI label the connectors
  // (TARGETS / SERVES / HANDLED_BY) instead of drawing anonymous arrows.
  const edgeInto = new Map(fwd.edges.map((e) => [String(e.dst), e.kind]));

  const claims = [{
    id: "c1",
    text: `${seed.kind} ${seed.name || seed.fqn}`
        + (seed.path ? ` at ${seed.path}${seed.start_line ? ":" + seed.start_line : ""}` : ""),
    kind: seed.kind, name: seed.name || seed.fqn, path: seed.path, line: seed.start_line,
    edge: null, depth: 0,
    evidence_ids: [Number(seed.id)],
    confidence: Number(seed.confidence),
  }];
  fwd.nodes.forEach((n, i) => claims.push({
    id: `c${i + 2}`,
    text: `${n.kind} ${n.name || n.fqn}`
        + (n.path ? ` at ${n.path}${n.line ? ":" + n.line : ""}` : ""),
    kind: n.kind, name: n.name || n.fqn, path: n.path, line: n.line,
    edge: edgeInto.get(String(n.id)) || null, depth: n.depth,
    evidence_ids: [Number(n.id)],
    confidence: 0.95,
  }));
  for (const c of claims) emit({ type: "claim", ...c });

  // 6. the model's ONLY job
  const facts = {
    question, refs,
    anchor: { kind: seed.kind, name: seed.name || seed.fqn, path: seed.path,
              line: seed.start_line, match_reason: seed.match_reason, attrs: seed.attrs },
    downstream: fwd.nodes.map((n) => ({ depth: n.depth, kind: n.kind, name: n.name || n.fqn,
                                        path: n.path, line: n.line })),
    upstream_callers: rev.nodes.slice(0, 10).map((n) => ({ kind: n.kind, name: n.name || n.fqn,
                                                           path: n.path, line: n.line })),
    edge_chain: fwd.edges.map((e) => e.kind),
    unresolved: fwd.unresolved ?? [],
    truncated: !!fwd.truncated,
    hubs_not_expanded: fwd.hubs_not_expanded ?? [],
    approximate_match: !!found.weak,
  };

  const prompt = `Write a short answer to the question using ONLY the JSON facts below.

STRICT RULES
- Use only what is in the JSON. Invent nothing. You do not know this codebase otherwise.
- Cite path:line exactly as given. A null path means an HTTP endpoint contract with no
  source file -- say that, do not invent a path.
- If "unresolved" is non-empty you MUST say the trace stops there and why.
- If "truncated" is true, say the trace was bounded.
- If "hubs_not_expanded" is non-empty, name them and say they were skipped because too
  many things call them.
- If "approximate_match" is true, open by saying the match was approximate.
- Write for a colleague, not a log: describe what the code does and where. Do NOT narrate the
  mechanics -- never write "the anchor is", "the unresolved list is empty", "truncated is false",
  "no hubs were skipped", "the match was exact". Mention unresolved/truncated/hubs ONLY when they
  are non-empty or true, in one sentence at the end.
- End with the refs read (${refs.join(", ")}) in a short trailing clause.
- 6 sentences maximum. No preamble, no bullet lists.

FACTS
${JSON.stringify(facts, null, 1).slice(0, 12000)}`;

  emit({ type: "status", text: `writing the ${intent === "simple" ? "plain-English" : ""} answer (${p.model})`.replace("  ", " ") });
  const guidedSystem = intent === "simple"
    ? "You explain software to a non-engineer in plain, warm English. Use ONLY the JSON facts. Lead with what the user does and what happens. Prefer product words over code words. 3-5 sentences, then an optional short 'In the code' line naming real files from the facts. Invent nothing; if the facts fall short, say so."
    : SYSTEM;
  let text = "";
  try {
    for await (const delta of chatStream({
      messages: [{ role: "system", content: guidedSystem }, { role: "user", content: prompt }],
      max_tokens: 700,
    })) { text += delta; emit({ type: "token", text: delta }); }

    if (!text) {  // provider does not support streaming -- fall back to one shot
      const msg = await chat({ messages: [{ role: "system", content: SYSTEM },
                                          { role: "user", content: prompt }], max_tokens: 700 });
      text = msg.content || "";
      if (text) emit({ type: "token", text });
    }
  } catch (e) {
    emit({ type: "error", code: "llm_failed", message: e.message });
  }

  // The claims and evidence above are already on the wire, so a model failure
  // degrades to a structured answer without prose -- never to no answer at all.
  if (!text) {
    emit({ type: "token",
           text: "(No prose available - the language model call failed. The claims and "
               + "evidence above come from the code graph and are unaffected.)" });
  }

  emitContextPaths(JSON.stringify(facts), emit);
  await emitRefsFooter(refs, emit);
  const summary = { type: "done", claim_count: claims.length, evidence_count: ev.evidence.length,
                    tool_calls: 4, unresolved_count: (fwd.unresolved ?? []).length,
                    refs, provider: `${p.base} · ${p.model}`, mode: "guided", ms: Date.now() - t0 };
  emit(summary);
  return summary;
}


// =====================================================================================
// PLAN MODE — plan -> retrieve -> answer. For hard questions that need several anchors.
//
// The model never emits tool-call JSON (weak models are unreliable at that). It emits a
// short PLAN of things to look up; the service resolves each deterministically; the model
// then writes over the combined facts. Two model calls, zero chances to skip the graph.
// =====================================================================================
export const PLAN_SYSTEM = `You plan lookups against a code knowledge graph of two repositories:
procol-backend (Rails) and procol-client-dashboard (React). The graph contains: Ruby classes/modules/
methods (named "Class#method" or "Class.method"), Rails routes and their handler actions
("api/v1/trade#quote_details"), HTTP endpoints ("/v1/trade/*/quote_details"), database tables and columns,
frontend HTTP call sites (by file path, e.g. "src/redux/orders/api.js"), external services, CI jobs,
and execution-confirmed defects. It does NOT contain method bodies or comments.

Given a question, output ONLY a JSON object -- no prose, no markdown fences:
{"lookups": [{"q": "<one specific identifier>"}],
 "lists":   [{"kind": "<ENTITY_KIND>", "path_prefix": "<optional dir>", "name_contains": "<optional>", "subkind": "<optional, see note>"}],
 "sql": ["<one read-only SELECT against v_nodes / v_edges when no lookup shape above fits; optional>"],
 "endpoint_families": ["<URL path prefix, e.g. /approval_workflow/approval_requests>"],
 "greps": ["<exact code token to find every occurrence of, e.g. self.mcp? or token_type>"],
 "want_source": <true if answering needs the actual code: any "why", "how does it decide", "what does it check",
                 "what would happen if", "which guards/conditions", or an explanation of behaviour>,
 "want_summaries": <true if the question asks for an overview, big picture, or "what does X do">,
 "want_owners": <true if the question asks who built, owns, or should be asked about something>}

Use "sql" only when the fixed shapes cannot express what you need (a join, a count, a filter on attrs).
Schema for "sql":
${SCHEMA_DOC}
Use "endpoint_families" when the question is about all the callers or handlers of a URL family.
Use "greps" for "every place that ..." questions about a concrete token; the grep runs on the exact
indexed commit and returns file:line with context. Prefer distinctive tokens (self.mcp?, not "session").

Use "lists" whenever the question asks for EVERY, ALL, WHICH ONES, or HOW MANY of something --
point lookups cannot enumerate a set. Entity kinds available:
FEATURE (product capability), PERSON (contributor), SYMBOL (Ruby class/module/method),
HANDLER (controller action), SERVER_ROUTE, HTTP_ENDPOINT, HTTP_CALL_SITE (frontend),
DB_TABLE, EXTERNAL_SERVICE, CI_JOB, FILE, OBSERVED_DEFECT.
Examples: all features -> {"kind":"FEATURE"}; everything under a directory ->
{"kind":"SYMBOL","path_prefix":"app/services/awarding"}.
NOTE on EXTERNAL_SERVICE: it holds two different things. Runtime integrations the product calls live
under lib/external_api (use {"kind":"EXTERNAL_SERVICE","path_prefix":"lib/external_api"}); CI build-time
actions have subkind "github_action". Ask for the one the question means, or both and distinguish them.

Rules for lookups (max 8):
- ALWAYS include, verbatim and as its own lookup, every capitalised proper noun or product name in the
  question (e.g. "Clara", "Session", "Pundit", "Sidekiq") and every token containing # . / or ::.
  Missing the proper noun is the most common way to answer the wrong question.
- One identifier per lookup. Specific beats generic: "Api::V1::TradeController#quote_details" beats "trade controller".
- For a route, use the path with * for params: "/v1/trade/*/quote_details". For a table, the bare table name.
- For a Ruby method use "Class#method" (instance) or "Class.method" (class method). For a class, its name.
- For frontend code, use the file path fragment, e.g. "src/redux/orders/api.js".
- For cross-repo questions include BOTH ends: the frontend file or route AND the backend handler/method.
- If the question names a bug or behaviour, look up the method most likely to contain it.
- Order lookups by importance. Be terse: no explanations, no "why" fields, no prose -- the JSON only.
- If CANDIDATE NODES are provided with the question, they are real graph names ranked by meaning. Prefer them
  as lookups when they fit the question; add your own only for what they miss.
- Lists must be specific: a path_prefix needs at least two segments (app/services/awarding, src/redux/approvals),
  never a repo root like "src" or "app/controllers". Prefer name_contains for a topic word ("approval").
- For "how does X work" / "what is X" / overview questions: set want_summaries true, look up the FEATURE and the
  main frontend file, and add one endpoint_family for the URL prefix the feature uses.`;

const ANSWER_SYSTEM = `You are a senior engineer answering questions about Procol's codebase from a VERIFIED code
knowledge graph. You will receive FACTS as JSON. You know nothing about this codebase except those facts.

HOW TO READ THE FACTS
- A list's "by_subkind" splits the set by subtype. EXTERNAL_SERVICE mixes runtime integrations
  (path lib/external_api) with CI actions (subkind github_action) -- never report a combined count as
  "the external services the backend integrates with"; separate them.
- "planned_sql" holds rows from queries the planner wrote, with evidence attached for any entity ids.
  Treat them like lists: exact rows from the database, citable via their evidence.
- "lists" are COMPLETE SETS from the database. If a list has complete:true, you may state its count and
  enumerate it as exhaustive ("all 39 external services are: ..."). If complete:false, say how many of how
  many you are showing. A list is far stronger evidence of completeness than a point lookup.
- "overviews" are cached, human-reviewed-quality summaries at system/feature altitude. Lead with them for
  "what does X do" or "big picture" questions, then add specifics from the lookups.
- An activity block's "file_touches_12mo" is the SUM of per-file commit counts, not a number of
  commits: one commit touching 40 files scores 40. Use it to rank how active something is
  ("the busiest area"), never to state "N commits".
- "owners" comes from git history: who has touched this area and how recently. Use it to answer
  "who should I ask", and always say it is derived from commit history, not a formal ownership registry.
- Each lookup has an "anchor" (the node matched), "downstream" (execution path hops, each with kind, name,
  path, line, the edge that led there, "edge_resolution" = how the CONNECTION is known, and
  "node_resolution" = how the NODE is known), "upstream_callers", optional "columns", "defects",
  "unresolved", "truncated", "hubs_not_expanded", and "match" (exact | approximate | none).
- For a CALLS hop, edge_resolution is what matters: RUNTIME means that call was OBSERVED during a real test run.
- Resolutions tell you HOW a fact is known. Treat them differently and say which when it matters:
    RUNTIME        observed during real test execution -- strongest evidence
    EXACT / FRAMEWORK_DUMP   read directly from source structure or from Rails' own route table -- reliable
    HEURISTIC      inferred from a name -- say "inferred", never state it as observed
    AMBIGUOUS      could not be resolved statically -- this is where the trace legitimately stops
- Edge names mean: TARGETS = frontend call site hits an endpoint; SERVES = a route serves it; HANDLED_BY =
  route -> controller action; DECLARES = class/handler owns method; CALLS = method calls method;
  TRIGGERS_DEFECT = a known bug lies on this path.

SOURCE, GREPS AND FAMILIES -- when present, these are authoritative
- "source" entries are the ACTUAL CODE at the indexed commit (numbered lines). You may explain logic,
  conditions and guards from them, and you must cite path:line taken from those line numbers.
  A "grep_in_anchor_file" entry lists every occurrence of a token in that file with context.
- "greps" are repo-wide, commit-pinned searches for an exact token: every file:line where it appears,
  with context. If "capped" is true, say the list was truncated.
- "endpoint_families" list every endpoint under a URL prefix with ALL frontend callers (path:line) and
  the route/handler serving each. "status" is joined | called_not_served | served_not_called.
  Use this to enumerate callers exhaustively; a point lookup cannot. If a family carries
  "unresolved_possible_callers", say that those sites build their URL at runtime and MAY call this
  family, so a "served_not_called" verdict is provisional -- never state it as certain.

WHAT THE GRAPH CANNOT TELL YOU -- be explicit about this
- Without a "source" entry for a method, the graph has no body for it and cannot explain WHY it does
  something or what a condition checks. Then answer with what the graph shows, say plainly that the
  logic was not read, and name the file:line a reader should open.
- Runtime CALLS edges only exist for code paths that tests exercised. Absence of a CALLS edge is NOT
  evidence that a call does not happen.

ANSWER FORMAT (use these headings, keep it tight)
1. Answer -- 2-5 sentences that directly answer the question.
2. Evidence path -- numbered hops. Each hop: kind, name, path:line, and [RUNTIME] / [EXACT] / [HEURISTIC]
   where it matters. Frontend -> endpoint -> route -> handler -> methods -> data.
3. Data & side effects -- tables, columns, external services touched, if any appear in the facts.
   Only DB_TABLE nodes are tables (snake_case names from db/schema.rb). A Ruby class such as Workflow or
   Approval is a MODEL -- label it "model", never "table".
4. Known defects on this path -- summary, root cause, fix, from defect records; or "none recorded".
5. What the graph cannot tell you -- concrete gaps, and the exact file:line to open to close each one.
   The file you point at MUST appear in the facts. If the facts hold no such file, describe the thing
   ("the Bid model") without a path -- never guess a path, not even with "likely" or "probably".
6. Confidence -- high / medium / low, with one reason.

HARD RULES
- If the lookup that answers the question has match "approximate", the Answer section MUST open with:
  "The closest match in the graph is <anchor name> (approximate match on '<matched_on>'); the graph did not
  contain <what was asked>." Never present an approximate match as if it were the thing asked about.
- Never invent a file, line, method, table, or route. Every named artifact must appear in the facts.
- If a lookup has match "none", say "no node matched <q>" -- do not fill the gap from general Rails/React knowledge.
- If "unresolved" is non-empty, say the trace stops there and why.
- If "truncated" is true or "hubs_not_expanded" is non-empty, say so.
- Name the refs read: they are in facts.refs. Tenants run different code.
- Prefer precision over completeness. A shorter correct answer beats a longer padded one.

OVERVIEW QUESTIONS ("how does X work", "what is X", "explain X")
- Section 1 becomes a plain-English explanation for a non-engineer, 4-8 sentences: what it lets a user do,
  the screens or frontend files involved, the backend endpoints and handlers they call, and the data behind it.
  Lead with "overviews" when present, then ground each statement in a named file or endpoint from the facts.
- Do NOT narrate retrieval mechanics. Never write "the anchor is", "the unresolved list is empty",
  "truncated is false", "no hubs were skipped", "the match was exact". Mention a gap only when it changes
  the answer, and only in section 5.`;

const ANSWER_SIMPLE_SYSTEM = `You explain how Procol's software works to a NON-ENGINEER -- a customer success
or product person. You are given FACTS as JSON pulled from a verified code knowledge graph. You know nothing
about this product except those facts.

WRITE LIKE THIS
- Plain, warm, direct English. Short sentences. No jargon. Explain any unavoidable term in a few words.
- Lead with what a USER can do and what happens for them, step by step in plain language.
- Prefer product words (an approval, a bid, a supplier, a screen) over code words (controller, endpoint, model).
- Use the "overviews" facts first when present -- they are written for this audience. Then add specifics.
- Describe the flow as a short story: the person does X on a screen, the system checks Y, then Z happens,
  and the result is stored so it can be shown later.
- 4 to 8 sentences, then optionally a short "In the code" line naming 1-3 real files for an engineer who
  wants to look, taken ONLY from the facts. No headings, no numbered sections, no evidence tables.

HARD RULES -- these keep it honest
- Use ONLY the facts. Never invent a feature, screen, file, number, or behaviour. If the facts do not cover
  part of the question, say plainly "the graph does not show that part" and stop -- do not fill it from
  general knowledge of how such software usually works.
- If the main match is approximate (match: "approximate"), open with "The closest thing I found is <name>,
  which may not be exactly what you asked about," then explain that.
- If nothing matched (match: "none" everywhere), say you could not find it in the indexed code and suggest
  rephrasing with a feature or screen name. Do not guess.
- Every file you name in the optional "In the code" line must appear in the facts.
- Do NOT narrate the machinery: never write "the anchor", "unresolved", "truncated", "hops", "the trace".`;

function extractJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function lookupOne(qstr, refs, emit, seen) {
  const { seed, token, weak } = await anchor(qstr, refs);
  if (!seed) return { q: qstr, match: "none" };
  const fwd = await traceFrom({ entity_id: Number(seed.id), refs, depth: 4, direction: "forward", max_nodes: 60 });
  const rev = await traceFrom({ entity_id: Number(seed.id), refs, depth: 2, direction: "reverse", max_nodes: 30 });
  const ids = [Number(seed.id), ...fwd.nodes.map(n => Number(n.id)), ...rev.nodes.map(n => Number(n.id))];
  const ev = await getEvidence({ ids });
  const evById = new Map(ev.evidence.map(e => [String(e.id), e]));
  for (const e of ev.evidence) if (!seen.has(`ev:${e.id}`)) {
    seen.add(`ev:${e.id}`);
    emit({ type: "evidence", id: e.id, repo: e.repo, path: e.path, line: e.start_line,
           commit: e.commit_sha?.slice(0, 8), ref: e.refs, extractor: e.extractor });
  }
  const edgeInto = new Map(fwd.edges.map(e => [String(e.dst), e.kind]));
  const edgeResInto = new Map(fwd.edges.map(e => [String(e.dst), e.resolution]));
  const hop = (n, i) => ({ kind: n.kind, name: n.name || n.fqn, path: n.path, line: n.line,
                            edge: edgeInto.get(String(n.id)) || null,
                            edge_resolution: edgeResInto.get(String(n.id)) || null,   // RUNTIME = observed in tests
                            node_resolution: n.resolution, depth: n.depth });
  // claims for the UI (dedupe across lookups)
  const claimOf = (n, edge) => ({ id: `c${n.id}`, text: `${n.kind} ${n.name || n.fqn}` + (n.path ? ` at ${n.path}${n.line ? ":" + n.line : ""}` : ""),
                                  kind: n.kind, name: n.name || n.fqn, path: n.path, line: n.line, edge, depth: n.depth ?? 0,
                                  evidence_ids: [Number(n.id)], confidence: 0.95 });
  if (!seen.has(`n:${seed.id}`)) { seen.add(`n:${seed.id}`); emit({ type: "claim", ...claimOf({ ...seed, line: seed.start_line, depth: 0 }, null) }); }
  for (const n of fwd.nodes) if (!seen.has(`n:${n.id}`)) { seen.add(`n:${n.id}`); emit({ type: "claim", ...claimOf(n, edgeInto.get(String(n.id))) }); }
  for (const u of fwd.unresolved ?? []) emit({ type: "unresolved", ...u });
  if (seed.resolution === "AMBIGUOUS") emit({ type: "unresolved", fqn: seed.fqn, path: seed.path, line: seed.start_line, reason: "path built at runtime; not statically resolvable" });
  if (fwd.truncated) emit({ type: "truncated", reason: "node limit reached", at_depth: fwd.depth });

  const defects = fwd.nodes.filter(n => n.kind === "OBSERVED_DEFECT").map(n => ({
    name: n.name, path: n.path, line: n.line, summary: n.attrs?.summary, root_cause: n.attrs?.root_cause,
    suggested_fix: n.attrs?.suggested_fix, trigger_condition: n.attrs?.trigger_condition, confidence: n.attrs?.confidence }));
  return {
    q: qstr, match: weak ? "approximate" : "exact", matched_on: token,
    anchor: { id: Number(seed.id), kind: seed.kind, name: seed.name || seed.fqn, path: seed.path, line: seed.start_line, resolution: seed.resolution,
              repo: evById.get(String(seed.id))?.repo ?? null },
    columns: seed.kind === "DB_TABLE" ? seed.attrs?.columns ?? null : undefined,
    downstream: fwd.nodes.slice(0, 45).map(hop),
    upstream_callers: rev.nodes.slice(0, 15).map(n => ({ kind: n.kind, name: n.name || n.fqn, path: n.path, line: n.line, resolution: n.resolution })),
    defects: defects.length ? defects : undefined,
    unresolved: fwd.unresolved?.length ? fwd.unresolved : undefined,
    truncated: fwd.truncated || undefined,
    hubs_not_expanded: fwd.hubs_not_expanded?.length ? fwd.hubs_not_expanded : undefined,
  };
}

// ---- routing: exact identifier + simple trace question -> guided (sub-second);
// anything asked in plain words, or asking why/how/what-if -> plan (deep).
// ---- intent: does the asker want CODE (files, lines, traces) or a PLAIN explanation?
// Everyone at Procol uses this -- CS and PM ask "how does X work", engineers ask "who calls Y".
// Default leans to plain unless the question is clearly technical; the UI can force either.
const CODE_SIGNALS = /\b(trace|call(s|ers|ed)?|method|function|endpoint|route|controller|handler|table|column|schema|query|sql|migration|defect|bug|stack|guard|param|serializer|worker|job|class|module|which file|file:line|line number|implementation|code)\b/i;
const SIMPLE_SIGNALS = /\b(how does|how do|what is|what are|what can|explain|overview|walk me through|in simple|for a (pm|cs|non|beginner)|as a user|business|feature|workflow|process|end to end|high level|non-technical)\b/i;
const HAS_IDENTIFIER = /[\/#.:]|[a-z][A-Z]|_\w/;
export function resolveIntent(question, style) {
  if (style === "code" || style === "simple") return style;   // explicit UI toggle wins
  const q = question || "";
  const code = CODE_SIGNALS.test(q) || (HAS_IDENTIFIER.test(q) && !SIMPLE_SIGNALS.test(q));
  const simple = SIMPLE_SIGNALS.test(q);
  if (simple && !HAS_IDENTIFIER.test(q)) return "simple";     // plain words, plain answer
  if (code) return "code";
  return "simple";                                            // default audience is everyone
}

const OVERVIEW_RE = /\b(how does|how do|how is|how are|what is|what are|what does|explain|overview|walk me through|works?)\b/i;
const THOUGHT_RE = /\b(why|what if|guard|check|decide|should|impact|every|all|which|who|owns?|built)\b/i;
const IDENTIFIER_RE = /[\/#.:_]|[a-z][A-Z]/;
export const isOverview = (qs) => OVERVIEW_RE.test(qs);

/** Every answer ends with the refs and commits it was read from. The service says this, not the model. */
async function emitRefsFooter(refs, emit) {
  const scope = await resolveScope(refs);
  const parts = scope.refs.map(r => `${r.repo}@${r.sha.slice(0, 8)}`);
  emit({ type: "token", text: `\n\nRead from ${refs.join(", ")}: ${parts.join(" · ")}` });
}

/**
 * Remove any file path the model names that was not in the facts it was given. A weak model still
 * writes "likely app/models/bid.rb" about half the time no matter what the prompt says; this makes
 * "zero invented paths" a property of the service. Returns the cleaned text and how many were cut.
 */
function sanitizePaths(text, knownPaths) {
  const known = [...knownPaths].filter(Boolean);
  const bases = new Set(known.map(k => k.split("/").pop()));
  let removed = 0;
  const out = text.replace(/`?((?:[\w.-]+\/)+[\w.-]+\.(?:rb|js|jsx|ts|tsx|erb|yml|rake))(:\d+(?:-\d+)?)?`?/g, (m, pth) => {
    const ok = known.some(k => k === pth || k.endsWith("/" + pth) || pth.endsWith("/" + k)) || bases.has(pth.split("/").pop());
    if (ok) return m;
    removed++;
    return "a file the graph did not supply";
  });
  return { text: out, removed };
}
const pathsIn = (json) => new Set((json.match(/[\w./-]+\.(?:rb|js|jsx|ts|tsx|yml|erb|rake)\b/g) || []).filter(x => x.includes("/")));

/** Every file path the model was shown, so a checker can tell "invented" from "given in a list". */
function emitContextPaths(factsJson, emit) {
  const paths = new Set((factsJson.match(/[\w./-]+\.(?:rb|js|jsx|ts|tsx|yml|erb)\b/g) || []).filter(x => x.includes("/")));
  if (paths.size) emit({ type: "context_paths", paths: [...paths].slice(0, 400) });
}

async function routeAuto({ question, refs, emit, t0, p, intent }) {
  const a = await anchor(question, refs);
  const exactIdent = !!a.seed && !a.weak && IDENTIFIER_RE.test(a.token || "");
  // Fast path only for a code-intent, exact-identifier, non-"why" question.
  if (intent === "code" && exactIdent && !isOverview(question) && !THOUGHT_RE.test(question))
    return guidedRun({ question, refs, emit, t0, p, intent });
  return planRun({ question, refs, emit, t0, p, intent });
}

const PLAN_LOOKUPS = 6, PLAN_TOTAL_LOOKUPS = 8, PLAN_LISTS = 3, LIST_LIMIT = 40, FACTS_BUDGET = 30000;
const tooBroad = (spec) => ["SYMBOL", "HTTP_CALL_SITE", "HANDLER", "SERVER_ROUTE", "HTTP_ENDPOINT"].includes(spec.kind)
  && !spec.name_contains && (!spec.path_prefix || spec.path_prefix.split("/").filter(Boolean).length < 2);

/** Cut the facts down to a size the model reliably handles, least important first. */
function shrink(facts, budget) {
  const size = () => JSON.stringify(facts, null, 1).length;
  const steps = [
    () => { if (facts.greps) facts.greps = facts.greps.map(g => ({ ...g, files: (g.files || []).slice(0, 6).map(f => ({ ...f, hits: (f.hits || []).slice(0, 4) })) })); },
    () => { for (const l of facts.lists || []) l.items = l.items.slice(0, 15); },
    () => { for (const r of facts.lookups) { if (r.downstream) r.downstream = r.downstream.slice(0, 12); if (r.upstream_callers) r.upstream_callers = r.upstream_callers.slice(0, 6); } },
    () => { for (const f of facts.endpoint_families || []) f.family = (f.family || []).slice(0, 12).map(e => ({ ...e, callers: (e.callers || []).slice(0, 6) })); },
    () => { if (facts.source) facts.source = facts.source.slice(0, 2); },
    () => { delete facts.greps; },
    () => { for (const l of facts.lists || []) l.items = l.items.slice(0, 6); },
    () => { for (const r of facts.lookups) { if (r.downstream) r.downstream = r.downstream.slice(0, 6); delete r.upstream_callers; } },
    () => { delete facts.source; },
  ];
  for (const step of steps) { if (size() <= budget) break; step(); }
  const json = JSON.stringify(facts, null, 1);
  return json.length > budget ? json.slice(0, budget) : json;
}

/** Get the answer (one retry with half the facts), strip any path not in the facts, emit it once. */
async function writeAnswer({ question, facts, emit, budget, system = ANSWER_SYSTEM }) {
  const known = pathsIn(JSON.stringify(facts));
  let text = "";
  const run = async (json) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: `QUESTION: ${question}\n\nFACTS:\n${json}` }];
    let t = "";
    for await (const d of chatStream({ messages, max_tokens: 1800, temperature: 0 })) t += d;
    if (!t) t = (await chat({ messages, max_tokens: 1800, temperature: 0 })).content || "";
    return t;
  };
  try { text = await run(shrink(structuredClone(facts), budget)); }
  catch (e) { emit({ type: "status", text: `answer failed (${String(e.message).slice(0, 80)}); retrying with fewer facts` }); }
  if (!text) {
    try { text = await run(shrink(structuredClone(facts), Math.floor(budget / 2))); }
    catch (e) { emit({ type: "error", code: "llm_failed", message: e.message }); }
  }
  if (!text) { emit({ type: "token", text: "(No prose available - the language model call failed twice. The claims and evidence above come from the code graph and are unaffected.)" }); return ""; }
  const clean = sanitizePaths(text, known);
  emit({ type: "token", text: clean.text });
  if (clean.removed) emit({ type: "status", text: `removed ${clean.removed} file path${clean.removed > 1 ? "s" : ""} the model guessed but was not given` });
  return clean.text;
}

async function planRun({ question, refs, emit, t0, p, intent = "code" }) {
  // Phase 0: candidates by MEANING. Fails soft when no embeddings exist. The pilot measured this as the
  // difference between 5/8 and 7/8 on questions asked in everyday words.
  let sem = [];
  try { sem = (await semanticAnchor({ question, k: 8, refs })).matches.filter(m => Number(m.score) >= 0.55); } catch { /* no embeddings for this model */ }
  const candText = sem.length
    ? "\n\nCANDIDATE NODES (real graph names ranked by meaning; use their exact names as lookups when they fit):\n"
      + sem.map(m => `- ${m.kind} | ${m.name || m.fqn} | ${m.path || ""}`).join("\n")
    : "";

  // Phase A: plan
  const tPlan = Date.now();
  emit({ type: "status", text: `planning (${p.model})${sem.length ? ` with ${sem.length} candidates by meaning` : ""}` });
  let plan = null;
  try {
    const m = await chat({ messages: [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: `QUESTION: ${question}${candText}` }], max_tokens: 320, temperature: 0 });
    plan = extractJson(m.content || "");
  } catch (e) { emit({ type: "status", text: `planner failed (${String(e.message).slice(0, 60)}); using identifiers and candidates` }); }

  const lookups = [];
  const have = new Set();
  const add = (x) => { const k = String(x || "").trim(); if (k && !have.has(k.toLowerCase()) && lookups.length < PLAN_TOTAL_LOOKUPS) { lookups.push(k); have.add(k.toLowerCase()); } };
  for (const l of (plan?.lookups || []).slice(0, PLAN_LOOKUPS)) add(l?.q);
  for (const m of sem.filter(m => Number(m.score) >= 0.62).slice(0, 2)) add(m.name || m.fqn);   // union with meaning
  for (const c of candidates(question).filter(t => IDENTIFIER_RE.test(t))) add(c);            // identifiers only, never plain words
  if (!lookups.length) for (const m of sem.slice(0, 3)) add(m.name || m.fqn);
  const planMs = Date.now() - tPlan;
  emit({ type: "status", text: `looking up: ${lookups.join(" · ")}` });

  // Phase B: retrieve -- everything independent runs at once
  const tRetrieve = Date.now();
  const seen = new Set();
  const specs = (plan?.lists || []).slice(0, PLAN_LISTS).filter(spec => {
    if (!spec?.kind) return false;
    if (tooBroad(spec)) { emit({ type: "status", text: `skipped a too-broad list (${spec.kind}${spec.path_prefix ? ` under ${spec.path_prefix}` : ""})` }); return false; }
    emit({ type: "status", text: `listing ${spec.kind}${spec.path_prefix ? ` under ${spec.path_prefix}` : ""}${spec.name_contains ? ` matching "${spec.name_contains}"` : ""}` });
    return true;
  });
  const sqlStmts = (plan?.sql || []).filter(x => typeof x === "string" && /^\s*(with|select)\b/i.test(x)).slice(0, 2);
  const prefs = (plan?.endpoint_families || []).filter(x => typeof x === "string" && x.startsWith("/")).slice(0, 3);
  for (const pref of prefs) emit({ type: "status", text: `mapping every endpoint under ${pref}` });

  const [results, listRes, sqlRes, famRes] = await Promise.all([
    Promise.all(lookups.map(l => lookupOne(l, refs, emit, seen))),
    Promise.all(specs.map(spec => listEntities({ kind: spec.kind, path_prefix: spec.path_prefix ?? null, name_contains: spec.name_contains ?? null, subkind: spec.subkind ?? null, refs, limit: LIST_LIMIT }))),
    Promise.all(sqlStmts.map(stmt => runSql({ sql: stmt }).then(r => ({ stmt, r })))),
    Promise.all(prefs.map(pref => endpointFamily({ path_prefix: pref, refs }))),
  ]);
  const matched = results.filter(r => r.match !== "none").length;
  emit({ type: "status", text: `${matched}/${results.length} lookups matched a node` });

  const lists = listRes.map((r, i) => ({ asked: specs[i], total: r.total, returned: r.returned, complete: r.complete, by_subkind: r.by_subkind,
    items: r.items.map(it => ({ name: it.name, path: it.path, line: it.start_line, kind: it.kind,
      ...(it.kind === "FEATURE" ? { bullets: (it.attrs?.bullets || []).slice(0, 4) } : {}) })) }));

  const sqlResults = [];
  for (const { stmt, r } of sqlRes) {
    if (r.error) { sqlResults.push({ sql: stmt, error: r.error }); continue; }
    for (const e of r.evidence) if (!seen.has(`ev:${e.id}`)) { seen.add(`ev:${e.id}`); emit({ type: "evidence", id: e.id, repo: e.repo, path: e.path, line: e.line, extractor: e.extractor }); }
    sqlResults.push({ sql: r.sql, row_count: r.row_count, capped: r.capped, rows: r.rows.slice(0, 40).map(row => { const o = { ...row }; delete o.attrs; return o; }), evidence: r.evidence.slice(0, 30) });
  }

  const families = [];
  for (const fam of famRes) {
    if (fam.error) continue;
    families.push(fam);
    for (const e of fam.family) for (const c of e.callers)
      if (!seen.has(`fam:${c.path}:${c.line}`)) { seen.add(`fam:${c.path}:${c.line}`);
        emit({ type: "claim", id: `f${seen.size}`, text: `HTTP_CALL_SITE ${c.path}:${c.line} -> ${e.endpoint}`, kind: "HTTP_CALL_SITE",
               name: `${e.method} ${e.path}`, path: c.path, line: c.line, edge: "TARGETS", depth: 0, evidence_ids: [], confidence: 0.95 }); }
  }

  // SOURCE ON DEMAND -- only when the question needs logic ("why", "how does it decide") or names an identifier.
  const source = [];
  let sourceChars = 0;
  const SOURCE_CAP = 14000;
  const pushSrc = (blk) => { if (!blk || blk.error) return; const size = JSON.stringify(blk).length; if (sourceChars + size > SOURCE_CAP) return; source.push(blk); sourceChars += size; };
  const identTokens = candidates(question).filter(t => /[#.?!:_]|[a-z][A-Z]/.test(t)).slice(0, 5);
  if (plan?.want_source || identTokens.length) {
    emit({ type: "status", text: "reading source at the indexed commit" });
    const seenFiles = new Set();
    await Promise.all(results.map(async (r) => {
      const a = r.anchor; if (!a?.path || !a.repo) return;
      if (a.kind === "SYMBOL" || a.kind === "HANDLER" || a.kind === "HTTP_CALL_SITE") {
        const ent = await q(`select end_line from ckg.entities e join ckg.repos rp on rp.id=e.repo_id where rp.name=$1 and e.path=$2 and e.start_line=$3 limit 1`, [a.repo, a.path, a.line]);
        pushSrc(await readSource({ repo: a.repo, path: a.path, start_line: a.line || 1, end_line: ent[0]?.end_line || null, refs, context: 2 }));
      }
      if (!seenFiles.has(`${a.repo}:${a.path}`) && plan?.want_source) {
        seenFiles.add(`${a.repo}:${a.path}`);
        for (const t of identTokens.filter(t => !(a.name || "").includes(t)).slice(0, 3)) {
          const g = await grepSource({ repo: a.repo, pattern: t, refs, paths: [a.path], max_hits: 12, context: 3 });
          if (!g.error && g.total_hits) pushSrc({ kind: "grep_in_anchor_file", ...g });
        }
      }
      for (const d of r.defects || []) if (d.path && d.line) pushSrc(await readSource({ repo: a.repo, path: d.path, start_line: Math.max(1, d.line - 12), end_line: d.line + 12, refs }));
    }));
  }

  // REPO-WIDE GREPS -- only when the plan asked to read code; they are the slowest step.
  const greps = [];
  if (plan?.want_source) {
    const planGreps = (plan?.greps || []).filter(g => typeof g === "string" && g.length >= 3).slice(0, 3);
    const grepRepos = new Set(results.map(r => r.anchor?.repo).filter(Boolean));
    if (!grepRepos.size) grepRepos.add("procol-backend");
    if (/\b(frontend|dashboard|react|redux|ui|browser|client|screen)\b/i.test(question)) grepRepos.add("procol-client-dashboard");
    const jobs = [];
    for (const pat of planGreps) for (const repo of grepRepos) {
      emit({ type: "status", text: `grep "${pat}" across ${repo}` });
      jobs.push(grepSource({ repo, pattern: pat, refs, max_hits: 30, context: 2 }));
    }
    for (const g of await Promise.all(jobs)) if (!g.error && g.total_hits) greps.push(g);
  }

  // OVERVIEWS -- targeted: the features the anchors belong to (via IMPLEMENTS), features found by meaning,
  // and the system summary for overview-shaped questions.
  let summaries;
  const anchorIds = results.map(r => r.anchor?.id).filter(Boolean);
  const semFeatureIds = sem.filter(m => m.kind === "FEATURE").map(m => Number(m.id));
  if (plan?.want_summaries || isOverview(question) || semFeatureIds.length) {
    emit({ type: "status", text: "reading cached overviews" });
    const rows = await q(
      `with feats as (
         select f.id from ckg.entities f where f.id = any($1::bigint[]) and f.kind = 'FEATURE'
         union select g.src_entity_id from ckg.edges g where g.kind = 'IMPLEMENTS' and g.dst_entity_id = any($1::bigint[]))
       select s.altitude, s.subject_key, s.headline, s.body, s.entity_count, s.generated_by, rp.name as repo
         from ckg.summaries s join ckg.repos rp on rp.id = s.repo_id
        where s.subject_id in (select id from feats) or (s.altitude = 'system' and $2::boolean)
        order by s.altitude desc, s.entity_count desc limit 8`, [[...anchorIds, ...semFeatureIds], isOverview(question)]);
    const rows2 = rows.length ? rows : (plan?.want_summaries ? await getSummaries({ refs, limit: 10 }) : []);
    if (rows2.length) summaries = rows2.map(x => ({ altitude: x.altitude, subject: x.subject_key, repo: x.repo, headline: x.headline, body: x.body, covers_entities: x.entity_count }));
  }

  // OWNERS -- who to ask
  let owners;
  if (plan?.want_owners) {
    emit({ type: "status", text: "reading git ownership" });
    const anchorPaths = results.map(r => r.anchor?.path).filter(Boolean);
    const dir = anchorPaths[0] ? anchorPaths[0].split("/").slice(0, 3).join("/") : null;
    const o = await ownersOf({ path_prefix: dir, refs, limit: 8 });
    if (o.length) owners = { scope: dir, people: o };
  }

  const facts = { question, refs,
                  lookups: results.map(r => { const o = { ...r }; if (o.anchor) { const { id, ...rest } = o.anchor; o.anchor = rest; } return o; }),
                  ...(lists.length ? { lists } : {}), ...(sqlResults.length ? { planned_sql: sqlResults } : {}),
                  ...(families.length ? { endpoint_families: families } : {}),
                  ...(source.length ? { source } : {}), ...(greps.length ? { greps } : {}),
                  ...(summaries ? { overviews: summaries } : {}), ...(owners ? { owners } : {}) };

  // Phase C: answer (bounded payload, one retry)
  const retrieveMs = Date.now() - tRetrieve;
  emitContextPaths(JSON.stringify(facts), emit);
  emit({ type: "status", text: `writing the ${intent === "simple" ? "plain-English" : "technical"} answer (${p.model})` });
  const tAnswer = Date.now();
  await writeAnswer({ question, facts, emit, budget: FACTS_BUDGET, system: intent === "simple" ? ANSWER_SIMPLE_SYSTEM : ANSWER_SYSTEM });
  const answerMs = Date.now() - tAnswer;
  await emitRefsFooter(refs, emit);

  const summary = { type: "done", lists: lists.map(l => `${l.asked.kind}:${l.total}`),
                    families: families.map(f => `${f.prefix}:${f.endpoints}ep/${f.call_sites}cs`),
                    source_blocks: source.length, greps: greps.map(g => `${g.pattern}:${g.total_hits}`),
                    candidates_by_meaning: sem.length,
                    claim_count: [...seen].filter(k => k.startsWith("n:")).length,
                    evidence_count: [...seen].filter(k => k.startsWith("ev:")).length, tool_calls: results.length * 3 + 1,
                    unresolved_count: results.reduce((a, r) => a + (r.unresolved?.length || 0), 0),
                    timings: { plan_ms: planMs, retrieve_ms: retrieveMs, answer_ms: answerMs },
                    lookups, matched, refs, provider: `${p.base} · ${p.model}`, mode: "plan", ms: Date.now() - t0 };
  emit(summary);
  return summary;
}


// =====================================================================================
// SQL MODE -- the model writes its own queries. Read-only role, 5s timeout, 200-row cap,
// evidence auto-attached to every entity id it selects. Up to 6 query rounds, then the answer.
// =====================================================================================
const SQL_SYSTEM = `You are a senior engineer answering a question about Procol's codebase by querying a code knowledge
graph directly. You know NOTHING about this codebase except what your queries return.

${SCHEMA_DOC}

The graph holds STRUCTURE (what exists, what connects to what). It does not hold method bodies. When a
question needs the actual logic -- "why", "what does it check", "which guards", "what would happen if" --
read the code: it is available at the exact indexed commit through READ and GREP.

PROTOCOL -- each reply is EXACTLY one command and nothing else (no prose before or after):
  SQL:   <a single SELECT>                 -- find nodes and edges
  READ:  <repo> <path> <start_line> <end_line>   -- numbered source lines (max 120) for a path the graph knows
  GREP:  <repo> <exact token>              -- every occurrence in that repo at the indexed commit, with context
  ANSWER                                   -- when you have enough
repo is one of procol-backend | procol-client-dashboard | web-bidding.
You get up to 8 commands. SELECT id columns so evidence (repo, path, line) is attached and you can cite
path:line. Do not select attrs unless you need it -- it is large. A CALLS query returning 0 rows means no
test exercised that path; do not re-query the same edges -- READ the method instead.
Start broad (find the nodes), then narrow (edges, then source). If a command errors, fix it and retry.
Never guess a name: query for it. If nothing matches, that is a finding -- say so in the answer.`;

const SQL_ANSWER_RULES = `Write the final answer from the query results ONLY, using these headings:
1. Answer -- 2-5 sentences.
2. Evidence -- numbered items, each with path:line taken from "evidence" or from path/line columns, and
   [RUNTIME] / [EXACT] / [DOCUMENTED] / [HEURISTIC] where the resolution column was present.
3. Data & side effects -- tables / services / columns that appeared.
4. Known defects -- from OBSERVED_DEFECT rows, or "none found".
5. What the queries could not show -- gaps, and which file:line to open.
6. Confidence -- high / medium / low, one reason.
When you READ source, you may explain the logic and must cite the numbered lines you read. When a GREP
returned hits, enumerate them with path:line. Hard rules: never name a file, line, method, table or route
that did not appear in a result; if a result was capped, say so; say which ref you queried; do not fill
gaps from general Rails/React knowledge.`;

async function sqlRun({ question, refs, emit, t0, p }) {
  const ref = refs[0] || "main";
  const messages = [{ role: "system", content: SQL_SYSTEM },
                    { role: "user", content: `Ref to query: '${ref}'.\n\nQUESTION: ${question}` }];
  const queries = [];
  const seenEv = new Set();
  // Pull ONE command out of a reply, tolerating prose and markdown fences around it.
  const parseCommand = (reply) => {
    const t = reply.replace(/```[a-z]*\n?/gi, "\n").trim();
    if (/^\s*answer\b/im.test(t) && !/^\s*(sql|read|grep)\s*:/im.test(t)) return { cmd: "ANSWER" };
    let m = t.match(/^\s*READ:?\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(\d+))?/im);
    if (m) return { cmd: "READ", repo: m[1], path: m[2], start: Number(m[3]), end: m[4] ? Number(m[4]) : null };
    m = t.match(/^\s*GREP:?\s+(\S+)\s+(.+?)\s*$/im);
    if (m) return { cmd: "GREP", repo: m[1], pattern: m[2].trim().replace(/^["'`]|["'`]$/g, "") };
    m = t.match(/(?:^|\n)\s*(?:SQL:\s*)?((?:with|select)\b[\s\S]*)$/i);
    if (m) return { cmd: "SQL", sql: m[1].split(/\n\s*(?:ANSWER|READ:|GREP:)/i)[0].trim() };
    return { cmd: "UNKNOWN", raw: t.slice(0, 200) };
  };

  for (let round = 0; round < 8; round++) {
    emit({ type: "status", text: round === 0 ? `writing command 1 (${p.model})` : `writing command ${round + 1}` });
    let m;
    try { m = await chat({ messages, max_tokens: 700, temperature: 0 }); }
    catch (e) { emit({ type: "error", code: "llm_failed", message: e.message }); break; }
    const reply = (m.content || "").trim();
    messages.push({ role: "assistant", content: reply });
    const c = parseCommand(reply);
    if (c.cmd === "ANSWER") break;

    const left = 8 - round - 1;
    let result, label;
    if (c.cmd === "SQL") {
      const r = await runSql({ sql: c.sql });
      queries.push({ kind: "SQL", sql: r.sql ?? c.sql, ok: !r.error, rows: r.row_count ?? 0, ms: r.ms ?? null, error: r.error });
      if (r.error) { result = `ERROR: ${r.error}${r.hint ? " (" + r.hint + ")" : ""}\nFix the command and reply with one command only.`; label = `command ${round + 1} failed: ${r.error.slice(0, 70)}`; }
      else {
        for (const e of r.evidence) if (!seenEv.has(String(e.id))) { seenEv.add(String(e.id)); emit({ type: "evidence", id: e.id, repo: e.repo, path: e.path, line: e.line, extractor: e.extractor }); }
        const slim = r.rows.map(row => { const o = { ...row }; if (o.attrs && JSON.stringify(o.attrs).length > 600) o.attrs = "(large; select specific attrs->>'key' instead)"; return o; });
        const payload = JSON.stringify({ row_count: r.row_count, capped: r.capped, columns: r.columns, rows: slim, evidence: r.evidence });
        const zeroHint = r.row_count === 0 && /\bCALLS\b/i.test(c.sql) ? "\nNOTE: 0 CALLS rows = no test exercised this path. Do not re-query these edges; READ the method body instead." : "";
        const broadHint = r.row_count > 50 ? "\nNOTE: too broad to reason over. Narrow with a precise name/path (LIMIT 20), or READ the most relevant file now." : "";
        const budget = left <= 2 ? `\nBUDGET: ${left} command(s) left. READ the key file or ANSWER.` : "";
        result = `RESULT:\n${payload.slice(0, 10000)}${payload.length > 10000 ? "\n...(truncated: narrow the query)" : ""}${zeroHint}${broadHint}${budget}\n\nNext command, or ANSWER.`;
        label = `command ${round + 1}: ${r.row_count} rows${r.capped ? " (capped)" : ""} in ${r.ms}ms`;
      }
    } else if (c.cmd === "READ") {
      const r = await readSource({ repo: c.repo, path: c.path, start_line: c.start, end_line: c.end, refs, context: 1 });
      queries.push({ kind: "READ", sql: `READ ${c.repo} ${c.path} ${c.start}-${c.end ?? ""}`, ok: !r.error, rows: r.lines?.length ?? 0, ms: null, error: r.error });
      result = r.error ? `ERROR: ${r.error}\nOnly paths the graph knows (query v_nodes.path first).` : `SOURCE ${r.path} @ ${r.commit} lines ${r.from}-${r.to}${r.truncated ? " (truncated)" : ""}:\n${r.lines.join("\n")}\n\nNext command, or ANSWER.`;
      label = r.error ? `read failed: ${r.error.slice(0, 70)}` : `read ${c.path}:${r.from}-${r.to}`;
    } else if (c.cmd === "GREP") {
      const r = await grepSource({ repo: c.repo, pattern: c.pattern, refs, max_hits: 30, context: 2 });
      queries.push({ kind: "GREP", sql: `GREP ${c.repo} ${c.pattern}`, ok: !r.error, rows: r.total_hits ?? 0, ms: null, error: r.error });
      result = r.error ? `ERROR: ${r.error}` : `GREP "${c.pattern}" in ${c.repo} @ ${r.commit}: ${r.total_hits} hits${r.capped ? " (capped)" : ""}\n${JSON.stringify(r.files).slice(0, 10000)}\n\nNext command, or ANSWER.`;
      label = r.error ? `grep failed` : `grep "${c.pattern}": ${r.total_hits} hits in ${r.files?.length ?? 0} files`;
    } else {
      queries.push({ kind: "?", sql: c.raw, ok: false, rows: 0, ms: null, error: "unparseable" });
      result = `ERROR: could not parse a command. Reply with exactly one of: SQL: <select> | READ: <repo> <path> <start> <end> | GREP: <repo> <token> | ANSWER`;
      label = `command ${round + 1} unparseable`;
    }
    emit({ type: "status", text: label });
    messages.push({ role: "user", content: result });
  }

  emit({ type: "status", text: `writing the answer (${p.model})` });
  const answerMsgs = [{ role: "system", content: "Commands are over. You are now writing the final answer for a human reader. Output prose only -- no SQL, no READ, no GREP." },
                      ...messages.slice(1), { role: "user", content: SQL_ANSWER_RULES }];
  let text = "";
  const looksLikeCommand = (t) => /^\s*(```|SQL:|READ:?\s|GREP:?\s|SELECT\b|WITH\b)/i.test(t.trim());
  for (let attempt = 0; attempt < 2 && (!text || looksLikeCommand(text)); attempt++) {
    text = "";
    try {
      for await (const d of chatStream({ messages: attempt ? [...answerMsgs, { role: "user", content: "That was a command, not an answer. Write the six-section answer in prose now." }] : answerMsgs, max_tokens: 1600, temperature: 0.1 })) {
        text += d; if (attempt === 0) emit({ type: "token", text: d });
      }
    } catch (e) { emit({ type: "error", code: "llm_failed", message: e.message }); break; }
    if (attempt === 1 && text && !looksLikeCommand(text)) emit({ type: "token", text: "\n\n" + text });
  }
  if (!text || looksLikeCommand(text)) emit({ type: "token", text: "(The model did not produce a prose answer; the evidence above is from the graph and is unaffected.)" });

  const summary = { type: "done", mode: "sql", commands: queries.map(x => x.kind), queries: queries.length, failed_queries: queries.filter(x => !x.ok).length,
                    evidence_count: seenEv.size, claim_count: 0, unresolved_count: 0, refs,
                    provider: `${p.base} · ${p.model}`, ms: Date.now() - t0, sql: queries };
  emit(summary);
  return summary;
}
