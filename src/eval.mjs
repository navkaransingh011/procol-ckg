#!/usr/bin/env node
// Phase 4 harness. Runs each question through the SAME guided agent the dashboard uses
// and checks the graph-derived facts against expectations an author would recognise.
// Without a model configured it exercises the full retrieval path and reports prose as
// "n/a" -- which is the point: facts first, narration second.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

// Provider config is read at module load, and static imports are hoisted above this
// line -- so set the env FIRST and import dynamically, or the run silently uses the mock.
if (!process.env.LLM_BASE_URL) process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1"; // dead endpoint: full guided retrieval, no prose
process.env.LLM_MODE = process.env.LLM_MODE || "guided";
const { ask } = await import("./service/agent.mjs");
const { q, pool } = await import("./db.mjs");

const only = process.env.EVAL_QIDS ? new Set(process.env.EVAL_QIDS.split(",")) : null;   // EVAL_QIDS=q5,q7 to re-run a few
const questions = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url))).filter(t => !only || only.has(t.id));
const OUT = new URL("../eval/out/last_run/", import.meta.url); mkdirSync(OUT, { recursive: true });
const refs = (process.env.EVAL_REFS || "main").split(",");
const rows = [];

for (const t of questions) {
  const ev = { claims: [], unresolved: [], evidence: {}, text: "", errors: [], contextPaths: [] };
  await ask({ question: t.q, refs, emit: (e) => {
    if (e.type === "claim") ev.claims.push(e);
    else if (e.type === "unresolved") ev.unresolved.push(e);
    else if (e.type === "evidence") ev.evidence[e.id] = e;
    else if (e.type === "token") ev.text += e.text;
    else if (e.type === "error") ev.errors.push(e.code);
    else if (e.type === "context_paths") ev.contextPaths.push(...e.paths);
  }});

  const ids = ev.claims.flatMap(c => c.evidence_ids);
  const fqns = ids.length ? (await q(`select fqn, kind::text, path, attrs from ckg.entities where id = any($1::bigint[])`, [ids])) : [];
  const fqnSet = new Set(fqns.map(r => r.fqn));
  const kindSet = new Set(fqns.map(r => r.kind));
  const x = t.expect, checks = [];

  if (x.fqn_any) checks.push(["anchor", x.fqn_any.some(f => fqnSet.has(f))]);
  if (x.kind_any) checks.push(["kind", x.kind_any.some(k => kindSet.has(k))]);
  if (x.min_hops) checks.push([`hops>=${x.min_hops}`, ev.claims.length >= x.min_hops]);
  if (x.unresolved_expected) checks.push(["says-unresolved", ev.unresolved.length > 0]);
  if (x.defect_expected) {
    const [d] = await q(`select count(*)::int n from ckg.edges g join ckg.entities e on e.id=g.dst_entity_id
                          where g.kind='TRIGGERS_DEFECT' and g.src_entity_id = any($1::bigint[])
                             or (e.kind='OBSERVED_DEFECT' and e.id = any($1::bigint[]))`, [ids.length ? ids : [0]]);
    checks.push(["surfaces-defect", d.n > 0]);
  }
  if (x.runtime_calls_min) {
    const [c] = await q(`select count(*)::int n from ckg.edges where kind='CALLS' and resolution='RUNTIME' and src_entity_id = any($1::bigint[])`, [ids.length ? ids : [0]]);
    checks.push([`runtime-calls>=${x.runtime_calls_min}`, c.n >= x.runtime_calls_min]);
  }
  if (x.reverse_callers_min) {
    const [c] = await q(`select count(*)::int n from ckg.edges where kind='CALLS' and dst_entity_id = any($1::bigint[])`, [ids.length ? ids : [0]]);
    checks.push([`callers>=${x.reverse_callers_min}`, c.n >= x.reverse_callers_min]);
  }
  if (x.columns_min) {
    const t2 = fqns.find(r => r.kind === "DB_TABLE");
    checks.push([`columns>=${x.columns_min}`, (t2?.attrs?.columns?.length || 0) >= x.columns_min]);
  }
  // ---- prose scoring: only meaningful once a model is configured. This is the half
  // of Phase 4 that decides WHICH model -- retrieval is already model-independent.
  const prose = ev.text && !ev.text.startsWith("(No prose") ? ev.text : null;
  const proseChecks = [];
  if (prose) {
    const cited = fqns.map(r => (r.path || "").split("/").pop()).filter(Boolean);
    // 1. grounding: does it name at least one real file it was given?
    if (cited.length) proseChecks.push(["cites-a-real-file", cited.some(f => prose.includes(f))]);
    // 2. HONESTY -- the one that actually separates models. If the trace stopped, say so.
    if (ev.unresolved.length) {
      const words = /unresolv|runtime|cannot|can't|could not|not determin|stops|unknown/i.test(prose);
      proseChecks.push(["admits-the-gap", words]);
    }
    // 3. no invented file paths: every *.rb / *.js token in the prose must be one we supplied
    const claimed = prose.match(/[\w./-]+\.(rb|js|jsx)\b/g) || [];
    // everything the model was given: full paths, basenames, and the anchor's own file
    const supplied = new Set([...fqns.map(r => r.path), ...Object.values(ev.evidence).map(e => e.path), ...ev.contextPaths]
      .filter(Boolean).flatMap(pth => [pth, pth.split("/").pop()]));
    proseChecks.push(["no-invented-paths", claimed.every(c => [...supplied].some(sp => sp.endsWith(c) || c.endsWith(sp)))]);
    // 4. names the refs it read
    proseChecks.push(["names-the-ref", refs.some(r => prose.includes(r))]);
  }

  writeFileSync(new URL(`${t.id}.md`, OUT), `# ${t.id}: ${t.q}\n\nmode=${process.env.LLM_MODE} claims=${ev.claims.length} unresolved=${ev.unresolved.length}\n\n${ev.text}\n\n---\nprose checks: ${proseChecks.map(([n, ok]) => `${ok ? "✓" : "✗"} ${n}`).join("  ")}\n`);
  const pass = checks.every(([, ok]) => ok);
  const prosePass = proseChecks.length ? proseChecks.every(([, ok]) => ok) : null;
  rows.push({ id: t.id, pass, prosePass,
              checks: checks.map(([n, ok]) => `${ok ? "✓" : "✗"} ${n}`).join("  "),
              proseChecks: proseChecks.map(([n, ok]) => `${ok ? "✓" : "✗"} ${n}`).join("  "),
              hops: ev.claims.length, unresolved: ev.unresolved.length });
}

