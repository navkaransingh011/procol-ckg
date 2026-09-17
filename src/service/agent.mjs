// The agent loop. Emits the typed events from docs/API_CONTRACT.md.
//
// The model's job here is small and bounded: pick tools, then write prose over
// structured results it cannot edit. It never sees source code and never invents
// a fact. Everything it can cite came from a deterministic extractor.
import { redactFacts } from "./policy.mjs";
import { FLOW_RULES, wantsFlow, extractFlow } from "./flow.mjs";
import { needsContext, resolveFollowUp, CONVERSATION_RULE } from "./followup.mjs";
import { assessConfidence, clearTop } from "./confidence.mjs";
import { templateView, screenView, screenJourney, screensNamedIn } from "../tools.mjs";
import { configFor, companiesWith, companyMentions } from "./configs.mjs";
import { looksLikeTicket, parseTicket, collectTriageFacts, TRIAGE_SYSTEM, extractTriage } from "./triage.mjs";
import { findEntity, traceFrom, getEvidence, endpointCoverage, resolveScope, listEntities, ownersOf, getSummaries, endpointFamily, readSource, grepSource, semanticAnchor, searchDocs, queryLive, searchConfigs, searchLive, LIVE_DOC, NARRATIVE_EDGES } from "../tools.mjs";
import { q } from "../db.mjs";
import { createHash } from "node:crypto";
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
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}#./:_-]+/gu, " ").trim().replace(/\s+/g, " ");

/**
 * Cache in front of the real run. Key = question (normalised) + style + the exact commits in scope, so a
 * re-index misses on its own. Replays the stored event stream in ~ms with one leading status line.
 */
const CACHE_VERSION = 4;   // 4: calibrated confidence, gated side facts, no approximate-match disclaimer (3: platform-styled template previews)
export async function ask({ question: asked, refs = ["main"], emit, style = "auto", fresh = false, policy = null, history = null }) {
  const p0 = provider();
  // Inside a chat, a follow-up is rewritten into a standalone question from what earlier turns made explicit.
  // Everything downstream (planning, retrieval, the cache key) uses the standalone form; the person sees the original.
  let question = asked;
  if (Array.isArray(history) && history.length && needsContext(asked) && !p0.mock) {
    const r = await resolveFollowUp({ question: asked, history }).catch(() => null);
    if (r?.used_history && r.standalone) { question = r.standalone; emit({ type: "rewrite", question: asked, standalone: question }); emit({ type: "status", text: `understood as: ${question}` }); }
  }
  const conversation = Array.isArray(history) && history.length ? history : null;
  if (p0.mock || fresh || process.env.CKG_ANSWER_CACHE === "0") return askUncached({ question, refs, emit, style, policy, conversation });
  const { commits } = await resolveScope(refs);
  // the role is part of the key: an engineer's cached answer (with paths) must never replay for a CS user
  const view = policy ? JSON.stringify(policy) : "open";
  // CACHE_VERSION: bump when the answer format changes (new event types, prompt changes), so old replays retire
  const key = createHash("sha1").update(`v${CACHE_VERSION}|${norm(question)}|${style}|${view}|${[...commits].sort().join(",")}`).digest("hex");
  let hit = await q(`update ckg.answer_cache set hits = hits + 1, last_hit = now() where key = $1 returning events, created_at, ms`, [key]).catch(() => []);
  // Answers that showed live platform data (tables, template layouts) go stale as UAT changes, so they are
  // replayed only for a while; code-only answers stay valid until the commits move (that is in the key).
  if (hit.length && hit[0].events.some(e => e.type === "table" || e.type === "template")) {
    const ageMin = (Date.now() - new Date(hit[0].created_at).getTime()) / 60000;
    if (ageMin > Number(process.env.CKG_LIVE_CACHE_TTL_MIN || 60)) { await q(`delete from ckg.answer_cache where key = $1`, [key]).catch(() => {}); hit = []; }
  }
  if (hit.length) {
    const age = Math.round((Date.now() - new Date(hit[0].created_at).getTime()) / 60000);
    emit({ type: "status", text: `answered before (${age < 1 ? "just now" : age < 60 ? age + " min ago" : Math.round(age / 60) + " h ago"}); replaying from cache` });
    let summary = null;
    for (const e of hit[0].events) { if (e.type === "done") summary = { ...e, cached: true }; emit(e.type === "done" ? summary : e); }
    return summary;
  }
  const events = [];
  const rec = (e) => { emit(e); if (e.type !== "status") events.push(e); };   // status lines are transient by design
  const summary = await askUncached({ question, refs, emit: rec, style, policy, conversation });
  if (summary && !events.some(e => e.type === "error") && events.some(e => e.type === "token"))
    await q(`insert into ckg.answer_cache (key, question, style, commits, events, ms) values ($1,$2,$3,$4,$5,$6) on conflict (key) do nothing`,
            [key, question, style, commits, JSON.stringify(events), summary.ms ?? null]).catch(() => {});
  return summary;
}

