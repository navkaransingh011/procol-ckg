#!/usr/bin/env node
// Runs eval/questions_deep.json through the plan-mode agent for each model and saves answers.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
process.env.LLM_MODE = process.env.COMPARE_MODE || "plan";
const { ask } = await import("./service/agent.mjs");
const { pool } = await import("./db.mjs");

const models = (process.env.COMPARE_MODELS || "FAST_SMALLER,HACK26_GPT_5_6_LUNA").split(",");
const only = (process.env.COMPARE_QIDS || "").split(",").filter(Boolean);
const suffix = process.env.COMPARE_SUFFIX || "";
const questions = JSON.parse(readFileSync(new URL("../eval/questions_deep.json", import.meta.url)))
  .filter(q => !only.length || only.includes(q.id));
const out = {};
mkdirSync("eval/out", { recursive: true });

for (const model of models) {
  process.env.LLM_MODEL = model;
  out[model] = {};
  for (const qn of questions) {
    const t0 = Date.now();
    const r = { text: "", claims: 0, evidence: 0, unresolved: 0, statuses: [], errors: [] };
    const summary = await ask({ question: qn.q, refs: ["main"], emit: (e) => {
      if (e.type === "token") r.text += e.text;
      else if (e.type === "claim") r.claims++;
      else if (e.type === "evidence") r.evidence++;
      else if (e.type === "unresolved") r.unresolved++;
      else if (e.type === "status") r.statuses.push(e.text);
      else if (e.type === "error") r.errors.push(e.message);
    }});
    r.ms = Date.now() - t0; r.lookups = summary.lookups; r.matched = summary.matched; r.sql = summary.sql; r.evidence = summary.evidence_count ?? r.evidence;
    out[model][qn.id] = r;
    const head = r.sql ? `_${r.sql.length} queries (${r.sql.filter(x=>!x.ok).length} failed), ${r.evidence} evidence — ${r.ms}ms_\n\n` + r.sql.map((x,i)=>`**Q${i+1}** ${x.ok ? x.rows+" rows" : "ERROR "+x.error}\n\n\`\`\`sql\n${x.sql}\n\`\`\``).join("\n\n") + "\n\n---\n\n"
                        : `_lookups: ${(r.lookups||[]).join(" · ")} — matched ${r.matched}/${(r.lookups||[]).length} — ${r.claims} claims, ${r.evidence} evidence, ${r.unresolved} unresolved — ${r.ms}ms_\n\n`;
    writeFileSync(`eval/out/${model}__${qn.id}${suffix}.md`, `# ${qn.id} (${qn.level}) — ${model} [${process.env.LLM_MODE}]\n\n**Q:** ${qn.q}\n\n${head}${r.text.trim()}\n`);
    const stat = r.sql ? `queries=${r.sql.length} failed=${r.sql.filter(x=>!x.ok).length} evidence=${r.evidence}` : `lookups=${(r.lookups||[]).length} matched=${r.matched} claims=${r.claims} unresolved=${r.unresolved}`;
    console.log(`${model.padEnd(20)} ${qn.id}  ${String(r.ms).padStart(6)}ms  ${stat} prose=${r.text.length}ch${r.errors.length ? "  ERR " + r.errors[0].slice(0,50) : ""}`);
  }
}
writeFileSync(`eval/out/compare${suffix}.json`, JSON.stringify(out, null, 1));
await pool.end();
