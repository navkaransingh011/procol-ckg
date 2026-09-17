#!/usr/bin/env node
// Answer-quality harness. Runs each question in eval/answers.json through the REAL pipeline (planner, retrieval,
// confidence, writer) as the given role, with the role's event filter applied exactly as the server applies it, and
// grades what the person would have seen. Hard checks are exact (names that must / must not appear, banned phrases,
// expected confidence, a numbered list, a table / template / diagram / triage card, file paths for engineers and none
// for CS). --judge adds a model grader for the things exact checks cannot see: does it answer first, does it hedge,
// does it repeat itself, does it pad with unrelated facts.
//
//   npm run eval:answers                       full set, fresh answers (the cache is bypassed), report under eval/out/answers/<label>/
//   npm run eval:answers -- --only a01,a08     a few
//   npm run eval:answers -- --judge            add the model grader (one extra call per question)
//   npm run eval:answers -- --label baseline   name the run
//   npm run eval:answers -- --compare eval/out/answers/baseline/results.json   print per-question deltas against an earlier run
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); if (i < 0) return null; const v = argv[i + 1]; return v && !v.startsWith("--") ? v : true; };
const only = flag("only") ? new Set(String(flag("only")).split(",")) : null;
const judge = !!flag("judge");
const compareTo = flag("compare");
const label = typeof flag("label") === "string" ? flag("label") : new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

const { ask } = await import("./service/agent.mjs");
const { policyFor, styleFor, filterEvent } = await import("./service/policy.mjs");
const { chat, provider } = await import("./service/llm.mjs");
const { pool } = await import("./db.mjs");

const spec = JSON.parse(readFileSync(new URL("../eval/answers.json", import.meta.url)));
const questions = spec.questions.filter(t => !only || only.has(t.id));
const OUT = new URL(`../eval/out/answers/${label}/`, import.meta.url); mkdirSync(OUT, { recursive: true });
const refs = (process.env.EVAL_REFS || "main").split(",");
const PATH_RE = /\b[\w./-]+\.(rb|jsx?|mjs|ts|tsx|erb|yml|json)\b/;
const hit = (text, alt) => String(alt).split("|").some(a => text.toLowerCase().includes(a.toLowerCase()));
const mark = (ok) => (ok ? "✓" : "✗");

const JUDGE_SYSTEM = `You grade one answer from an internal assistant that explains how Procol's software works. Rate 1-5 on each:
- answers_question: 5 = the first sentences directly answer what was asked; 1 = talks around it or answers something else.
- plainness: 5 = states things as fact with no boilerplate doubt; 1 = opens with disclaimers ("the closest thing I found", "may not be exactly").
- no_repetition: 5 = each point once; 1 = the same sequence appears twice (prose then an arrow list).
- relevance: 5 = nothing off-topic; 1 = padded with counts, endpoints or settings the question did not ask for.
Output JSON only: {"answers_question":n,"plainness":n,"no_repetition":n,"relevance":n,"note":"<one sentence>"}`;

async function grade(question, text) {
  if (provider().mock || !text) return null;
  try {
    const r = await chat({ messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: `QUESTION: ${question}\n\nANSWER:\n${text.slice(0, 6000)}` }], max_tokens: 200, temperature: 0, reasoning_effort: "minimal" });
    const m = /\{[\s\S]*\}/.exec(r?.content || ""); if (!m) return null;
    const j = JSON.parse(m[0]);
    for (const k of ["answers_question", "plainness", "no_repetition", "relevance"]) j[k] = Math.max(1, Math.min(5, Number(j[k]) || 0));
    return j;
  } catch { return null; }
}

