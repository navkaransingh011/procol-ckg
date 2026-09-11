#!/usr/bin/env node
// Semantic anchoring pilot: for each question, in a NAMED form (has identifiers) and a PLAIN form
// (how a CS person would ask), does the name-based anchor find the right starting node, and does
// the embedding-based anchor? Reports hit@1 / hit@5 / hit@10 and latency. Decides go/no-go on pgvector.
import fs from "node:fs";
import { anchor } from "./service/agent.mjs";
import { semanticAnchor } from "./tools.mjs";
import { pool } from "./db.mjs";

const QS = JSON.parse(fs.readFileSync(new URL("../eval/questions_anchor.json", import.meta.url)));
const REFS = ["main"];
const K = 10;

const hit = (row, spec) => {
  if (!row) return false;
  if (spec.match_kind?.includes(row.kind)) return true;
  // test fqn and name separately so ^ and $ anchors mean what they say
  return (spec.match || []).some(re => [row.fqn, row.name].filter(Boolean).some(h => new RegExp(re, "i").test(h)));
};
const rankOf = (rows, spec) => { const i = rows.findIndex(r => hit(r, spec)); return i === -1 ? null : i + 1; };
const short = (r) => r ? `${r.kind}:${(r.name || r.fqn).slice(0, 44)}` : "-";

async function run(qs, form) {
  const out = [];
  for (const spec of qs) {
    const question = spec[form];
    let t = Date.now();
    const a = await anchor(question, REFS);
    const nameMs = Date.now() - t;
    const nameHit = hit(a.seed, spec);
    t = Date.now();
    const s = await semanticAnchor({ question, k: K, refs: REFS });
    const semMs = Date.now() - t;
    const rank = rankOf(s.matches, spec);
    out.push({ id: spec.id, form, question, nameHit, nameSeed: short(a.seed), nameToken: a.token, nameWeak: a.weak, nameMs,
               semRank: rank, semTop: short(s.matches[0]), semTop3: s.matches.slice(0, 3).map(short), semScore: s.matches[0]?.score, semMs });
  }
  return out;
}

const cell = (b) => b ? "yes" : "no";
function table(rows) {
  const lines = ["| Q | form | name anchor hit@1 | name picked | semantic rank (of 10) | semantic top-1 | ms name / sem |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.id} | ${r.form} | ${cell(r.nameHit)} | \`${r.nameSeed}\`${r.nameWeak ? " (weak)" : ""} | ${r.semRank ?? "miss"} | \`${r.semTop}\` | ${r.nameMs} / ${r.semMs} |`);
  return lines.join("\n");
}
const summary = (rows, label) => {
  const n = rows.length, nh = rows.filter(r => r.nameHit).length;
  const s1 = rows.filter(r => r.semRank === 1).length, s5 = rows.filter(r => r.semRank && r.semRank <= 5).length, s10 = rows.filter(r => r.semRank).length;
  return `**${label}** — name anchor hit@1: ${nh}/${n} · semantic hit@1: ${s1}/${n} · hit@5: ${s5}/${n} · hit@10: ${s10}/${n}`;
};

async function main() {
  const named = await run(QS, "named");
  const plain = await run(QS, "plain");
  const md = [`# Semantic anchoring pilot — ${new Date().toISOString()}`, "",
    `Model: ${(await semanticAnchor({ question: "x", k: 1, refs: REFS })).model}. Refs: ${REFS.join(",")}. k=${K}.`, "",
    summary(named, "Named questions (have identifiers)"), "", table(named), "",
    summary(plain, "Plain questions (no identifiers)"), "", table(plain), "",
    "## Semantic top-3 per plain question", "",
    ...plain.map(r => `- **${r.id}** "${r.question}" → ${r.semTop3.map(x => `\`${x}\``).join(", ")} (top score ${r.semScore?.toFixed(3)})`)].join("\n");
  fs.mkdirSync(new URL("../eval/out/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL("../eval/out/anchor_pilot.md", import.meta.url), md);
  console.log(md);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
