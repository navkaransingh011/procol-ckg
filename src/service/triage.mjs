// Ticket triage. A pasted complaint becomes a card: what the customer was doing, the likely feature with a confidence,
// the switches that govern it and their effective value for that customer, the guide that covers it, who to ask,
// and a verdict on WHO can resolve it. The verdict is chosen by the model but only from the set the facts allow:
// "knowledge" needs a guide or a screen, "config" needs a governing switch with a known value, "engineering" needs
// something concrete to hand over (an error string found in code, a defect, or a document/code conflict).
import { q } from "../db.mjs";
import { semanticAnchor, searchDocs, searchConfigs, searchLive, grepSource, ownersOf, screensNamedIn, screenView, queryLive } from "../tools.mjs";
import { resolveCompanies, companyMentions, effectiveConfigs } from "./configs.mjs";

export const VERDICTS = ["knowledge", "config", "engineering", "more_info"];
const CODE_KINDS = new Set(["SYMBOL", "HANDLER", "HTTP_CALL_SITE", "HTTP_ENDPOINT", "SERVER_ROUTE", "DB_TABLE", "SERVICE", "JOB"]);

/** A pasted ticket, or an explicit "triage:" / "ticket:" prefix. */
export function looksLikeTicket(text) {
  const t = String(text || "").trim();
  if (/^(triage|ticket)\s*[:#\-]/i.test(t)) return true;
  if (t.length < 160) return false;
  const complaint = /\b(customer|client|vendor|supplier|buyer|user|team)\b[\s\S]{0,120}\b(says|said|reported|reports|complain\w*|unable|cannot|can't|not able|isn't|is not|error|issue|facing|getting|stuck|failed|fails|not working|doesn't|does not)\b/i;
  return complaint.test(t) || /^(subject|ticket|customer|company|client)\s*:/im.test(t) || /\b(hi|hello|dear) (team|support)\b/i.test(t);
}

/** Fields out of free text: customer line, quoted error strings, the body. */
export function parseTicket(text) {
  let body = String(text || "").trim().replace(/^(triage|ticket)\s*[:#\-]\s*/i, "");
  const customer = (/^(?:customer|company|client|tenant|account)\s*:\s*(.+)$/im.exec(body) || [])[1]?.trim() || null;
  const subject = (/^subject\s*:\s*(.+)$/im.exec(body) || [])[1]?.trim() || null;
  const errors = [...new Set([...body.matchAll(/["“']([^"”']{4,140})["”']/g)].map(m => m[1].trim()).filter(s => /[a-z]/i.test(s)))].slice(0, 4);
  return { customer, subject, errors, body: body.slice(0, 6000) };
}

/** Which verdicts the facts can support. The model may choose only among these. */
export function allowedVerdicts(f) {
  const allowed = new Set(["more_info"]);
  if ((f.guides || []).length || (f.screens || []).length) allowed.add("knowledge");
  if ((f.switches || []).some(s => s.effective !== undefined && s.effective !== null && (s.read_in_feature === true || (s.source && s.source !== "default" && !String(s.source).startsWith("default"))))) allowed.add("config");
  if ((f.error_hits || []).length || (f.defects || 0) > 0 || ((f.guides || []).length && (f.code_anchors || []).length) || ((f.code_anchors || []).length && !(f.guides || []).length && !(f.screens || []).length)) allowed.add("engineering");
  return [...allowed];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function collectTriageFacts({ ticket, refs, emit }) {
  const text = [ticket.subject, ticket.body].filter(Boolean).join("\n");
  const dense = [ticket.subject, ticket.body.slice(0, 500)].filter(Boolean).join(". ");      // the gist, for matching by meaning
  // the customer: an explicit line first, else names in the text
  let companies = ticket.customer ? await resolveCompanies({ name: ticket.customer, limit: 6 }).catch(() => []) : [];
  if (!companies.length) companies = (await companyMentions(text).catch(() => [])).slice(0, 6);
  emit({ type: "status", text: companies.length ? `customer: ${companies.slice(0, 3).map(c => `${c.name} (#${c.id})`).join(", ")}${companies.length > 3 ? ` +${companies.length - 3}` : ""}` : "customer not named; configuration values will be defaults only" });

  const [sem, featSem, docs, cfgs, live, named, uiSem, ...greps] = await Promise.all([
    semanticAnchor({ question: dense, k: 14, refs }).then(r => r.matches.filter(m => Number(m.score) >= 0.45)).catch(() => []),
    semanticAnchor({ question: dense, k: 4, refs, kinds: ["FEATURE"] }).then(r => r.matches.filter(m => Number(m.score) >= 0.5)).catch(() => []),
    searchDocs({ question: text.slice(0, 1200), k: 6, refs, min_score: 0.45 }).then(r => Array.isArray(r) ? r : (r.passages || r.hits || r.results || [])).catch(() => []),
    searchConfigs({ question: text.slice(0, 1200), k: 6, min_score: 0.45 }).then(r => r.configs).catch(() => []),
    searchLive({ question: text.slice(0, 1200), k: 5, min_score: 0.55 }).then(r => r.hits).catch(() => []),
    screensNamedIn({ question: text, refs }).catch(() => []),
    semanticAnchor({ question: text.slice(0, 1200), k: 6, refs, kinds: ["UI_ROUTE", "UI_ACTION"] }).then(r => r.matches.filter(m => Number(m.score) >= 0.5)).catch(() => []),
    ...ticket.errors.flatMap(e => [
      grepSource({ repo: "procol-client-dashboard", pattern: escapeRe(e), refs, paths: ["src"], max_hits: 6, context: 1 }).catch(() => null),
      grepSource({ repo: "procol-backend", pattern: escapeRe(e), refs, paths: ["app", "config"], max_hits: 6, context: 1 }).catch(() => null),
    ]),
  ]);
  const error_hits = greps.filter(g => g && !g.error && g.total_hits).flatMap(g => (g.files || []).slice(0, 3).map(f => ({ repo: g.repo, pattern: g.pattern, path: f.path, line: f.hits?.[0]?.line ?? null, snippet: (f.hits?.[0]?.text || "").slice(0, 160) })));
  if (error_hits.length) emit({ type: "status", text: `quoted text found in code: ${error_hits.slice(0, 3).map(h => h.path).join(", ")}` });

  // features: every code hit votes for the feature that implements it; features found by meaning vote too
  const codeHits = sem.filter(m => CODE_KINDS.has(m.kind));
  const votes = new Map();
  const vote = (id, name, attrs, w, why) => { const v = votes.get(id) || { id, name, attrs, score: 0, why: [] }; v.score += w; if (v.why.length < 4) v.why.push(why); votes.set(id, v); };
  if (codeHits.length) {
    const rows = await q(`select f.id, f.name, f.attrs, g.dst_entity_id as code_id from ckg.edges g join ckg.entities f on f.id = g.src_entity_id
                           where g.kind = 'IMPLEMENTS' and f.kind = 'FEATURE' and g.dst_entity_id = any($1::bigint[])`, [codeHits.map(h => Number(h.id))]).catch(() => []);
    for (const r of rows) { const h = codeHits.find(x => Number(x.id) === Number(r.code_id)); vote(Number(r.id), r.name, r.attrs, Number(h?.score || 0.5), `code match: ${h?.name || h?.fqn}`); }
  }
  for (const m of [...sem.filter(x => x.kind === "FEATURE"), ...featSem]) vote(Number(m.id), m.name, null, Number(m.score) * 0.7, "matches the ticket by meaning");
  // the words the ticket uses against feature names: "award", "event", "approval" name the feature outright
  const STOPW = new Set(["template", "templates", "customer", "company", "buyer", "supplier", "vendor", "team", "error", "issue", "email", "portal", "screen", "button", "request", "requests", "order", "orders", "purchase", "flow", "flows", "detail", "details", "creation", "create", "engine", "report", "reports", "data", "source", "communication", "custom", "module", "product", "products", "user", "users"]);
  const words = [...new Set((dense.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOPW.has(w)))];
  const feats = await q(`select e.id, e.name, e.attrs from ckg.entities e join ckg.v_refs v on v.repo_id = e.repo_id and v.commit_sha = e.commit_sha where e.kind = 'FEATURE'`).catch(() => []);
  const stem = (w) => w.replace(/(ings?|ed|es|s|al|ation|ations)$/, "");
  for (const f of feats) {
    const nameWords = String(f.name).toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !STOPW.has(w));
    const hits = nameWords.filter(nw => words.some(w => stem(w) === stem(nw) || (stem(w).length >= 5 && (stem(nw).startsWith(stem(w)) || stem(w).startsWith(stem(nw))))));
    if (hits.length) vote(Number(f.id), f.name, f.attrs, 0.9 * Math.min(2, hits.length), `the ticket says "${hits[0]}"`);
  }
  // screens the ticket names, and the buttons it names, vote through the backend handlers those screens call
  const actionScreenIds = uiSem.filter(m => m.kind === "UI_ACTION").length
    ? (await q(`select distinct s.id from ckg.entities a join ckg.entities s on s.kind = 'UI_ROUTE' and s.repo_id = a.repo_id and s.commit_sha = a.commit_sha and s.attrs->>'route_path' = a.attrs->>'screen_path'
                  where a.id = any($1::bigint[])`, [uiSem.filter(m => m.kind === "UI_ACTION").map(m => Number(m.id))]).catch(() => [])).map(r => Number(r.id)) : [];
  const screenIdsEarly = [...new Set([...named.map(n => n.id), ...uiSem.filter(m => m.kind === "UI_ROUTE").map(m => Number(m.id)), ...actionScreenIds])].slice(0, 4);
  if (screenIdsEarly.length) {
    const rows = await q(`select distinct f.id, f.name, f.attrs, s.name as screen from ckg.edges ih join ckg.entities s on s.id = ih.src_entity_id
                            join ckg.edges t on t.kind = 'TARGETS' and t.src_entity_id = ih.dst_entity_id
                            join ckg.edges sv on sv.kind = 'SERVES' and sv.dst_entity_id = t.dst_entity_id
                            join ckg.edges im on im.kind = 'IMPLEMENTS' and im.dst_entity_id = sv.src_entity_id
                            join ckg.entities f on f.id = im.src_entity_id and f.kind = 'FEATURE'
                           where ih.kind = 'ISSUES_HTTP' and ih.src_entity_id = any($1::bigint[])`, [screenIdsEarly]).catch(() => []);
    for (const r of rows) vote(Number(r.id), r.name, r.attrs, 1.2, `the ${r.screen} screen calls its code`);
  }
  const allFeatures = await q(`select id, name, attrs from ckg.entities e where kind = 'FEATURE' and e.id = any($1::bigint[])`, [[...votes.keys()]]).catch(() => []);
  for (const f of allFeatures) { const v = votes.get(Number(f.id)); if (v) v.attrs = f.attrs; }
  for (const h of error_hits) for (const v of votes.values()) if ((v.attrs?.dirs || []).some(d => h.path.startsWith(d))) { v.score += 1; v.why.push(`error text lives in its code (${h.path})`); }
  const ranked = [...votes.values()].sort((a, b) => b.score - a.score);
  const total = ranked.reduce((n, v) => n + v.score, 0) || 1;
  const features = ranked.slice(0, 2).map(v => ({ id: v.id, name: v.name, share: Number((v.score / total).toFixed(2)), votes: v.why.length, why: v.why, dirs: (v.attrs?.dirs || []).slice(0, 4), summary: (v.attrs?.bullets || []).slice(0, 4) }));
  const top = features[0];
  const confidence = !top ? "none" : top.share >= 0.55 && top.votes >= 3 ? "high" : top.share >= 0.35 || top.votes >= 2 ? "medium" : "low";
  if (top) emit({ type: "status", text: `likely feature: ${top.name} (${confidence} confidence, ${Math.round(top.share * 100)}% of the evidence)` });

  // governing switches: configuration candidates, checked against whether the feature's code reads them, then the customer's effective value
  const keys = cfgs.slice(0, 5).map(c => c.config_key);
  const switches = [];
  for (const c of cfgs.slice(0, 5)) {
    let read_in_feature = null;
    if (top?.dirs?.length) { const g = await grepSource({ repo: "procol-backend", pattern: c.config_key, refs, paths: top.dirs, max_hits: 3, context: 0 }).catch(() => null); read_in_feature = !!(g && !g.error && g.total_hits); }
    const per = [];
    for (const co of companies.slice(0, 3)) { const rows = await effectiveConfigs({ company_id: co.id, keys: [c.config_key] }).catch(() => []); if (rows[0]) per.push({ company_id: co.id, company: co.name, effective: rows[0].effective, source: rows[0].source, overridden_at: rows[0].overridden_at }); }
    switches.push({ config_key: c.config_key, name: c.name, description: c.description, default_value: c.defaults?.value ?? c.defaults, match_score: c.score, read_in_feature,
                    ...(per.length ? { for_customer: per, effective: per[0].effective, source: per[0].source } : { effective: c.defaults?.value ?? null, source: companies.length ? "unknown" : "default (no customer named)" }) });
  }
  // guides and screens
  const guides = docs.slice(0, 5).map(d => ({ title: d.title, heading: d.heading_path, text: String(d.text || "").slice(0, 600), score: Number(d.score.toFixed(2)), path: d.path, source: d.source }));
  const docOwners = docs.length ? await q(`select distinct name, attrs->>'owner' as owner, attrs->>'url' as url from ckg.entities where kind = 'DOCUMENT' and id = any($1::bigint[]) and attrs->>'owner' is not null`, [docs.map(d => Number(d.doc_id))]).catch(() => []) : [];
  const screenIds = [...new Set([...named.map(n => n.id), ...uiSem.filter(m => m.kind === "UI_ROUTE").map(m => Number(m.id))])].slice(0, 3);
  const screens = [];
  for (const id of screenIds) { const v = await screenView({ id, refs }).catch(() => null); if (v) screens.push({ screen: v.screen, route_path: v.route_path, key_actions: v.actions.filter(a => a.role !== "title").map(a => a.name).slice(0, 12), leads_to: v.leads_to.map(l => l.screen).slice(0, 6) }); }
  // owners of the feature's code, by commit history; without a feature, the owners of the matched code's folders
  let owners = [];
  const ownerDirs = (top?.dirs || []).length ? top.dirs.slice(0, 2) : [...new Set(codeHits.map(h => (h.path || "").split("/").slice(0, 3).join("/")).filter(d => d.split("/").length >= 3))].slice(0, 2);
  for (const d of ownerDirs) owners.push(...await ownersOf({ path_prefix: d, refs, limit: 4 }).catch(() => []));
  // the customer's own rows in the live tables the ticket is about (their approval flows, their templates), with dates:
  // "we changed the flow last week" becomes checkable instead of a question back to the customer
  const customer_live = [];
  const liveKinds = [...new Set(live.map(h => h.kind))].filter(k => ["approval_flows", "templates", "fx_datasources"].includes(k));
  if (!liveKinds.length && /\bapprov/i.test(text)) liveKinds.push("approval_flows");
  if (!liveKinds.includes("templates") && /\btemplate/i.test(text)) liveKinds.push("templates");
  const ids = companies.slice(0, 6).map(c => c.id);
  for (const table of liveKinds.slice(0, 2)) if (ids.length) {
    const col = table === "fx_datasources" ? "tenant_id" : "company_id";
    const r = await queryLive({ table, where: { [col]: ids.map(String) }, limit: 40, order_by: "updated_at" }).catch(() => null);
    if (r && !r.error) customer_live.push({ table, total: r.total, as_of: r.as_of, environment: "UAT mirror", company_ids: ids,
                                            rows: (r.rows || []).slice(0, 25).map(row => { const o = {}; for (const k of ["id", "name", "approval_key", "description", "status", col, "template_for", "template_type", "updated_at"]) if (row[k] !== undefined) o[k] = row[k]; return o; }) });
  }
  if (customer_live.length) emit({ type: "status", text: `the customer's own rows on UAT: ${customer_live.map(c => `${c.total} ${c.table.replace("_", " ")}`).join(", ")}` });
  const byPerson = new Map();
  for (const o of owners) { const k = o.email || o.name; const cur = byPerson.get(k); if (!cur || Number(o.commits) > Number(cur.commits)) byPerson.set(k, o); }
  owners = [...byPerson.values()].sort((a, b) => Number(b.commits) - Number(a.commits)).slice(0, 3).map(o => ({ name: o.name, email: o.email, commits: Number(o.commits), last_commit: o.last_commit }));
  const defects = codeHits.length ? Number((await q(`select count(*) from ckg.entities where kind = 'OBSERVED_DEFECT' and path = any($1::text[])`, [codeHits.map(h => h.path).filter(Boolean)]).catch(() => [{ count: 0 }]))[0].count) : 0;

  const facts = { ticket: { customer: ticket.customer, subject: ticket.subject, quoted_text: ticket.errors, body: ticket.body.slice(0, 2500) },
                  companies: companies.slice(0, 6).map(c => ({ id: c.id, name: c.name })), features, feature_confidence: confidence, switches, guides,
                  process_owners: docOwners.map(o => ({ document: o.name, owner: o.owner, url: o.url })), screens, owners,
                  code_anchors: codeHits.slice(0, 8).map(h => ({ kind: h.kind, name: h.name || h.fqn, path: h.path, score: Number(h.score.toFixed(2)) })),
                  error_hits, defects, live_hits: live.slice(0, 5).map(h => ({ table: h.kind, id: h.ref_id, company: h.company, text: h.text })), customer_live };
  facts.allowed_verdicts = allowedVerdicts(facts);
  return facts;
}

export const TRIAGE_SYSTEM = `You triage a customer-support ticket for Procol's CS team from VERIFIED facts about the product: its code graph, its user
guides, its dashboard screens and the customer's live configuration. You know nothing else about the product.

Write for a CS person, in product language, in these sections with these exact headings:
### What the customer is trying to do
### Likely cause
### Verdict
### Suggested reply
### What to check first
### Who to ask

RULES
- Every statement rests on a fact you were given. If the facts do not cover something, say so; never invent a fix.
- "switches" carry the EFFECTIVE value for the named customer and where it comes from (default / company master / override). Quote them.
  When no customer is named, say the values are defaults and that the customer's own setting must be checked.
- "features" carry a share of the evidence; state the confidence word you were given, not your own.
- "customer_live" holds the customer's OWN rows (their approval flows, templates) with update dates, from the UAT mirror. Read them
  before asking the customer anything: name the flow or template involved and when it last changed. A total of 0 is a finding: say that
  no such rows exist for these company ids on UAT, so either another company account is involved or the change was made on production.
- All live values (switches, rows) come from UAT. When the ticket is about production behaviour, say the production value must be confirmed.
- The Verdict is exactly one of the ALLOWED VERDICTS, followed by one sentence of reason:
  knowledge = CS can resolve from the guide / the screens;  config = an admin must change a switch (name it; the agent cannot change it);
  engineering = needs a developer (document vs code conflict, an error path in code, a defect, or the behaviour does not exist);
  more_info = the facts cannot tell yet; then ask the 2-3 most useful questions.
- The Suggested reply is a short message CS can send, grounded in the guide or screen names. For "engineering" write the note for the developer instead.
- Then append exactly one fenced block starting with \`\`\`triage and ending with \`\`\`, JSON only:
  {"verdict":"knowledge|config|engineering|more_info","confidence":"high|medium|low","doing":"<one sentence>","cause":"<one sentence>",
   "features":[{"name":"...","why":"..."}],"switches_to_check":["config_key",...],"checks":["...","..."],"reply_draft":"...",
   "handoff":{"summary":"...","repro":["..."],"facts":["..."]} | null,"questions":["..."] | null}`;

/** Parse and enforce the model's block: verdict must be allowed, else it becomes more_info with a note. */
export function extractTriage(text, allowed) {
  const m = /```triage\s*([\s\S]*?)```/i.exec(text || "");
  const prose = m ? (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() : String(text || "").trim();
  if (!m) return { text: prose, triage: null, dropped: "no block" };
  let t; try { t = JSON.parse(m[1]); } catch { return { text: prose, triage: null, dropped: "invalid json" }; }
  const verdict = VERDICTS.includes(t.verdict) ? t.verdict : "more_info";
  const downgraded = !allowed.includes(verdict);
  const clean = { verdict: downgraded ? "more_info" : verdict, verdict_requested: downgraded ? verdict : undefined,
                  confidence: ["high", "medium", "low"].includes(t.confidence) ? t.confidence : "low",
                  doing: String(t.doing || "").slice(0, 300), cause: String(t.cause || "").slice(0, 400),
                  features: (Array.isArray(t.features) ? t.features : []).slice(0, 2).map(f => ({ name: String(f?.name || "").slice(0, 80), why: String(f?.why || "").slice(0, 200) })),
                  switches_to_check: (Array.isArray(t.switches_to_check) ? t.switches_to_check : []).map(String).slice(0, 6),
                  checks: (Array.isArray(t.checks) ? t.checks : []).map(x => String(x).slice(0, 200)).slice(0, 5),
                  reply_draft: String(t.reply_draft || "").slice(0, 1500),
                  handoff: t.handoff && typeof t.handoff === "object" ? { summary: String(t.handoff.summary || "").slice(0, 400), repro: (Array.isArray(t.handoff.repro) ? t.handoff.repro : []).map(String).slice(0, 6), facts: (Array.isArray(t.handoff.facts) ? t.handoff.facts : []).map(String).slice(0, 8) } : null,
                  questions: Array.isArray(t.questions) ? t.questions.map(String).slice(0, 4) : null };
  if (clean.verdict === "more_info" && !(clean.questions || []).length) clean.questions = ["Which screen was the customer on, and what exactly did they click?", "The exact error text or a screenshot", "Which company account, if several exist for this customer"];
  return { text: prose, triage: clean, downgraded };
}

/** Mask emails and phone numbers before a ticket is stored. */
export const maskPII = (s) => String(s || "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/(?<!\d)(?:\+?\d[\d\s\-()]{8,}\d)(?!\d)/g, "[phone]");
