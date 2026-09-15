// Workflow diagrams. The answer model appends one fenced ```flow block: steps in product language with an
// actor and a kind, and the edges between them. The service validates it against the facts the model was
// given (a step's `ref` must name something in the facts, or it is dropped as a reference) and emits a
// `flow` event the UI draws beside the prose. Sentences that describe a step end with its marker, e.g. [s3],
// so the drawing can light up as the reader moves through the text.

export const FLOW_RULES = `
WORKFLOW DIAGRAM (required for this answer)
After the prose, append exactly one fenced block starting with \`\`\`flow and ending with \`\`\`, containing JSON:
{"steps":[{"id":"s1","label":"Buyer submits the PR","actor":"buyer","kind":"start","ref":"PurchaseRequest"}, ...],
 "edges":[{"from":"s1","to":"s2"},{"from":"s2","to":"s3","label":"approved"},{"from":"s2","to":"s5","label":"rejected"}]}
- 3 to 12 steps, in the order things happen. label: 2-8 words, product language, no file paths.
- actor: one of buyer, supplier, approver, system, admin. kind: one of start, action, decision, system, end.
- A decision step has two or more outgoing edges with labels (the outcomes).
- ref (optional): the exact name of the code symbol, document, configuration key or approval flow in FACTS that this step comes from. Never invent one.
- source (optional): code, document, config or live, saying which kind of fact the step rests on.
- In the prose, end each sentence that describes a step with its marker in square brackets, like [s2]. Markers only for steps that exist.
- If the facts do not support at least 3 steps, write the prose only and add no block.`;

const ACTORS = new Set(["buyer", "supplier", "approver", "system", "admin"]);
const KINDS = new Set(["start", "action", "decision", "system", "end"]);
const SOURCES = new Set(["code", "document", "config", "live"]);

/** Questions about how something works or what happens over time get a diagram; lookups and lists do not. */
export function wantsFlow(question) {
  const q = String(question || "").trim();
  // a journey or process question always gets one, whatever other words it contains
  if (/\b(journey|walk me through|step[- ]by[- ]step|end[- ]to[- ]end|lifecycle|workflow|from .{3,60} (to|till|until) )/i.test(q)) return true;
  // lookups and lists do not: what they ask for is a set, not a sequence
  if (/^(list|which|show me|what are the|how many|names? of|count|give me (all|the list))\b/i.test(q) || /\btemplates?\b/i.test(q)) return false;
  return /\b(how (does|do|is|are|did)|what happens|flow|process|steps?|sequence|when (a|an|the) .+ (is|gets|becomes))\b/i.test(q);
}

/** Split the model's text into prose and a validated flow. `factsJson` is the exact text the model saw. */
export function extractFlow(text, factsJson = "") {
  const m = /```flow\s*([\s\S]*?)```/i.exec(text || "");
  if (!m) return { text: stripMarkers(text, new Set()), flow: null };
  const prose = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let raw;
  try { raw = JSON.parse(m[1]); } catch { return { text: stripMarkers(prose, new Set()), flow: null, dropped: "invalid json" }; }
  const hay = String(factsJson).toLowerCase();
  const seen = new Set();
  const steps = [];
  for (const s of Array.isArray(raw?.steps) ? raw.steps : []) {
    const id = String(s?.id || "").trim();
    const label = String(s?.label || "").replace(/\s+/g, " ").trim().slice(0, 90);
    if (!/^s\d{1,2}$/.test(id) || seen.has(id) || !label) continue;
    if (/(?:[\w.-]+\/)+[\w.-]+\.\w{1,4}/.test(label)) continue;             // a path in a label: not product language, drop the step
    seen.add(id);
    const ref = s?.ref ? String(s.ref).trim().slice(0, 120) : null;
    const refOk = !!ref && hay.includes(ref.toLowerCase());
    steps.push({ id, label,
                 actor: ACTORS.has(s?.actor) ? s.actor : "system",
                 kind: KINDS.has(s?.kind) ? s.kind : "action",
                 ref: refOk ? ref : null, unverified_ref: ref && !refOk ? true : undefined,
                 source: SOURCES.has(s?.source) ? s.source : null });
  }
  if (steps.length < 3) return { text: stripMarkers(prose, new Set()), flow: null, dropped: `only ${steps.length} valid steps` };
  const ids = new Set(steps.map((s) => s.id));
  const edgeKey = new Set();
  const edges = [];
  for (const e of Array.isArray(raw?.edges) ? raw.edges : []) {
    const from = String(e?.from || ""), to = String(e?.to || "");
    if (!ids.has(from) || !ids.has(to) || from === to || edgeKey.has(`${from}>${to}`)) continue;
    edgeKey.add(`${from}>${to}`);
    edges.push({ from, to, label: e?.label ? String(e.label).trim().slice(0, 40) : null });
  }
  // a chain if the model gave no usable edges: better a straight line than a heap of boxes
  if (!edges.length) for (let i = 1; i < steps.length; i++) edges.push({ from: steps[i - 1].id, to: steps[i].id, label: null });
  const partial = steps.some((s) => s.unverified_ref) || (Array.isArray(raw?.steps) && raw.steps.length !== steps.length);
  return { text: stripMarkers(prose, ids), flow: { steps, edges, partial } };
}

/** Keep markers for steps that exist (the UI turns them into dots); remove the rest. */
function stripMarkers(text, ids) {
  return String(text || "").replace(/\s*\[(s\d{1,2})\]/g, (m, id) => (ids.has(id) ? ` [${id}]` : ""));
}