const rows = [];
for (const t of questions) {
  const p = policyFor(t.role || "cs");
  const ev = { text: "", events: [], statuses: [], done: null, error: null };
  const t0 = Date.now();
  process.stdout.write(`${t.id} [${t.role || "cs"}] ${t.q.slice(0, 70)}… `);
  try {
    await ask({ question: t.q, refs, style: styleFor(p), fresh: true, policy: p, history: t.history || null, emit: (raw) => {
      const e = filterEvent(raw, p); if (!e) return;
      if (e.type === "token") ev.text += e.text;
      else if (e.type === "status") ev.statuses.push(e.text);
      else if (e.type === "done") ev.done = e;
      else if (e.type === "error") ev.error = e.message;
      else ev.events.push(e);
    } });
  } catch (e) { ev.error = e.message; }
  const ms = Date.now() - t0;
  const text = ev.text.replace(/\s*\[s\d+\]/g, "");
  const words = text.split(/\s+/).filter(Boolean).length;

  const checks = [];
  checks.push(["answered", text.trim().length > 0 && !ev.error]);
  for (const m of t.must || []) checks.push([`must:${m}`, hit(text, m)]);
  for (const m of t.must_not || []) checks.push([`not:${m}`, !hit(text, m)]);
  // hedging phrases are banned for everyone; retrieval-mechanics words only in the plain-English answer (an engineer's
  // technical answer legitimately says "the list was truncated")
  const bannedList = [...(spec.banned || []), ...(p.style === "simple" ? (spec.banned_simple || []) : [])];
  const banned = bannedList.filter(b => text.toLowerCase().includes(b.toLowerCase()));
  checks.push([`no-banned-phrases${banned.length ? ` (${banned.join(", ")})` : ""}`, banned.length === 0]);
  if (t.confidence) checks.push([`confidence=${t.confidence} (got ${ev.done?.confidence ?? "none"})`, String(t.confidence).split("|").includes(ev.done?.confidence)]);   // "low|medium" accepts either
  if (t.list) checks.push(["numbered-list", /^\s*\d+[.)]\s+\S/m.test(text)]);
  for (const k of ["table", "template", "flow", "triage"]) if (t[`${k}_expected`]) checks.push([`${k}-shown`, ev.events.some(e => e.type === k)]);
  if (t.paths_expected) checks.push(["names-a-file", PATH_RE.test(text)]);
  if (!p.paths) checks.push(["no-paths-for-role", !PATH_RE.test(text)]);
  // the plain answer must not state the same sequence twice (prose, then an arrow list); the technical answer's
  // evidence path is drawn with arrows by design, so the check applies to the plain style only
  const arrows = (text.match(/→|->/g) || []).length;
  if (p.style === "simple") checks.push(["no-arrow-restatement", !(arrows >= 3 && /^\s*\d+[.)]\s/m.test(text))]);

  const j = judge ? await grade(t.q, text) : null;
  const pass = checks.every(([, ok]) => ok);
  console.log(`${pass ? "PASS" : "FAIL"} ${ev.done?.confidence || "-"} ${Math.round(ms / 1000)}s ${words}w${j ? ` judge ${j.answers_question}/${j.plainness}/${j.no_repetition}/${j.relevance}` : ""}`);
  for (const [n, ok] of checks) if (!ok) console.log(`      ✗ ${n}`);

  writeFileSync(new URL(`${t.id}.md`, OUT),
    `# ${t.id} [${t.role || "cs"} · ${t.kind || ""}] ${t.q}\n\n` +
    `confidence=${ev.done?.confidence ?? "-"} · ${ms} ms · ${words} words · ${ev.done?.provider || ""}${ev.error ? ` · ERROR ${ev.error}` : ""}\n\n` +
    `## Checks\n${checks.map(([n, ok]) => `- ${mark(ok)} ${n}`).join("\n")}\n\n` +
    (j ? `## Judge\nanswers_question ${j.answers_question} · plainness ${j.plainness} · no_repetition ${j.no_repetition} · relevance ${j.relevance}\n${j.note || ""}\n\n` : "") +
    `## Answer\n${text}\n\n## Trace\n${ev.statuses.map(s => `- ${s}`).join("\n")}\n`);
  rows.push({ id: t.id, role: t.role || "cs", kind: t.kind || "", q: t.q, pass, confidence: ev.done?.confidence ?? null, ms, words, banned,
              checks: checks.map(([n, ok]) => ({ n, ok })), judge: j, error: ev.error });
}