async function askUncached({ question, refs = ["main"], emit, style = "auto", policy = null, conversation = null }) {
  const t0 = Date.now();
  const p = provider();
  const collectedEvidence = new Map();
  const collectedUnresolved = [];
  let toolCallCount = 0;
  const intent = resolveIntent(question, style);           // 'simple' | 'code'
  emit({ type: "intent", intent, chosen: style });

  if (p.mock) return mockRun({ question, refs, emit, t0 });
  if (looksLikeTicket(question)) return triageRun({ question, refs, emit, t0, p, policy, conversation });
  if (mode() === "sql") return sqlRun({ question, refs, emit, t0, p });
  if (mode() === "auto") return routeAuto({ question, refs, emit, t0, p, intent, policy, conversation });
  if (mode() === "plan") return planRun({ question, refs, emit, t0, p, intent, policy, conversation });
  if (mode() === "guided") return guidedRun({ question, refs, emit, t0, p, intent, policy });

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
/**
 * What the DOCUMENTS say, next to what the code does. Searches uploaded business documents and in-repo
 * docs, emits each passage as a DOCUMENT claim with its own evidence (so the UI can always show where it
 * came from), and returns the compact facts the answer is written from. Documents are DOCUMENTED evidence:
 * intent, not proof -- the prompt rules below make the answer say which side wins.
 * `hint` is extra text for the query (the anchor's human name, a route) so identifier-heavy questions
 * still land on the business rule written in product words.
 */
async function attachDocuments({ question, hint = "", refs, emit, seen = new Set(), k = 3, min_score = 0.5, deadline_ms = 0 }) {
  const query = hint ? `${question}\n${hint}` : question;
  // Never let documents slow the answer: past the deadline they are simply left out (warm search is ~12 ms).
  const search = searchDocs({ question: query, k, refs, min_score }).catch(() => ({ passages: [] }));
  const res = deadline_ms > 0
    ? await Promise.race([search, new Promise(r => setTimeout(() => r({ passages: [], timed_out: true }), deadline_ms))])
    : await search;
  if (res.timed_out) { emit({ type: "status", text: "documentation search skipped: over the time budget" }); return []; }
  const passages = res.passages || [];
  if (!passages.length) return [];
  emit({ type: "status", text: `reading ${passages.length} documentation passage${passages.length > 1 ? "s" : ""}: ${[...new Set(passages.map(p => p.title))].slice(0, 3).join(" · ")}` });
  for (const p of passages) if (!seen.has(`doc:${p.doc_id}`)) {
    seen.add(`doc:${p.doc_id}`);
    emit({ type: "evidence", id: `d${p.doc_id}`, repo: p.repo || "uploads", path: p.path, line: null, ref: refs.join(","), extractor: "docs" });
    emit({ type: "claim", id: `doc${p.doc_id}`, text: `DOCUMENT ${p.title} — ${p.heading_path}`, kind: "DOCUMENT", name: p.title, path: p.path, line: null,
           edge: "MENTIONS", depth: 0, evidence_ids: [`d${p.doc_id}`], confidence: Number(p.score.toFixed(2)) });
  }
  return passages.map(p => ({ title: p.title, path: p.path, source: p.source || "repo", kind: p.subkind, tags: p.tags,
                              heading: p.heading_path, score: Number(p.score.toFixed(2)), text: p.text.slice(0, 1800) }));
}

/** "Api::V1::ActivityLogsController#index" -> "api v1 activity logs controller index": product words for the doc search. */
const humanize = (s) => String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[:#_\/.\-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

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
  // business documents fire in mock mode too, so the UI's DOCUMENT rendering can be tested offline
  const documents = await attachDocuments({ question, hint: humanize(seed?.name || seed?.fqn), refs, emit, min_score: 0.72 });
  for (const d of documents) emit({ type: "token", text: `[MOCK] Documented: ${d.title} § ${d.heading}. ` });

  const summary = { type: "done", claim_count: claims.length + documents.length, evidence_count: ev.evidence.length + documents.length,
                    tool_calls: 4, unresolved_count: (trace.unresolved ?? []).length,
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
async function guidedRun({ question, refs, emit, t0, p, intent = "code", policy = null }) {
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
  // The business rule rides alongside the code trace: documents are searched with the anchor's human name
  // added to the question, in parallel, so the fast path stays fast and the answer can compare doc vs code.
  const [fwd, rev, documents] = await Promise.all([
    traceFrom({ entity_id: Number(seed.id), refs, depth: 6, direction: "forward" }),
    traceFrom({ entity_id: Number(seed.id), refs, depth: 3, direction: "reverse" }),
    // strict floor: relevant passages score ~0.8, unrelated in-repo docs ~0.67 with this model; 400 ms budget runs under the trace itself
    attachDocuments({ question, hint: [humanize(seed.name || seed.fqn), seed.attrs?.route_path || seed.attrs?.path_pattern || ""].filter(Boolean).join(" "), refs, emit, min_score: 0.72, deadline_ms: 400 }),
  ]);

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
    // what people WROTE the system should do, next to what the code DOES (DOCUMENTED: intent, not proof)
    documents: documents.slice(0, 3).map(d => ({ ...d, text: d.text.slice(0, 900) })),
  };
  {
    const c = assessConfidence({ lookups: [{ match: found.weak ? "approximate" : "exact", matched_on: token, anchor: { kind: seed.kind, name: seed.name || seed.fqn } }],
                                 documents, unresolved: (fwd.unresolved ?? []).length, truncated: !!fwd.truncated });
    facts.confidence = { level: c.level, reason: c.reason, ...(c.missing ? { missing: c.missing } : {}) };
  }

  const prompt = `Write a short answer to the question using ONLY the JSON facts below.

STRICT RULES
- Use only what is in the JSON. Invent nothing. You do not know this codebase otherwise.
- Cite path:line exactly as given. A null path means an HTTP endpoint contract with no
  source file -- say that, do not invent a path.
- If "unresolved" is non-empty you MUST say the trace stops there and why.
- If "truncated" is true, say the trace was bounded.
- If "hubs_not_expanded" is non-empty, name them and say they were skipped because too
  many things call them.
- "confidence" was computed from how the facts were found. On "high" state things as fact, with no hedging
  words (seems, appears, may, likely). On "medium" or "low" add ONE sentence at the end naming the missing
  piece ("confidence.missing"). Never open with a disclaimer about the match: "approximate_match" only means
  the name was matched loosely. Never write "I found", "the closest thing", "may not be exactly" or "the graph".
- Write for a colleague, not a log: describe what the code does and where. Do NOT narrate the
  mechanics -- never write "the anchor is", "the unresolved list is empty", "truncated is false",
  "no hubs were skipped", "the match was exact". Mention unresolved/truncated/hubs ONLY when they
  are non-empty or true, in one sentence at the end.
- If "documents" is non-empty: the code facts above are the answer; THEN add the business rule the
  documents state, in one or two sentences, citing each as <path> § <heading>. Say plainly whether the
  code AGREES with the document, CONFLICTS with it, or the code side is NOT VISIBLE in these facts. On a
  conflict the code wins and you say the document may be stale. A document is intent, never proof of
  what the code does -- do not restate a document as if it were observed code behaviour.
- End with the refs read (${refs.join(", ")}) in a short trailing clause.
- ${facts.documents.length ? "8" : "6"} sentences maximum. No preamble, no bullet lists.

FACTS
${JSON.stringify(policy ? redactFacts(facts, policy) : facts, null, 1).slice(0, 12000)}`;

  emit({ type: "status", text: `confidence ${facts.confidence.level}: ${facts.confidence.reason}` });
  emit({ type: "status", text: `writing the ${intent === "simple" ? "plain-English" : ""} answer (${p.model})`.replace("  ", " ") });
  const guidedSystem = intent === "simple"
    ? "You explain software to a non-engineer in plain, warm English. Use ONLY the JSON facts. Lead with what the user does and what happens. Prefer product words over code words. 3-5 sentences, then an optional short 'In the code' line naming real files from the facts. Invent nothing; if the facts fall short, say so."
    : SYSTEM;
  let text = "";
  try {
    for await (const delta of chatStream({
      messages: [{ role: "system", content: guidedSystem }, { role: "user", content: prompt }],
      max_tokens: 1400,
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
  const summary = { type: "done", claim_count: claims.length + documents.length, evidence_count: ev.evidence.length + documents.length,
                    tool_calls: 5, unresolved_count: (fwd.unresolved ?? []).length, confidence: facts.confidence.level,
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
 "live": [{"table": "<one of the live tables below>", "where": {"<col>": "<exact value>"}, "like": {"<col>": "<substring>"},
           "contains": {"<jsonb col>": {"value": true}}, "not_null": ["<col>"], "columns": ["<only the columns the question asks for>"], "limit": 50}],
 "config_for": [{"company": "<customer / tenant name as written, e.g. Reliance>", "keys_like": "<optional topic word: approval, po, vendor>", "only": "<optional: on | off | overrides>"}],
 "companies_with": [{"config_key": "<exact config_key>", "value": <true | false>}],
 "endpoint_families": ["<URL path prefix, e.g. /approval_workflow/approval_requests>"],
 "greps": ["<exact code token to find every occurrence of, e.g. self.mcp? or token_type>"],
 "want_source": <true if answering needs the actual code: any "why", "how does it decide", "what does it check",
                 "what would happen if", "which guards/conditions", or an explanation of behaviour>,
 "want_summaries": <true if the question asks for an overview, big picture, or "what does X do">,
 "want_owners": <true if the question asks who built, owns, or should be asked about something>}

Use "config_for" whenever the question asks what is on / off / enabled / configured FOR A NAMED CUSTOMER or tenant
(Reliance, Jindal, GMMCO...). It resolves the effective value per company exactly as the platform does (default <- company
master <- active override), so never answer such a question from master defaults alone. Use "companies_with" for
"which companies have X on/off" with the exact config_key. Both are read-only.
Use "sql" only when the fixed shapes cannot express what you need (a join, a count, a filter on attrs).
Schema for "sql":
${SCHEMA_DOC}
Use "live" (max 3) when the question asks what is ON or OFF, enabled, configured, active, which companies or
templates have something, or the CURRENT state of configuration -- that is data in the platform database, not code.
Live tables (a read-only mirror of UAT, allowlisted columns only):
${LIVE_DOC}
Set questions over configuration are LIVE queries with JSON filters, not lookups: "which configs default to true" ->
{"table":"master_configurations","contains":{"defaults":{"value":true}},"limit":50}; "who has X on" ->
{"table":"custom_configurations","where":{"config_key":"X","status":"1"}}. like.any searches several columns at once:
{"table":"master_configurations","like":{"any":{"columns":["config_key","name","description"],"value":"lot"}}}.
For "all / every / which ones / how many / list" questions set "limit": 200 so the whole set comes back (it is shown to
the user as a table); otherwise keep limit <= 50. Choose "columns" from the QUESTION: "what are the configs" -> ["config_key","name"];
"...and whether they are on" -> add "status"; "what do they do" -> add "description"; "which companies" -> add "company_id";
"details / everything about" -> all columns. Never return columns the question did not ask for.
"master config(s)" means live.master_configurations (it has its own status column); live.custom_configurations is only for
per-company OVERRIDES ("which companies have X on"). Do not answer a master-config question from custom_configurations.
If CANDIDATE CONFIGS are given, query THOSE keys (where config_key = the key) -- never a guessed substring.
Patterns: a company by name -> {"table":"companies","like":{"name":"reliance"}}; a switch by key ->
{"table":"master_configurations","like":{"config_key":"three_way"}} then {"table":"custom_configurations","like":{"config_key":"three_way"}};
approvals for a company -> TWO entries: {"table":"companies","like":{"name":"reliance"}} and
{"table":"approval_flows","where":{"company_id":"$companies.id"}} -- a value "$<table>.<column>" is filled in by the
service with the ids the first query returned. Prefer like{} on names/keys; keep limit <= 50.
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

CONFIDENCE -- facts.confidence was computed from HOW the facts were retrieved; your wording follows it
- level "high": state the answer plainly, as fact. No hedging words (seems, appears, may, likely, possibly).
- level "medium": answer plainly, then one sentence naming the weaker link (facts.confidence.missing) where it matters.
- level "low": say what the facts do show, then ONE sentence stating the missing piece (facts.confidence.missing).
  Do not pad a low-confidence answer with adjacent facts to make it look fuller.
- Never write boilerplate about your own certainty, and never invent a caveat the facts do not carry.
- Section 6 copies facts.confidence.level and its reason; do not grade yourself differently.

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
  "unresolved", "truncated", "hubs_not_expanded", and "match" (exact | approximate | none). "match" says how the
  anchor was FOUND (an exact name, a loosely matched token, nothing) -- a retrieval detail, not a verdict on
  relevance; facts.confidence has already weighed it.
- For a CALLS hop, edge_resolution is what matters: RUNTIME means that call was OBSERVED during a real test run.
  If the hop also carries "observed_at", the observation was made on that earlier commit and carried forward
  because both files are unchanged since -- say "observed in tests at <observed_at>; code unchanged since".
- Resolutions tell you HOW a fact is known. Treat them differently and say which when it matters:
    RUNTIME        observed during real test execution -- strongest evidence
    EXACT / FRAMEWORK_DUMP   read directly from source structure or from Rails' own route table -- reliable
    HEURISTIC      inferred from a name -- say "inferred", never state it as observed
    AMBIGUOUS      could not be resolved statically -- this is where the trace legitimately stops
- Edge names mean: TARGETS = frontend call site hits an endpoint; SERVES = a route serves it; HANDLED_BY =
  route -> controller action; DECLARES = class/handler owns method; CALLS = method calls method;
  TRIGGERS_DEFECT = a known bug lies on this path.

DOCUMENTS -- what people WROTE the system should do (business logic), next to what the code DOES
- "documents" are passages from human-written docs: design docs and READMEs inside the repo at the indexed
  commit (source "repo"), or uploaded business documents such as PRDs and process docs (source "upload").
  Cite them as <path> § <heading>. Their resolution is DOCUMENTED: intent, not proof.
- When the question is about business rules or intended behaviour, lead with the documented rule, then
  state what the code shows. If they DIFFER, that is a finding: one line naming both sides; code facts (source,
  routes, runtime calls) win, and the doc may be stale. If they agree, do not say so -- answer once. If the code
  side is not in the facts, say that in one clause, not a paragraph.
- Never treat a document as proof that code exists. A doc naming a method is a MENTION, not a definition.

LIVE PLATFORM DATA -- the CURRENT configuration, from a read-only mirror of the UAT database
- "live" entries are rows from allowlisted UAT tables: which company has which config on, which templates and
  approval flows exist and their status. They are STATE as of "as_of" (say the time), on UAT (say so: UAT is
  not production). "total" is exact; if "complete" is false say "showing N of M".
- status columns: 1 = active/on, 0 = inactive/off, unless the facts say otherwise. custom_configurations
  overrides master_configurations for that company/template; the "modifications" column holds the override value.
- If a live entry has "full_table_shown_to_user": true, the user already sees the COMPLETE table of those rows next to
  your answer -- ALL "rows_shown_to_user" rows, not the sample of "rows_in_this_view" you were given. Never say the
  table shows fewer rows than "total"; the sample is for you, not the reader. Do not enumerate; give the exact total,
  describe what is in the table (groups, notable rows, patterns), and say "see the table below".
- "live_config_greps" show where the CODE reads a config_key that came back from live data -- this is the join
  between configuration and behaviour. Use it: "X is on for <company> (as of ...), and the code checks it in <file:line>".
- "effective_configuration": the switches of a NAMED customer with the value the platform actually applies and its source (default,
  company master, override). This is the answer for "what is on/off for <customer>"; quote effective values and sources, name company ids
  when several companies match, and say the master default only as the baseline an override changed. "companies_with" counts companies
  at a value with the same precedence.
- "template_views": a template exactly as the dashboard lays it out. layout "sheet" = columns in groups (line item columns, event-level price components);
  layout "form" = pages of questions. side creator = the buyer fills it, participant = the supplier answers. The user already sees it rendered;
  explain what it collects and who fills what, do not re-list every column or question.
- "screen_journey" is the REAL navigation chain between dashboard screens (from the code), with the click that leads from each screen to the next
  and the key actions on each screen. When present, it is the backbone of the answer: walk it screen by screen, name the click for each hop, and
  for each screen say what the buyer does there and what the system does after (backend_apis / other facts). Do not say the graph lacks the
  screen sequence when screen_journey is present. "screens" are the same details for individual screens.
- Nodes of kind UI_ROUTE are dashboard screens (name + route path) and UI_ACTION are the buttons, wizard steps, tabs and dialogs on them
  (attrs.screen says which screen). For "how do I / where do I / walk me through" questions, describe the journey as screens and clicks in order,
  using these names exactly; then say what happens in the system after each click. Edges NAVIGATES_TO say which screen leads to which.
- "live_candidates" (platform rows: templates, approval flows, datasources, with their company) and "config_candidates"
  (configuration switches: key, human name, description, default, how many companies have it on) are present ONLY
  when the question is about configuration or platform state -- at most two, ranked by meaning. Use them to name the
  actual template, flow or switch the question is about. For "which config / what is the setting for X": the top
  candidate by key AND human name, its default, who has it on, and where the code reads it (live_config_greps); if the
  two are close, name both and say which fits better. Never invent a key. When they are absent, the question was not
  about state: do not bring configuration or approval-flow counts into the answer.
- Three sources, three roles: documents = the intended rule; code = how it is enforced; live = who has it on now.
  Keep them distinct in the answer, and never present live state as the rule or the rule as the state.

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
1. Answer -- 2-3 sentences that directly answer the question, stated as fact when confidence is high.
2. Evidence path -- numbered hops. Each hop: kind, name, path:line, and [RUNTIME] / [EXACT] / [HEURISTIC]
   where it matters. Frontend -> endpoint -> route -> handler -> methods -> data.
3. Data & side effects -- tables, columns, external services touched, if any appear in the facts.
   Only DB_TABLE nodes are tables (snake_case names from db/schema.rb). A Ruby class such as Workflow or
   Approval is a MODEL -- label it "model", never "table".
4. Known defects on this path -- summary, root cause, fix, from defect records; or "none recorded".
5. Not covered -- concrete gaps in the indexed code, and the exact file:line to open to close each one.
   The file you point at MUST appear in the facts. If the facts hold no such file, describe the thing
   ("the Bid model") without a path -- never guess a path, not even with "likely" or "probably".
6. Confidence -- facts.confidence.level and its reason, as given.

HARD RULES
- A lookup with match "approximate" was found by a loosely matched token, not an exact name. That is NOT a reason
  to open with a disclaimer: answer about what was found, and only when facts.confidence is "low" add one closing
  sentence such as "This is based on <anchor name>; if you meant something else, name the screen, file or feature."
  When screen_journey is present, the journey is the subject and the fuzzy flag on lookups is irrelevant.
- Never invent a file, line, method, table, or route. Every named artifact must appear in the facts.
- If a lookup has match "none", say "no node matched <q>" -- do not fill the gap from general Rails/React knowledge.
- If "unresolved" is non-empty, say the trace stops there and why.
- If "truncated" is true or "hubs_not_expanded" is non-empty, say so.
- Name the refs read: they are in facts.refs. Tenants run different code.
- Prefer precision over completeness. A shorter correct answer beats a longer padded one. Side facts -- endpoints
  and jobs not on the path asked about (a retrigger endpoint, a background job), counts of approval flows or
  configurations, other companies' settings -- appear ONLY when the question asks for them.
- Say each thing once. Never write the same sequence twice (prose, then an arrow list): the steps live in the
  Evidence path; section 1 states the outcome.
- Banned phrases: "I found", "the closest thing", "may not be exactly", "the graph", "the facts show",
  "based on the facts", "it seems", "appears to". Say "the indexed code" when you must refer to the index, and
  state findings directly.
- THIS SYSTEM IS READ-ONLY. It cannot change, enable, disable, create or delete anything -- not code, not
  configuration, not platform data -- and it has no connection that could. If the question asks for a change,
  say plainly that you cannot and only report the current state, then say where a human would make the change
  (the admin screen or config table involved, from the facts). Never imply an action was taken.
- Never enumerate more than 12 items inline. Name the 12 most relevant, then say "and N more" with the
  exact count from the facts. Long lists crowd out sections 4-6, and an answer cut off before section 5
  hides the gaps -- the one thing this system must never do.

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

SHAPE OF THE ANSWER -- always in this order, each part once
1. The answer: two or three plain sentences that answer the question directly. No preamble, no "here is the flow".
2. The steps, ONLY if the question is about a process or journey: one numbered list, one step per line, in the
   order the person experiences them -- the screen, the click, what happens next. Take them from "screen_journey"
   when present (its hops are real clicks read from the dashboard code), else from "documents" or "overviews".
   Write the sequence once: never a prose walkthrough AND an arrow list of the same steps.
3. One line ONLY if the documents and the code differ on something: what the document says, what the code does.
   If they agree, write nothing about agreement. Name the document by its title so they can open it.
4. Optionally, if the person asked where in the code or how it is enforced: an "In the code" line naming 1-3
   real files from the facts. Otherwise leave it out.
Plain, warm, direct English. Short sentences. No headings, no evidence tables. Product words (an approval, a bid,
a supplier, a screen) over code words (controller, endpoint, model). Explain any unavoidable term in a few words.

CONFIDENCE -- facts.confidence was computed from how the facts were found; your wording follows it
- "high": state it as fact. No hedging words (seems, appears, may, likely, possibly, I think).
- "medium": state it plainly, then one sentence on the weaker link (facts.confidence.missing) if it matters.
- "low": say what IS covered, then ONE sentence stating the missing piece (facts.confidence.missing), for example
  "The approval step itself is not covered in the indexed documents." Then stop. Do not pad with adjacent facts
  to make the answer look fuller.
- Never write boilerplate about your own certainty, and never invent a caveat the facts do not carry.

WHAT THE FACTS ARE
- "overviews" are written for this audience: use them first, then add specifics.
- "screen_journey" and "screens" are real dashboard screens, the clicks between them and the key actions on each.
  Use their names exactly.
- "documents" are what the team WROTE about how things should work (design docs, PRDs, process docs).
- "live" rows are the current configuration on UAT (not production) as of the time shown: who has what switched
  on, which templates and approval flows exist. Say the time and "on UAT". Status 1 means on, 0 off.
- If a live entry has "full_table_shown_to_user": true, the person already sees the complete table of ALL those
  rows under your answer (every one of "total"; you were given a sample). Give the exact count, describe what is
  in it in a few sentences, then say "see the table below". Never claim the table shows fewer rows.
- "config_candidates" and "live_candidates" are present ONLY when the question is about a setting or platform
  state, at most two. When asked which setting does X, name the best one by its key and its plain name, say its
  default and how many companies have it on. Never invent a key that is not in the facts.
- "effective_configuration" is what a named customer actually has on or off, with where each value comes from.
- "template_views" is a template as the dashboard lays it out; the person already sees it rendered.

HARD RULES -- these keep it honest
- Use ONLY the facts. Never invent a feature, screen, file, number, or behaviour. If part of the question is not
  covered, say so in one sentence ("<that part> is not covered in the indexed code or documents") and stop -- do
  not fill it from general knowledge of how such software usually works.
- Side facts appear ONLY when asked: API paths, retrigger or background jobs, counts of approval flows or
  configurations, other companies' settings, and anything that merely sounds related. A journey answer never
  mentions how many approval flows or switches exist.
- A "match: approximate" on a lookup means the code was found by a similar name. It is NOT a reason for a
  disclaimer: answer about what was found, and only when facts.confidence is "low" end with one sentence such as
  "This is based on the Awarding screen; if you meant another screen, name it." When "screen_journey" is present,
  the journey is the subject and that flag does not matter.
- If nothing matched (match "none" everywhere, no journey, no documents), say you could not find it and suggest
  asking with a feature or screen name. Do not guess.
- Banned words and phrases: "I found", "the closest thing", "may not be exactly", "the graph", "the facts",
  "based on the facts", "it seems", "appears to", "the anchor", "unresolved", "truncated", "hops", "the trace".
- Every file you name in the optional "In the code" line must appear in the facts.
- You can only READ. If asked to change, switch on/off, add or remove anything, say you cannot do that here,
  report what the current state is, and point to where a person would change it.`;

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
  const edgeObsInto = new Map(fwd.edges.filter(e => e.observed_at).map(e => [String(e.dst), e.observed_at]));
  const hop = (n, i) => ({ kind: n.kind, name: n.name || n.fqn, path: n.path, line: n.line,
                            edge: edgeInto.get(String(n.id)) || null,
                            edge_resolution: edgeResInto.get(String(n.id)) || null,   // RUNTIME = observed in tests
                            ...(edgeObsInto.has(String(n.id)) ? { observed_at: edgeObsInto.get(String(n.id)).slice(0, 8) } : {}),
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
  const out = text.replace(/`?((?:[\w.-]+\/)+[\w.-]+\.(?:rake|jsx|tsx|erb|yml|rb|js|ts))(:\d+(?:-\d+)?)?`?/g, (m, pth) => {
    const ok = known.some(k => k === pth || k.endsWith("/" + pth) || pth.endsWith("/" + k)) || bases.has(pth.split("/").pop());
    if (ok) return m;
    removed++;
    return "a file the graph did not supply";
  });
  return { text: out, removed };
}
const pathsIn = (json) => new Set((json.match(/[\w./-]+\.(?:rake|jsx|tsx|yml|erb|rb|js|ts)\b/g) || []).filter(x => x.includes("/")));

/** Every file path the model was shown, so a checker can tell "invented" from "given in a list". */
function emitContextPaths(factsJson, emit) {
  const paths = new Set((factsJson.match(/[\w./-]+\.(?:jsx|tsx|yml|erb|rb|js|ts)\b/g) || []).filter(x => x.includes("/")));
  if (paths.size) emit({ type: "context_paths", paths: [...paths].slice(0, 400) });
}

async function routeAuto({ question, refs, emit, t0, p, intent, policy = null, conversation = null }) {
  const a = await anchor(question, refs);
  const exactIdent = !!a.seed && !a.weak && IDENTIFIER_RE.test(a.token || "");
  // Fast path only for a code-intent, exact-identifier, non-"why" question.
  if (intent === "code" && exactIdent && !isOverview(question) && !THOUGHT_RE.test(question))
    return guidedRun({ question, refs, emit, t0, p, intent, policy });
  return planRun({ question, refs, emit, t0, p, intent, policy, conversation });
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
    () => { for (const l of facts.live || []) if (l.rows) l.rows = l.rows.slice(0, 12); },
    () => { if (facts.documents) facts.documents = facts.documents.slice(0, 3).map(d => ({ ...d, text: d.text.slice(0, 900) })); },
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
async function writeAnswer({ question, facts, emit, budget, system = ANSWER_SYSTEM, flow = false }) {
  const known = pathsIn(JSON.stringify(facts));
  let text = "", shownJson = "";
  const run = async (json) => {
    shownJson = json;
    const sys = system + (facts.conversation ? "\n" + CONVERSATION_RULE : "") + (flow ? "\n" + FLOW_RULES : "");
    const messages = [{ role: "system", content: sys }, { role: "user", content: `QUESTION: ${question}\n\nFACTS:\n${json}` }];
    let t = "";
    for await (const d of chatStream({ messages, max_tokens: flow ? 3200 : 2400, temperature: 0 })) t += d;
    if (!t) t = (await chat({ messages, max_tokens: flow ? 3200 : 2400, temperature: 0 })).content || "";
    return t;
  };
  try { text = await run(shrink(structuredClone(facts), budget)); }
  catch (e) { emit({ type: "status", text: `answer failed (${String(e.message).slice(0, 80)}); retrying with fewer facts` }); }
  if (!text) {
    try { text = await run(shrink(structuredClone(facts), Math.floor(budget / 2))); }
    catch (e) { emit({ type: "error", code: "llm_failed", message: e.message }); }
  }
  if (!text) { emit({ type: "token", text: "(No prose available - the language model call failed twice. The claims and evidence above come from the code graph and are unaffected.)" }); return ""; }
  // the diagram block comes out of the text first; its refs are checked against exactly what the model saw
  let split = flow ? extractFlow(text, shownJson) : { text, flow: null };
  if (flow && !split.flow) {
    // the model wrote prose without the block (or an unusable one): ask once more for the block alone, from its own answer
    emit({ type: "status", text: `no diagram in the first pass (${split.dropped || "no block"}); asking for the steps` });
    try {
      const messages = [{ role: "system", content: "You turn an answer into a workflow diagram. Output ONLY the fenced ```flow block described below, nothing else.\n" + FLOW_RULES },
                        { role: "user", content: `QUESTION: ${question}\n\nANSWER:\n${split.text}\n\nFACTS (for refs):\n${shownJson.slice(0, 20000)}` }];
      let t = "";
      for await (const d of chatStream({ messages, max_tokens: 1200, temperature: 0 })) t += d;
      const second = extractFlow(`${split.text}\n\n${t}`, shownJson);
      if (second.flow) split = { text: split.text, flow: second.flow };
      else split = { ...split, dropped: second.dropped || split.dropped };
    } catch (e) { split = { ...split, dropped: `second pass failed: ${String(e.message).slice(0, 60)}` }; }
  }
  if (split.flow) emit({ type: "flow", ...split.flow, steps_total: split.flow.steps.length });
  else if (flow && split.dropped) emit({ type: "status", text: `no diagram: ${split.dropped}` });
  const clean = sanitizePaths(split.text, known);
  if (chatStream.lastModel && chatStream.lastModel !== provider().model)
    emit({ type: "status", text: `primary model stalled; answered by fallback model ${chatStream.lastModel}` });
  emit({ type: "token", text: clean.text });
  if (clean.removed) emit({ type: "status", text: `removed ${clean.removed} file path${clean.removed > 1 ? "s" : ""} the model guessed but was not given` });
  return clean.text;
}

/**
 * Run the planner's live queries. Two rounds: queries whose filter values reference another live table's
 * column ("$companies.id") wait for that table's rows and are expanded to the ids found (cap 50). This lets
 * "approval flows for Reliance" resolve company -> flows without a second model call.
 */
const LIVE_TABLES_KEY = { templates: "id", approval_flows: "id", fx_datasources: "id", procol_variables: "id" };
async function runLivePlan(specs, question = "") {
  const list = (specs || []).filter(x => x && typeof x.table === "string").slice(0, 4).map(x => {
    // "master config(s)" is the catalogue table; the overrides table only answers "which companies have X on".
    if (/master[ _-]?config/i.test(question) && x.table === "custom_configurations" && !x.where?.company_id && !/\b(compan|tenant|client)/i.test(question))
      x = { ...x, table: "master_configurations", where: Object.fromEntries(Object.entries(x.where || {}).filter(([c]) => ["config_key", "status", "item_type"].includes(c))) };
    // The question's own words are authoritative over the planner's filters:
    //  - "show whether each is on" means status is a COLUMN to display, not a filter -- drop a status filter;
    //  - "default true/false" on the catalogue is a JSON filter on defaults, whether or not the planner wrote it.
    if (/\b(show|whether|which (are|ones are)|are they|is it|and (their|its) status)\b/i.test(question) && /\b(on|off|status|switched|enabled|active)\b/i.test(question) && x.where?.status !== undefined) {
      const w = { ...x.where }; delete w.status; x = { ...x, where: w };
    }
    const m = question.match(/default(?:\s+value)?s?\s+(?:is|are|set to|of|=|to)?\s*(true|false|on|off)\b/i);
    if (m && x.table === "master_configurations" && !(x.contains && x.contains.defaults)) {
      const v = /true|on/i.test(m[1]);
      x = { ...x, contains: { ...(x.contains || {}), defaults: { value: v } } };
    }
    return x;
  });
  const refRe = /^\$([a-z_]+)\.([a-z_]+)$/;
  const dependsOn = (x) => Object.values(x.where || {}).map(v => typeof v === "string" && v.match(refRe)).filter(Boolean);
  const run = (x) => queryLive({ table: x.table, where: x.where || {}, like: x.like || {}, contains: x.contains || {}, not_null: Array.isArray(x.not_null) ? x.not_null : [],
                                 limit: Math.min(Number(x.limit) || 50, 500) }).then(r => ({ ...r, asked_columns: Array.isArray(x.columns) && x.columns.length ? x.columns : null }))
                               .catch(e => ({ error: e.message, table: x.table }));
  const first = list.filter(x => !dependsOn(x).length), second = list.filter(x => dependsOn(x).length);
  const results = await Promise.all(first.map(run));
  const byTable = new Map(first.map((x, i) => [x.table, results[i]]));
  for (const x of second) {
    const where = { ...(x.where || {}) };
    let ok = true;
    for (const [c, v] of Object.entries(where)) {
      const m = typeof v === "string" && v.match(refRe);
      if (!m) continue;
      const src = byTable.get(m[1]);
      const ids = [...new Set((src?.rows || []).map(r => r[m[2]]).filter(v2 => v2 !== null && v2 !== undefined))].slice(0, 50);
      if (!ids.length) { ok = false; results.push({ table: x.table, error: `no ${m[1]} rows to take ${m[2]} from` }); break; }
      where[c] = ids.map(String);
    }
    if (ok) results.push(await run({ ...x, where }));
  }
  return results;
}

/** "List all X" must mean all: if a set question came back incomplete but the whole set fits, fetch it whole. */
async function completeSets(question, results) {
  if (!/\b(all|every|which|how many|list|each)\b/i.test(question)) return results;
  return Promise.all(results.map(async (r) => {
    if (!r || r.error || r.complete || !r.total || r.total > 500) return r;
    const full = await queryLive({ table: r.table, where: r.where || {}, like: r.like || {}, contains: r.contains || {}, limit: 500 }).catch(() => null);
    return full && !full.error ? full : r;
  }));
}

async function planRun({ question, refs, emit, t0, p, intent = "code", policy = null, conversation = null }) {
  const canSource = !policy || policy.code_source;      // restricted roles never read or grep source
  // Phase 0: candidates by MEANING. Fails soft when no embeddings exist. The pilot measured this as the
  // difference between 5/8 and 7/8 on questions asked in everyday words.
  let sem = [];
  try { sem = (await semanticAnchor({ question, k: 8, refs })).matches.filter(m => Number(m.score) >= 0.55); } catch { /* no embeddings for this model */ }
  // Configuration questions: find the switch by MEANING over the live catalogue before planning, so the
  // planner works from real keys ("fx_response_sequence_advisory_lock_enabled") instead of guessing substrings.
  const CONFIG_RE = /\b(config(uration)?s?|setting|switch|flag|toggle|enabled?|disabled?|turn(ed)? (on|off)|lock|master config|custom config|default value|feature (on|off))\b/i;
  // The live layer is searched by meaning (~10 ms each): the config catalogue, and the names of templates, approval
  // flows, datasources and environment switches. These are SIDE CHANNELS: they reach the planner and the writer only
  // when the question is about platform state (configuration words, a named customer, a live entity) or when the
  // planner asks for live data -- otherwise a row that merely sounds similar becomes padding in the answer
  // ("77 approval flows for create_trade" under a question about the awarding journey).
  const STATE_RE = /\b(config(uration)?s?|settings?|switch(es)?|flags?|toggles?|enabled?|disabled?|turn(ed)? (on|off)|switch(ed)? (on|off)|defaults?|master config|custom config|feature flag|templates?|approval (flows?|keys?)|datasources?|procol variables?|compan(y|ies)|customers?|tenants?|clients?|who has|which (companies|clients|customers|tenants)|on uat)\b/i;
  let configs = [], liveHits = [], mentioned = [];
  const [cfgRes, liveRes0, mentionedRes] = await Promise.all([
    searchConfigs({ question, k: 6, min_score: CONFIG_RE.test(question) ? 0.55 : 0.62 }).catch(() => ({ configs: [] })),
    searchLive({ question, k: 6, min_score: 0.6 }).catch(() => ({ hits: [] })),
    companyMentions(question).catch(() => []),
  ]);
  configs = cfgRes.configs || []; liveHits = liveRes0.hits || []; mentioned = mentionedRes || [];
  const stateQuestion = STATE_RE.test(question) || mentioned.length > 0;
  // the planner sees a few more than the writer will: it needs exact keys and ids to write live queries
  const plannerConfigs = stateQuestion ? configs.slice(0, 4) : [], plannerLive = stateQuestion ? liveHits.slice(0, 4) : [];
  const candText = (sem.length
    ? "\n\nCANDIDATE NODES (real graph names ranked by meaning; use their exact names as lookups when they fit):\n"
      + sem.map(m => `- ${m.kind} | ${m.name || m.fqn} | ${m.path || ""}`).join("\n")
    : "") + (plannerLive.length
    ? "\n\nCANDIDATE LIVE ROWS (real rows from the platform mirror, ranked by meaning; query them by id with where{} instead of guessing names):\n"
      + plannerLive.map(h => `- ${h.kind} id=${h.ref_id}${h.company ? ` | company ${h.company}` : ""} | ${h.text.slice(0, 90)}`).join("\n")
    : "") + (plannerConfigs.length
    ? "\n\nCANDIDATE CONFIGS (real config_keys from the live catalogue, ranked by meaning -- use these exact keys in live where{} filters; do not guess substrings):\n"
      + plannerConfigs.map(c => `- ${c.config_key} | "${c.name || ""}" | default ${JSON.stringify(c.defaults)} | on for ${c.companies_active} companies`).join("\n")
    : "");

  // Phase A: plan
  const tPlan = Date.now();
  emit({ type: "status", text: `planning (${p.model})${sem.length ? ` with ${sem.length} candidates by meaning` : ""}` });
  let plan = null;
  try {
    const convText = conversation ? `\n\nCONVERSATION SO FAR (context for what the question means; plan for the QUESTION, not for these):\n${JSON.stringify(conversation.map(c => ({ q: c.understood_as || c.question, about: (c.about || []).map(a => a.name) })))}` : "";
    const m = await chat({ messages: [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: `QUESTION: ${question}${candText}${convText}` }], max_tokens: 1500, temperature: 0, reasoning_effort: "minimal" });   // structured extraction: minimal thinking; the JSON itself is ~150 tokens
    plan = extractJson(m.content || "");
    if (chatStream.lastModel && chatStream.lastModel !== p.model) emit({ type: "status", text: `planner: primary model produced nothing in time; plan came from fallback ${chatStream.lastModel}` });
  } catch (e) { emit({ type: "status", text: `planner failed (${String(e.message).slice(0, 120)}); using identifiers and candidates` }); }

  // SIDE FACTS -- the switches and rows found by meaning reach the writer only when asked for (by the planner or by the
  // wording), and then only the top two that stand clear of the rest. Template previews keep the raw hits (they are
  // rendered, not narrated, and already need the word "template").
  const rawLive = liveHits;
  const planAskedLive = !!((plan?.live && plan.live.length) || (Array.isArray(plan?.config_for) && plan.config_for.length) || (Array.isArray(plan?.companies_with) && plan.companies_with.length));
  const sideAllowed = planAskedLive || stateQuestion;
  const cfgTop = sideAllowed ? clearTop(configs, c => Number(c.score), { floor: CONFIG_RE.test(question) ? 0.55 : 0.62, lenient: planAskedLive || CONFIG_RE.test(question) }) : { kept: [], dropped: configs.length, flat: false };
  const liveTop = sideAllowed ? clearTop(liveHits, h => Number(h.score), { floor: 0.62, lenient: planAskedLive }) : { kept: [], dropped: liveHits.length, flat: false };
  configs = cfgTop.kept; liveHits = liveTop.kept;   // from here on, only what the writer may see
  if (configs.length) emit({ type: "status", text: `configuration switches by meaning: ${configs.map(c => c.config_key).join(" · ")}${cfgTop.dropped ? ` (${cfgTop.dropped} weaker left out)` : ""}` });
  if (liveHits.length) emit({ type: "status", text: `live rows by meaning: ${liveHits.map(h => `${h.kind}#${h.ref_id} ${h.text.slice(0, 40)}`).join(" · ")}${liveTop.dropped ? ` (${liveTop.dropped} weaker left out)` : ""}` });
  if (!sideAllowed && (cfgTop.dropped || liveTop.dropped)) emit({ type: "status", text: `left out ${cfgTop.dropped + liveTop.dropped} switches and platform rows that only sound similar: the question is not about configuration or platform state` });

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

  const [results, listRes, sqlRes, famRes, docRes, liveRes] = await Promise.all([
    Promise.all(lookups.map(l => lookupOne(l, refs, emit, seen))),
    Promise.all(specs.map(spec => listEntities({ kind: spec.kind, path_prefix: spec.path_prefix ?? null, name_contains: spec.name_contains ?? null, subkind: spec.subkind ?? null, refs, limit: LIST_LIMIT }))),
    Promise.all(sqlStmts.map(stmt => runSql({ sql: stmt }).then(r => ({ stmt, r })))),
    Promise.all(prefs.map(pref => endpointFamily({ path_prefix: pref, refs }))),
    attachDocuments({ question, refs, emit, seen, k: 6, min_score: 0.45 }),   // what the DOCS say, next to what the code does
    runLivePlan((plan?.live && plan.live.length) ? plan.live : liveHits.length ? [...new Set(liveHits.map(h => h.kind))].slice(0, 2).map(kind => ({ table: kind, where: { [ (LIVE_TABLES_KEY[kind] || "id") ]: liveHits.filter(h => h.kind === kind).map(h => String(h.ref_id)) }, limit: 50 })) : [], question),   // live rows: the planner's, else the candidates found by meaning
  ]);
  const documents = docRes;
  const live = await completeSets(question, liveRes.filter(Boolean));
  for (const l of live) emit({ type: "status", text: l.error ? `live data: ${l.error}` : `live platform data: ${l.table} — ${l.total} row${l.total === 1 ? "" : "s"}${l.complete ? "" : ` (showing ${l.returned})`}, as of ${l.as_of ? new Date(l.as_of).toISOString().slice(11, 16) + " UTC" : "unknown"}` });
  // A list is DATA, not prose. Any live result with more than a handful of rows is shown to the user as an exact
  // table (all rows, as of the sync time); the model gets a compact projection and is told to summarise, not enumerate.
  const cell = (v) => v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 120);
  // Columns follow the QUESTION. Identity columns always; more only when the wording asks for it.
  const IDENTITY = { master_configurations: ["config_key", "name"], custom_configurations: ["config_key", "company_id", "status"], procol_variables: ["key", "status"],
                     companies: ["id", "name"], templates: ["name", "template_type"], template_responses: ["id", "template_id", "status"],
                     approval_flows: ["name", "approval_key"], approval_flow_conditions: ["approval_flow_id", "approval_condition_id"],
                     fx_datasources: ["name", "tenant_id"], fx_datasource_fields: ["name", "fx_datasource_id"] };
  const WANT = [[/\b(status|active|inactive|enabled|disabled|on|off|switched)\b/i, ["status"]], [/\b(describ|what (it|they) do|meaning|explain|purpose)/i, ["description"]],
                [/\b(default)/i, ["defaults"]], [/\b(compan|tenant|who has|which (client|customer)s?)\b/i, ["company_id", "tenant_id"]],
                [/\b(when|updated|changed|last|recent|date)\b/i, ["updated_at"]], [/\b(type|kind)\b/i, ["template_type", "item_type", "data_type"]],
                [/\b(config(uration)?|json|value)\b/i, ["configurations", "config", "modifications", "validations"]], [/\b(rule|trigger|condition)/i, ["approval_trigger_rule", "trigger_values"]]];
  // The question decides what the reader sees. The planner's "columns" only narrow the FETCH; the table shows the
  // identity columns plus whatever the wording asked for, and never a column that IS the filter (identical in every row).
  const columnsFor = (l) => {
    const avail = Object.keys(l.rows[0]);
    if (/\b(details?|everything|all (the )?(columns|fields|info)|full)\b/i.test(question)) return avail.slice(0, 8);
    const filterCols = new Set([...Object.keys(l.where || {}), ...Object.keys(l.contains || {})]);
    const want = new Set((IDENTITY[l.table] || avail.slice(0, 2)).filter(c => avail.includes(c)));
    for (const [re, cols] of WANT) if (re.test(question)) for (const c of cols) if (avail.includes(c) && !filterCols.has(c)) want.add(c);
    return avail.filter(c => want.has(c)).slice(0, 8);
  };
  for (const l of live) {
    if (l.error || !l.rows?.length || l.rows.length <= 5) continue;
    const cols = columnsFor(l);
    emit({ type: "table", title: `${l.table}${Object.keys(l.like || {}).length || Object.keys(l.where || {}).length || Object.keys(l.contains || {}).length ? " (filtered)" : ""} — ${l.total} row${l.total === 1 ? "" : "s"} on UAT`,
           columns: cols, rows: l.rows.map(r => cols.map(c => cell(r[c]))), total: l.total, complete: l.complete, as_of: l.as_of, source: l.table });
    l.full_table_shown_to_user = true;
    l.rows_shown_to_user = l.rows.length;                 // the user's table has EVERY returned row
    l.rows_in_this_view = Math.min(40, l.rows.length);    // the model sees a sample; it must not quote this number
    l.rows = l.rows.slice(0, 40).map(r => Object.fromEntries(cols.slice(0, 5).map(c => [c, cell(r[c])])));   // compact view for the model
  }
  // PER-COMPANY CONFIGURATION -- the planner's config_for / companies_with, plus a deterministic fallback: a named
  // company in a configuration question always gets the effective table, never master defaults alone.
  const configForSpecs = (Array.isArray(plan?.config_for) ? plan.config_for : []).filter(x => x && (x.company || x.company_ids)).slice(0, 2);
  const CONFIG_WORDS = /\b(config|configs|configuration|configurations|setting|settings|switch|switches|enabled|disabled|turned (on|off)|switched (on|off)|\bon\b|\boff\b|default|defaults|allow|allowed|feature flag)/i;
  if (!configForSpecs.length && CONFIG_WORDS.test(question)) {
    if (mentioned.length) configForSpecs.push({ company_ids: [...new Set(mentioned.map(m => m.id))].slice(0, 6), company: mentioned[0].mention,
                                                only: /\b(off|disabled|switched off|turned off|not enabled)\b/i.test(question) ? "off" : /\b(on|enabled|switched on|turned on|active)\b/i.test(question) ? "on" : /\boverrid/i.test(question) ? "overrides" : null,
                                                keys_like: (configs[0]?.config_key && /\b[a-z_]{6,}\b/.test(configs[0].config_key) ? null : null) });
  }
  const effectiveConfigViews = [];
  for (const spec of configForSpecs) {
    const r = await configFor({ company: spec.company || null, company_ids: spec.company_ids || null, keys_like: spec.keys_like || null, only: spec.only || null }).catch(e => ({ error: e.message }));
    if (r.error) { emit({ type: "status", text: `configuration for ${spec.company || spec.company_ids}: ${r.error}` }); continue; }
    effectiveConfigViews.push(r);
    emit({ type: "status", text: `effective configuration for ${r.companies.map(c => `${c.name} (#${c.id})`).join(", ")}${r.total_matches > r.companies.length ? ` and ${r.total_matches - r.companies.length} more` : ""}: ${r.agree.length} agree, ${r.differ.length} differ${spec.only ? ` (only ${spec.only})` : ""}` });
    const cols = r.companies.length === 1 ? ["config_key", "name", "effective", "source"] : ["config_key", "name", ...r.companies.map(c => `${c.name} #${c.id}`)];
    const rows = r.companies.length === 1
      ? r.agree.map(a => [a.config_key, a.name, JSON.stringify(a.effective), a.sources])
      : [...r.agree.map(a => [a.config_key, a.name, ...r.companies.map(() => JSON.stringify(a.effective))]),
         ...r.differ.map(d => [d.config_key, d.name, ...r.companies.map(c => { const x = d.per_company.find(p => p.company_id === c.id); return x ? `${JSON.stringify(x.effective)} (${x.source})` : "n/a"; })])];
    if (rows.length) emit({ type: "table", title: `Effective configuration for ${r.companies.map(c => c.name).join(", ")}${spec.only ? ` — only ${spec.only}` : ""} — ${rows.length} switch${rows.length === 1 ? "" : "es"} on UAT`,
                            columns: cols, rows, total: rows.length, complete: true, as_of: r.as_of, source: "effective_configuration" });
  }
  const companiesWithViews = [];
  for (const spec of (Array.isArray(plan?.companies_with) ? plan.companies_with : []).filter(x => x && x.config_key).slice(0, 2)) {
    const r = await companiesWith({ config_key: spec.config_key, value: spec.value === undefined ? true : spec.value }).catch(e => ({ error: e.message }));
    if (!r.error) { companiesWithViews.push(r); emit({ type: "status", text: `${r.matching} of ${r.active_companies} active companies have ${r.config_key} = ${JSON.stringify(r.value)} (default ${JSON.stringify(r.default_value)})` }); }
  }

  // TEMPLATE PREVIEW -- when the question is about a template, show it as the dashboard does (its widget columns).
  // Subjects: rows the planner fetched from templates (few of them), else the template rows found by meaning.
  const templateViews = [];
  if (/\btemplates?\b/i.test(question)) {
    const fromPlan = live.filter(l => l.table === "templates" && !l.error && (l.rows_shown_to_user || l.rows?.length || 0) <= 3).flatMap(l => (l.rows || []).map(r => r.id));
    const fromHits = rawLive.filter(h => h.kind === "templates" && h.score >= 0.55).map(h => h.ref_id);
    const ids = [...new Set([...fromPlan, ...fromHits].map(Number).filter(Number.isInteger))].slice(0, 2);
    for (const id of ids) {
      const v = await templateView({ id }).catch(() => null);
      if (!v || v.error) continue;
      templateViews.push(v);
      emit({ type: "template", ...v });
    }
    if (templateViews.length) emit({ type: "status", text: `showing ${templateViews.length} template${templateViews.length > 1 ? "s" : ""} as the dashboard lays ${templateViews.length > 1 ? "them" : "it"} out` });
  }
  // three-way join: any config_key that came back from live data -> where the CODE reads it (repo-wide grep)
  const liveKeys = [...new Set([...configs.slice(0, 2).map(c => c.config_key), ...live.flatMap(l => (l.rows || []).map(r => r.config_key).filter(Boolean))])].slice(0, 3);
  const liveGreps = [];
  for (const k of canSource ? liveKeys : []) { const g = await grepSource({ repo: "procol-backend", pattern: k, refs, max_hits: 10, context: 4 }).catch(() => null); if (g && !g.error && g.total_hits) liveGreps.push(g); }
  if (liveGreps.length) emit({ type: "status", text: `where the code reads ${liveKeys.join(", ")}: ${liveGreps.reduce((a, g) => a + g.total_hits, 0)} places` });
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
  if (canSource && (plan?.want_source || identTokens.length)) {
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
  if (canSource && plan?.want_source) {
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

  // SCREENS -- a lookup that landed on a dashboard screen gets what is on it and where it leads; a journey question
  // gets the real navigation chain between the screens it is about, so steps are clicks, not guesses.
  const JOURNEY_RE = /\b(journey|walk me through|step[- ]by[- ]step|end[- ]to[- ]end|how (do|does|can) (i|a|an|the|we|buyer|supplier|user)|where (do|can) (i|we)|from .{3,60} (to|till|until) )/i;
  let screenJourneyFacts = null;
  const screenViews = [];
  for (const r of results) if (r.anchor?.kind === "UI_ROUTE" && r.anchor?.id) { const v = await screenView({ id: r.anchor.id, refs }).catch(() => null); if (v) screenViews.push(v); }
  if (JOURNEY_RE.test(question)) {
    try {
      const hits = (await semanticAnchor({ question, k: 6, refs, kinds: ["UI_ROUTE"] })).matches.filter(m => Number(m.score) >= 0.5);
      const named = await screensNamedIn({ question, refs });                 // screens the question names, in the order it names them
      let start = named[0]?.id || null, end = named.length > 1 ? named[named.length - 1].id : null;
      const span = /\bfrom\s+(.{3,60}?)\s+(?:to|till|until|up to)\s+(?:the\s+|a\s+|an\s+)?(.{2,60}?)(?=[,.:;]|\s+(?:through|via|by|and|which|where|how)\b|$)/i.exec(question);
      if (span) {
        const a = await screensNamedIn({ question: span[1], refs }), b = await screensNamedIn({ question: span[2], refs });
        if (a[0]) start = a[0].id; if (b[0]) end = b[0].id;
      }
      const ids = [...new Set([...named.map(n => n.id), ...screenViews.map(v => v.id), ...hits.map(h => Number(h.id))])];
      screenJourneyFacts = await screenJourney({ candidateIds: named.map(n => n.id).length >= 2 ? named.map(n => n.id) : ids, refs, from: start, to: end });
      for (const n of named.slice(0, 4)) if (!screenViews.some(v => v.id === n.id)) { const v = await screenView({ id: n.id, refs }).catch(() => null); if (v) screenViews.push(v); }
      if (screenJourneyFacts) emit({ type: "status", text: `screen journey: ${screenJourneyFacts.screens.map(s => s.screen).join(" → ")}` });
      for (const h of hits.slice(0, 3)) if (!screenViews.some(v => v.id === Number(h.id))) { const v = await screenView({ id: Number(h.id), refs }).catch(() => null); if (v) screenViews.push(v); }
    } catch (e) { emit({ type: "status", text: `screen journey unavailable: ${String(e.message).slice(0, 60)}` }); }
  }

  // CONFIDENCE -- from how the facts were found, never from the model's tone; the writer's wording follows it.
  const journeyQuestion = JOURNEY_RE.test(question);
  const confidence = assessConfidence({ lookups: results, screen_journey: screenJourneyFacts, screens: screenViews, documents, live, source,
                                        effective_configuration: effectiveConfigViews, companies_with: companiesWithViews, lists, planned_sql: sqlResults, sem,
                                        planAskedLive, journeyQuestion, unresolved: results.reduce((a, r) => a + (r.unresolved?.length || 0), 0), truncated: results.some(r => r.truncated) });
  const facts = { question, refs,
                  confidence: { level: confidence.level, reason: confidence.reason, ...(confidence.missing ? { missing: confidence.missing } : {}) },
                  ...(conversation ? { conversation } : {}),
                  ...(screenJourneyFacts ? { screen_journey: screenJourneyFacts } : {}),
                  ...(screenViews.length ? { screens: screenViews.slice(0, 5) } : {}),
                  lookups: results.map(r => { const o = { ...r }; if (o.anchor) { const { id, ...rest } = o.anchor; o.anchor = rest; } return o; }),
                  ...(lists.length ? { lists } : {}), ...(sqlResults.length ? { planned_sql: sqlResults } : {}),
                  ...(families.length ? { endpoint_families: families } : {}),
                  ...(source.length ? { source } : {}), ...(greps.length ? { greps } : {}),
                  ...(documents.length ? { documents } : {}),
                  ...(live.length ? { live } : {}), ...(liveGreps.length ? { live_config_greps: liveGreps } : {}),
                  ...(effectiveConfigViews.length ? { effective_configuration: effectiveConfigViews.map(r => ({ companies: r.companies, total_matches: r.total_matches, as_of: r.as_of, filters: r.filters, note: r.note, shown_to_user_as_table: true,
                        agree: r.agree.slice(0, 80).map(a => ({ config_key: a.config_key, name: a.name, effective: a.effective, source: a.sources })),
                        differ: r.differ.slice(0, 40).map(d => ({ config_key: d.config_key, name: d.name, per_company: d.per_company.map(x => ({ company_id: x.company_id, effective: x.effective, source: x.source })) })) })) } : {}),
                  ...(companiesWithViews.length ? { companies_with: companiesWithViews } : {}),
                  ...(templateViews.length ? { template_views: templateViews.map(v => ({
                        id: v.id, name: v.name, company: v.company, template_for: v.template_for, template_type: v.template_type, order_type: v.order_type, status: v.status,
                        layout: v.layout, shown_to_user_as_rendered_template: true, settings: v.configurations,
                        ...(v.layout === "form"
                          ? { pages: v.pages.map(p => ({ page: p.name, questions: p.questions.slice(0, 40).map(q => ({ q: q.name, type: q.type, side: q.side, required: q.required, ...(q.options ? { options: q.options } : {}) })) })) }
                          : { columns: v.groups.map(g => ({ group: g.label, widgets: g.widgets.slice(0, 60).map(w => ({ name: w.name, type: w.type, side: w.side, required: w.required, prefix: w.prefix, suffix: w.suffix, hidden: w.hidden || undefined })) })) }) })) } : {}),
                  ...(liveHits.length ? { live_candidates: liveHits.map(h => ({ table: h.kind, id: h.ref_id, company: h.company, text: h.text, match_score: h.score })),
                                          ...(liveTop.flat ? { live_candidates_note: "scores are flat: weak hints only; the lookups and live rows decide" } : {}) } : {}),
                  ...(configs.length ? { config_candidates: configs.map(c => ({ config_key: c.config_key, name: c.name, description: c.description, default: c.defaults, item_type: c.item_type,
                                                                              overrides: c.overrides, companies_with_it_on: c.companies_active, match_score: c.score })),
                                         ...(cfgTop.flat ? { config_candidates_note: "scores are flat: weak hints only; the lookups, live rows and where the code reads each key decide" } : {}) } : {}),
                  ...(summaries ? { overviews: summaries } : {}), ...(owners ? { owners } : {}) };

  // Phase C: answer (bounded payload, one retry)
  const retrieveMs = Date.now() - tRetrieve;
  emitContextPaths(JSON.stringify(facts), emit);
  emit({ type: "status", text: `confidence ${confidence.level}: ${confidence.reason}` });
  emit({ type: "status", text: `writing the ${intent === "simple" ? "plain-English" : "technical"} answer (${p.model})` });
  const tAnswer = Date.now();
  const drawFlow = wantsFlow(question) && (results.some(r => r.match !== "none") || documents.length > 0 || live.length > 0);
  if (drawFlow) emit({ type: "status", text: "drawing the workflow beside the answer" });
  await writeAnswer({ question, facts: policy ? redactFacts(facts, policy) : facts, emit, budget: FACTS_BUDGET, system: intent === "simple" ? ANSWER_SIMPLE_SYSTEM : ANSWER_SYSTEM, flow: drawFlow });
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
                    confidence: confidence.level, side_facts: { configs: configs.length, live_rows: liveHits.length, left_out: cfgTop.dropped + liveTop.dropped },
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

/**
 * TICKET TRIAGE. Facts first (customer, features, switches, guides, screens, owners), then the model writes the card
 * and picks a verdict only from what the facts allow. The person sees who can resolve it and why.
 */
async function triageRun({ question, refs, emit, t0, p, policy = null, conversation = null }) {
  const ticket = parseTicket(question);
  emit({ type: "status", text: `triaging a ticket${ticket.customer ? ` for ${ticket.customer}` : ""}${ticket.errors.length ? ` · quoted text: ${ticket.errors.map(e => `"${e.slice(0, 40)}"`).join(", ")}` : ""}` });
  const facts = await collectTriageFacts({ ticket, refs, emit });
  if (conversation) facts.conversation = conversation;
  emit({ type: "status", text: `allowed verdicts from the facts: ${facts.allowed_verdicts.join(", ")}` });
  for (const g of facts.guides) emit({ type: "evidence", id: `d${g.title}:${g.heading}`, repo: "docs", path: g.path, line: null, extractor: "docs" });
  const shown = policy ? redactFacts(facts, policy) : facts;
  emit({ type: "status", text: `writing the triage (${p.model})` });
  const system = TRIAGE_SYSTEM + `\n\nALLOWED VERDICTS: ${facts.allowed_verdicts.join(", ")}`;
  let text = "";
  const json = JSON.stringify(shrink(structuredClone(shown), FACTS_BUDGET));
  try { for await (const d of chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: `TICKET:\n${ticket.body.slice(0, 3000)}\n\nFACTS:\n${json}` }], max_tokens: 2600, temperature: 0 })) text += d; }
  catch (e) { emit({ type: "status", text: `triage writer failed (${String(e.message).slice(0, 80)}); retrying with fewer facts` }); }
  if (!text) { try { text = (await chat({ messages: [{ role: "system", content: system }, { role: "user", content: `TICKET:\n${ticket.body.slice(0, 3000)}\n\nFACTS:\n${JSON.stringify(shrink(structuredClone(shown), Math.floor(FACTS_BUDGET / 2)))}` }], max_tokens: 2600, temperature: 0 })).content || ""; } catch (e) { emit({ type: "error", code: "llm_failed", message: e.message }); } }
  const out = extractTriage(text, facts.allowed_verdicts);
  if (out.triage) {
    if (out.downgraded) emit({ type: "status", text: `verdict "${out.triage.verdict_requested}" was not supported by the facts; downgraded to more_info` });
    emit({ type: "triage", ...out.triage, allowed_verdicts: facts.allowed_verdicts, feature_confidence: facts.feature_confidence,
           customer: { named: ticket.customer, companies: facts.companies }, features_found: facts.features.map(f => ({ name: f.name, share: f.share, why: f.why })),
           switches: facts.switches.map(s => ({ config_key: s.config_key, name: s.name, effective: s.effective, source: s.source, for_customer: s.for_customer || null, read_in_feature: s.read_in_feature })),
           guides: facts.guides.map(g => ({ title: g.title, heading: g.heading, path: g.path })), screens: facts.screens, owners: facts.owners, process_owners: facts.process_owners,
           error_hits: facts.error_hits, quoted_text: ticket.errors, customer_live: facts.customer_live });
  } else emit({ type: "status", text: `no triage card: ${out.dropped || "unknown"}` });
  const known = pathsIn(json);
  const clean = sanitizePaths(out.text || text || "(The model produced no triage text.)", known);
  emit({ type: "token", text: clean.text });
  emitContextPaths(json, emit);
  await emitRefsFooter(refs, emit);
  const summary = { type: "done", ms: Date.now() - t0, model: chatStream.lastModel || p.model, mode: "triage", verdict: out.triage?.verdict || null };
  emit(summary);
  return summary;
}

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
