#!/usr/bin/env node
// Triage calibration: run eval/tickets.json through the same triage the UI uses and score the verdicts.
//   node --env-file=.env src/eval-triage.mjs [--role cs] [--only t1,t3]
// Fill tickets.json with real anonymised tickets and the verdict that actually resolved them (knowledge = CS
// answered, config = an admin flipped a switch, engineering = a developer fixed it). Accuracy here is the number
// to watch before trusting the card.
import { readFileSync } from "node:fs";
import { ask } from "./service/agent.mjs";
import { policyFor } from "./service/policy.mjs";
import { pool } from "./db.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const only = arg("only", null)?.split(",");
const policy = policyFor(arg("role", "cs"));
const tickets = JSON.parse(readFileSync(new URL("../eval/tickets.json", import.meta.url), "utf8")).filter(t => !only || only.includes(t.id));

let right = 0;
for (const t of tickets) {
  let card = null, ms = 0;
  await ask({ question: `triage: ${t.text}`, refs: ["main"], style: "simple", fresh: true, policy, emit: (e) => { if (e.type === "triage") card = e; if (e.type === "done") ms = e.ms; } });
  const verdictOk = card && (t.expect_verdict || []).includes(card.verdict);
  const wants = [].concat(t.expect_feature_contains || []).map(w => String(w).toLowerCase());
  const featureOk = !wants.length || (card?.features_found || []).some(f => wants.some(w => f.name.toLowerCase().includes(w)));
  if (verdictOk && featureOk) right++;
  console.log(`${t.id.padEnd(4)} ${(card?.verdict || "none").padEnd(12)} ${verdictOk ? "verdict ok " : "verdict MISS"} ${featureOk ? "feature ok " : "feature MISS"} ${String(Math.round(ms / 1000)).padStart(3)}s  ` +
              `features=${(card?.features_found || []).map(f => f.name).join("|") || "-"}  confidence=${card?.confidence || "-"}${card?.verdict_requested ? `  (downgraded from ${card.verdict_requested})` : ""}`);
}
console.log(`\n${right}/${tickets.length} tickets triaged as expected`);
await pool.end();
process.exitCode = right === tickets.length ? 0 : 1;