const passed = rows.filter(r => r.pass).length;
const scored = rows.filter(r => r.prosePass !== null);
const prosePassed = scored.filter(r => r.prosePass).length;

console.log(`\nPhase 4 eval — refs: ${refs.join(",")} — model: ${process.env.LLM_MODEL || "(none)"} @ ${process.env.LLM_BASE_URL} (${process.env.LLM_MODE})\n`);
console.log("RETRIEVAL — does it find the facts an author would expect? (model-independent)");
for (const r of rows) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id}  hops=${String(r.hops).padStart(3)}  unresolved=${r.unresolved}   ${r.checks}`);
console.log(`  ${passed}/${rows.length} passed.`);

if (scored.length) {
  console.log("\nPROSE — does the model say them honestly? (this is what picks the model)");
  for (const r of scored) console.log(`  ${r.prosePass ? "PASS" : "FAIL"}  ${r.id}   ${r.proseChecks}`);
  console.log(`  ${prosePassed}/${scored.length} passed.`);
} else {
  console.log("\nPROSE — not scored: no model configured. Set LLM_BASE_URL/LLM_MODEL/LLM_API_KEY to compare models.");
}
await pool.end();
try { await (await import("./service/embed.mjs")).disposeEmbedder(); } catch {}
process.exit(passed === rows.length && (!scored.length || prosePassed === scored.length) ? 0 : 1);