// ---- summary ----
const n = rows.length, passed = rows.filter(r => r.pass).length;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };   // one 20-minute stall must not hide 5 s answers
const conf = ["high", "medium", "low", null].map(l => `${l ?? "none"} ${rows.filter(r => r.confidence === l).length}`).join(" · ");
const judged = rows.filter(r => r.judge);
const jAvg = (k) => (judged.length ? avg(judged.map(r => r.judge[k])).toFixed(2) : "-");
const failing = rows.flatMap(r => r.checks.filter(c => !c.ok).map(c => c.n.replace(/ \(.*\)$/, "").replace(/:.*/, "")));
const byCheck = [...failing.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
const summary = { label, run_at: new Date().toISOString(), provider: `${provider().base} · ${provider().model}`, writer_model: process.env.LLM_WRITER_MODEL || null,
                  rerank: process.env.CKG_RERANK === "0" ? "off" : (process.env.CKG_RERANK_MODEL || "default"), questions: n, passed, pass_rate: n ? Number((passed / n).toFixed(3)) : 0,
                  banned_hits: rows.reduce((a, r) => a + r.banned.length, 0), avg_ms: Math.round(avg(rows.map(r => r.ms))), median_ms: median(rows.map(r => r.ms)), avg_words: Math.round(avg(rows.map(r => r.words))),
                  judge: judged.length ? { n: judged.length, answers_question: jAvg("answers_question"), plainness: jAvg("plainness"), no_repetition: jAvg("no_repetition"), relevance: jAvg("relevance") } : null };
const report = `# Answer eval — ${label}\n\n${summary.provider}${summary.writer_model ? ` · writer ${summary.writer_model}` : ""} · rerank ${summary.rerank}\n\n` +
  `**${passed}/${n} pass** · banned phrases ${summary.banned_hits} · confidence ${conf} · median ${summary.median_ms} ms (avg ${summary.avg_ms}) · avg ${summary.avg_words} words` +
  (summary.judge ? ` · judge (of 5): answers ${summary.judge.answers_question}, plain ${summary.judge.plainness}, no-repeat ${summary.judge.no_repetition}, relevant ${summary.judge.relevance}` : "") + `\n\n` +
  (byCheck.length ? `## Failing checks\n${byCheck.map(([k, c]) => `- ${k}: ${c}`).join("\n")}\n\n` : "") +
  `## Questions\n| id | role | kind | pass | conf | s | words | failed checks |\n|---|---|---|---|---|---|---|---|\n` +
  rows.map(r => `| ${r.id} | ${r.role} | ${r.kind} | ${mark(r.pass)} | ${r.confidence ?? "-"} | ${Math.round(r.ms / 1000)} | ${r.words} | ${r.checks.filter(c => !c.ok).map(c => c.n).join("; ")} |`).join("\n") + "\n";
writeFileSync(new URL("REPORT.md", OUT), report);
writeFileSync(new URL("results.json", OUT), JSON.stringify({ summary, rows }, null, 1));
console.log(`\n${passed}/${n} pass · banned ${summary.banned_hits} · confidence ${conf} · median ${summary.median_ms} ms (avg ${summary.avg_ms}) · avg ${summary.avg_words} words` + (summary.judge ? ` · judge ${summary.judge.answers_question}/${summary.judge.plainness}/${summary.judge.no_repetition}/${summary.judge.relevance}` : ""));
console.log(`report: eval/out/answers/${label}/REPORT.md`);

// ---- compare with an earlier run ----
if (typeof compareTo === "string" && existsSync(compareTo)) {
  const prev = JSON.parse(readFileSync(compareTo, "utf8"));
  const byId = new Map(prev.rows.map(r => [r.id, r]));
  console.log(`\ncompared with ${prev.summary.label}: pass ${prev.summary.passed}/${prev.summary.questions} → ${passed}/${n}; banned ${prev.summary.banned_hits} → ${summary.banned_hits}; avg ${prev.summary.avg_ms} → ${summary.avg_ms} ms` +
    (prev.summary.judge && summary.judge ? `; judge ${prev.summary.judge.answers_question}/${prev.summary.judge.plainness}/${prev.summary.judge.no_repetition}/${prev.summary.judge.relevance} → ${summary.judge.answers_question}/${summary.judge.plainness}/${summary.judge.no_repetition}/${summary.judge.relevance}` : ""));
  for (const r of rows) {
    const o = byId.get(r.id); if (!o) continue;
    if (o.pass !== r.pass || o.confidence !== r.confidence) console.log(`  ${r.id}: ${o.pass ? "PASS" : "FAIL"}/${o.confidence ?? "-"} → ${r.pass ? "PASS" : "FAIL"}/${r.confidence ?? "-"}`);
  }
}
await pool.end();
