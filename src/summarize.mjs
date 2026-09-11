#!/usr/bin/env node
// Writes ckg.summaries: cached prose at system and feature altitude, in product language.
// This is what makes "what does this system do" cost one row instead of 3.4M tokens of source.
// Every summary records the entities it was built from, so a reader can check it.
import path from "node:path";
import { q, one, hex, upsertRepo, pool } from "./db.mjs";
import { chat, provider } from "./service/llm.mjs";
import { listEntities, resolveScope } from "./tools.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const repoName = arg("repo", "procol-backend");
const ref = arg("ref", "main");
const topN = Number(arg("features", "8"));

const SYS = `You write short factual descriptions of software capabilities for a mixed audience at a
procurement company: customer success, product managers, and engineers.

Rules:
- Use ONLY the facts given. Never invent a feature, file, table or number.
- Lead with what it does for a USER, in product language. No code identifiers in the first sentence.
- Then one sentence on how it is built, naming real directories or models from the facts.
- If the facts are thin, say what is known and stop. Do not pad.
- No marketing language. No "robust", "seamless", "powerful".
- Output exactly two lines:
HEADLINE: <under 12 words, plain language>
BODY: <2-4 sentences>`;

async function writeSummary(row) {
  const r = await q(
    `insert into ckg.summaries (repo_id, commit_sha, altitude, subject_id, subject_key, audience,
                                headline, body, evidence_ids, entity_count, generated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (repo_id, commit_sha, altitude, subject_key, audience) do update
       set headline=excluded.headline, body=excluded.body, evidence_ids=excluded.evidence_ids,
           entity_count=excluded.entity_count, generated_by=excluded.generated_by, generated_at=now()
     returning id`, row);
  return r[0].id;
}

const parse = (text) => {
  const h = text.match(/HEADLINE:\s*(.+)/i)?.[1]?.trim();
  const b = text.match(/BODY:\s*([\s\S]+)/i)?.[1]?.trim();
  return h && b ? { headline: h.replace(/^["']|["']$/g, ""), body: b } : null;
};

async function main() {
  const t0 = Date.now();
  const p = provider();
  if (p.mock) throw new Error("set LLM_BASE_URL/LLM_MODEL/LLM_API_KEY");
  const repoId = await upsertRepo("procol", repoName, repoName.includes("backend") ? "monolith" : "spa");
  const { commits } = await resolveScope([ref]);
  const sha = (await q(`select encode(commit_sha,'hex') h from ckg.ref_history
                         where repo_id=$1 and ref_name=$2 order by last_seen desc limit 1`, [repoId, ref]))[0]?.h;
  if (!sha) throw new Error(`no indexed commit for ${repoName}@${ref}`);

  const feats = await listEntities({ kind: "FEATURE", repo: repoName, refs: [ref], order_by: "activity", limit: 400 });
  const kinds = await q(`select kind::text k, count(*)::int n from ckg.entities
                          where repo_id=$1 and commit_sha=$2 group by 1 order by 2 desc`, [repoId, hex(sha)]);
  const tables = await listEntities({ kind: "DB_TABLE", repo: repoName, refs: [ref], limit: 400 });
  const ext = await listEntities({ kind: "EXTERNAL_SERVICE", repo: repoName, path_prefix: "lib/external_api", refs: [ref], limit: 100 });

  // ---- system altitude
  const documented = feats.items.filter(f => f.attrs?.sources?.some(s => s !== "directory"));
  const sysFacts = {
    repo: repoName, ref,
    inventory: Object.fromEntries(kinds.map(k => [k.k, k.n])),
    documented_capabilities: documented.map(f => ({ name: f.name, bullets: (f.attrs.bullets || []).slice(0, 5) })),
    busiest_capabilities: feats.items.slice(0, 8).map(f => ({ name: f.name, file_touches_12mo: f.attrs?.activity?.file_touches_12mo ?? 0 })),
    tables: tables.total, runtime_integrations: ext.items.map(i => i.name).slice(0, 40),
  };
  const sysMsg = await chat({ messages: [{ role: "system", content: SYS },
    { role: "user", content: `Describe what this repository does, for someone who has never seen it.\n\nFACTS:\n${JSON.stringify(sysFacts, null, 1).slice(0, 14000)}` }],
    max_tokens: 420, temperature: 0.1 });
  const sysP = parse(sysMsg.content || "");
  if (sysP) {
    await writeSummary([repoId, hex(sha), "system", null, "system", "all", sysP.headline, sysP.body,
                        feats.items.slice(0, 20).map(f => Number(f.id)), kinds.reduce((a, k) => a + k.n, 0), `${p.model}@${p.base}`]);
    console.log(`system   ${sysP.headline}`);
  }

  // ---- feature altitude, busiest first
  let n = 0;
  for (const f of feats.items.slice(0, topN)) {
    const impl = await q(
      `select e.kind::text k, e.name, e.path from ckg.entities e
         join ckg.edges g on g.dst_entity_id = e.id and g.kind='IMPLEMENTS' and g.src_entity_id=$1
        order by (e.attrs->'activity'->>'commits_12mo')::int desc nulls last limit 25`, [f.id]);
    const facts = {
      feature: f.name, repo: repoName, sources: f.attrs?.sources,
      described_as: (f.attrs?.bullets || []).slice(0, 10),
      key_models: f.attrs?.key_models, directories: (f.attrs?.dirs || []).slice(0, 12),
      clara_tools: (f.attrs?.mcp_tools || []).map(t => ({ title: t.title, description: t.description })).slice(0, 8),
      activity: f.attrs?.activity, code_sample: impl.slice(0, 15).map(i => `${i.k} ${i.name}`),
    };
    const m = await chat({ messages: [{ role: "system", content: SYS },
      { role: "user", content: `Describe this capability.\n\nFACTS:\n${JSON.stringify(facts, null, 1).slice(0, 9000)}` }],
      max_tokens: 380, temperature: 0.1 });
    const pp = parse(m.content || "");
    if (!pp) continue;
    await writeSummary([repoId, hex(sha), "feature", Number(f.id), f.fqn, "all", pp.headline, pp.body,
                        impl.map(() => Number(f.id)).slice(0, 1).concat(impl.length ? [] : []), impl.length, `${p.model}@${p.base}`]);
    console.log(`feature  ${String(f.name).slice(0, 30).padEnd(32)} ${pp.headline}`);
    n++;
  }
  console.log(`\n${n + (sysP ? 1 : 0)} summaries written in ${Date.now() - t0}ms by ${p.model}`);
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
