#!/usr/bin/env node
// The real alternative to vectors: deep mode's planner (FAST_SMALLER) guesses identifiers from plain words,
// then find_entity resolves them. Measures, on the same plain questions: planner-only, semantic-only,
// and the union (planner lookups + semantic top-10) -- is the right node in the candidate set at all?
import fs from "node:fs";
import { PLAN_SYSTEM } from "./service/agent.mjs";
import { chat } from "./service/llm.mjs";
import { findEntity, semanticAnchor, listEntities } from "./tools.mjs";
import { pool } from "./db.mjs";

const QS = JSON.parse(fs.readFileSync(new URL("../eval/questions_anchor.json", import.meta.url)));
const REFS = ["main"];
const hit = (row, spec) => row && (spec.match_kind?.includes(row.kind) ||
  (spec.match || []).some(re => [row.fqn, row.name].filter(Boolean).some(h => new RegExp(re, "i").test(h))));
const short = (r) => r ? `${r.kind}:${(r.name || r.fqn).slice(0, 40)}` : "-";
const parseJson = (t) => { const a = t.indexOf("{"), b = t.lastIndexOf("}"); try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } };

async function main() {
  const rows = [];
  for (const spec of QS) {
    const question = spec.plain;
    const t0 = Date.now();
    const m = await chat({ messages: [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: question }], max_tokens: 500, temperature: 0 });
    const plan = parseJson(m.content || "") || {};
    const planMs = Date.now() - t0;
    const lookups = (plan.lookups || []).map(l => l.q).filter(Boolean).slice(0, 8);
    const found = [];
    for (const lq of lookups) { const f = await findEntity({ query: lq, limit: 3, refs: REFS }); found.push(...f.matches.map(x => ({ ...x, via: lq }))); }
    for (const ls of (plan.lists || []).slice(0, 3)) {
      try { const r = await listEntities({ kind: ls.kind, path_prefix: ls.path_prefix || null, name_contains: ls.name_contains || null, refs: REFS, limit: 20 }); found.push(...r.items.map(x => ({ ...x, via: `list:${ls.kind}` }))); } catch {}
    }
    const planHit = found.find(x => hit(x, spec));
    const sem = await semanticAnchor({ question, k: 10, refs: REFS });
    const semHit = sem.matches.find(x => hit(x, spec));
    rows.push({ id: spec.id, question, lookups, planHit: planHit ? `${short(planHit)} via "${planHit.via}"` : null, semHit: semHit ? short(semHit) : null,
                union: !!(planHit || semHit), planMs, candidates: found.length + sem.matches.length });
    console.error(`${spec.id} planner:${planHit ? "hit" : "miss"} semantic:${semHit ? "hit" : "miss"} (${planMs}ms) lookups=${JSON.stringify(lookups)}`);
  }
  const n = rows.length;
  const md = [`# Plain questions: planner vs semantic vs union — ${new Date().toISOString()}`, "",
    `Planner model: ${process.env.LLM_MODEL}. Embedding: ${(await semanticAnchor({ question: "x", k: 1, refs: REFS })).model}.`, "",
    `**planner-only in candidates: ${rows.filter(r => r.planHit).length}/${n} · semantic-only top-10: ${rows.filter(r => r.semHit).length}/${n} · union: ${rows.filter(r => r.union).length}/${n}**`, "",
    "| Q | planner lookups it guessed | planner found | semantic found | either | plan ms |", "|---|---|---|---|---|---|",
    ...rows.map(r => `| ${r.id} | ${r.lookups.map(l => `\`${l}\``).join(", ")} | ${r.planHit ? `yes: \`${r.planHit}\`` : "no"} | ${r.semHit ? `yes: \`${r.semHit}\`` : "no"} | ${r.union ? "**yes**" : "no"} | ${r.planMs} |`)].join("\n");
  fs.writeFileSync(new URL("../eval/out/anchor_pilot_planner.md", import.meta.url), md);
  console.log(md);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
