#!/usr/bin/env node
// Builds one "card" per entity from graph facts and embeds it. Content-addressed: a card whose
// sha256 is unchanged is not re-embedded, so re-runs after a merge only touch what moved.
//   node --env-file=.env src/embed-index.mjs [--repo procol-backend] [--ref main]
//        [--kinds FEATURE,HANDLER,DB_TABLE,HTTP_ENDPOINT,EXTERNAL_SERVICE,SYMBOL] [--limit N]
import { createHash } from "node:crypto";
import { q, pool } from "./db.mjs";
import { embed, embedModelId, embedDims, toPgVector } from "./service/embed.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const onlyRepo = arg("repo", null);
const ref = arg("ref", "main");
const KINDS = arg("kinds", "FEATURE,DOCUMENT,HANDLER,DB_TABLE,HTTP_ENDPOINT,EXTERNAL_SERVICE,HTTP_CALL_SITE,SYMBOL").split(",");
const LIMIT = Number(arg("limit", "0"));

// "Api::ActivityLogsController#index" -> "api activity logs controller index"
export const humanize = (s) => String(s || "")
  .replace(/[:#./_\-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .toLowerCase().replace(/\s+/g, " ").trim();

const sha256 = (s) => createHash("sha256").update(s).digest();

async function latestCommits() {
  const rows = await q(`select distinct on (r.id) r.id repo_id, r.name repo, encode(h.commit_sha,'hex') sha
                          from ckg.ref_history h join ckg.repos r on r.id=h.repo_id
                         where h.ref_name=$1 and ($2::text is null or r.name=$2)
                         order by r.id, h.last_seen desc`, [ref, onlyRepo]);
  return rows;
}

async function cardsFor(kind, repoId, sha) {
  const scope = kind === "HTTP_ENDPOINT"
    ? `e.kind='HTTP_ENDPOINT' and e.repo_id is null`
    : kind === "DOCUMENT"
    ? `e.kind='DOCUMENT' and ((e.repo_id=$1 and e.commit_sha=decode($2,'hex')) or e.commit_sha is null)`
    : `e.kind::text=$1 and e.repo_id=$2 and e.commit_sha=decode($3,'hex')`;
  const params = kind === "HTTP_ENDPOINT" ? [] : kind === "DOCUMENT" ? [repoId, sha] : [kind, repoId, sha];
  const ents = await q(`select e.id, e.name, e.fqn, e.path, e.attrs from ckg.entities e where ${scope} ${LIMIT ? `limit ${LIMIT}` : ""}`, params);
  if (!ents.length) return [];
  const ids = ents.map(e => Number(e.id));
  const cards = new Map();

  if (kind === "FEATURE") {
    const sums = await q(`select subject_id, headline, body from ckg.summaries where subject_id = any($1) and altitude='feature'`, [ids]);
    const byId = new Map(sums.map(s => [Number(s.subject_id), s]));
    for (const e of ents) {
      const s = byId.get(Number(e.id));
      const a = e.attrs || {};
      const parts = [`Feature: ${e.name} (${humanize(e.name)}).`];
      if (s) parts.push(`${s.headline} ${s.body}`);
      else if (a.bullets?.length) parts.push((a.bullets || []).slice(0, 6).join(" "));
      if (a.dirs?.length) parts.push(`Code lives in ${a.dirs.slice(0, 8).join(", ")}.`);
      if (a.key_models?.length) parts.push(`Key models: ${a.key_models.slice(0, 8).join(", ")}.`);
      cards.set(e.id, parts.join(" "));
    }
  } else if (kind === "HANDLER") {
    const served = await q(`select g.src_entity_id hid, ep.name path, ep.attrs->>'method' method
                              from ckg.edges g join ckg.entities ep on ep.id=g.dst_entity_id
                             where g.kind='SERVES' and g.src_entity_id = any($1)`, [ids]);
    const routes = new Map();
    for (const r of served) { if (!routes.has(Number(r.hid))) routes.set(Number(r.hid), []); routes.get(Number(r.hid)).push(`${r.method || ""} ${r.path}`.trim()); }
    for (const e of ents) {
      const rs = routes.get(Number(e.id)) || [];
      cards.set(e.id, `Controller action ${e.name} (${humanize(e.name)}) in ${e.path}.` +
        (rs.length ? ` Handles HTTP routes ${rs.slice(0, 6).join(", ")} (${humanize(rs.slice(0, 3).join(" "))}).` : ""));
    }
  } else if (kind === "DB_TABLE") {
    for (const e of ents) {
      const cols = (e.attrs?.columns || []).map(c => c.name);
      cards.set(e.id, `Database table ${e.name} (${humanize(e.name)}) storing records with columns: ${cols.join(", ")}.`);
    }
  } else if (kind === "HTTP_ENDPOINT") {
    for (const e of ents) cards.set(e.id, `HTTP API endpoint ${e.attrs?.method || ""} ${e.name} (${humanize(e.name)}).`);
  } else if (kind === "EXTERNAL_SERVICE") {
    for (const e of ents) {
      const a = e.attrs || {};
      cards.set(e.id, `External service integration ${e.name} (${humanize(e.name)}) in ${e.path}.` +
        (a.hosts?.length ? ` Hosts: ${a.hosts.join(", ")}.` : "") + (a.env_keys?.length ? ` Config keys: ${a.env_keys.join(", ")}.` : ""));
    }
  } else if (kind === "HTTP_CALL_SITE") {
    for (const e of ents) {
      const a = e.attrs || {};
      const dir = String(e.path || "").split("/").slice(0, -1).join("/");
      cards.set(e.id, `Frontend screen code in ${e.path} (${humanize(dir)}) calls backend API ${a.method || ""} ${a.pathTemplate || a.raw || ""} (${humanize(a.pathTemplate || "")}).`);
    }
  } else if (kind === "DOCUMENT") {
    for (const e of ents) {
      const a = e.attrs || {};
      cards.set(e.id, `Documentation: ${e.name} (${humanize(e.name)}) in ${e.path}. Sections: ${(a.headings || []).slice(0, 12).join("; ")}.${a.tags?.length ? ` Tags: ${a.tags.join(", ")}.` : ""}`);
    }
  } else if (kind === "SYMBOL") {
    // a class card lists its members: "Session ... methods generate_access_token, enforce_single_web_session"
    // is what lets "why does a new login token log people out" land on Session without the word.
    const members = await q(`select attrs->>'class' cls, name from ckg.entities e
                              where e.kind='SYMBOL' and e.repo_id=$1 and e.commit_sha=decode($2,'hex')
                                and e.attrs->>'subkind' in ('method','class_method')`, [repoId, sha]);
    const byClass = new Map();
    for (const m of members) {
      if (!m.cls) continue;
      const short = String(m.name).split(/[#.]/).pop();
      if (!byClass.has(m.cls)) byClass.set(m.cls, []);
      if (byClass.get(m.cls).length < 40) byClass.get(m.cls).push(short);
    }
    for (const e of ents) {
      const sk = e.attrs?.subkind || "symbol";
      let card = `Ruby ${sk.replace("_", " ")} ${e.name} (${humanize(e.name)}) in ${e.path}.`;
      if ((sk === "class" || sk === "module") && byClass.has(e.name)) {
        const ms = byClass.get(e.name);
        card += ` Members: ${ms.join(", ")} (${humanize(ms.slice(0, 25).join(" "))}).`;
      }
      cards.set(e.id, card);
    }
  }
  return ents.map(e => ({ id: Number(e.id), card: cards.get(e.id) })).filter(c => c.card);
}

async function main() {
  const t0 = Date.now();
  const model = embedModelId(), dims = embedDims();
  const repos = await latestCommits();
  if (!repos.length) throw new Error(`no indexed commit for ref ${ref}`);
  let embedded = 0, skipped = 0;
  const doneEndpoints = { done: false };
  for (const r of repos) {
    for (const kind of KINDS) {
      if (kind === "HTTP_ENDPOINT") { if (doneEndpoints.done) continue; doneEndpoints.done = true; }
      const cards = await cardsFor(kind, r.repo_id, r.sha);
      if (!cards.length) continue;
      const existing = await q(`select entity_id, text_hash from ckg.embeddings where model=$1 and entity_id = any($2)`, [model, cards.map(c => c.id)]);
      const have = new Map(existing.map(x => [Number(x.entity_id), Buffer.from(x.text_hash).toString("hex")]));
      const todo = cards.filter(c => have.get(c.id) !== sha256(c.card).toString("hex"));
      skipped += cards.length - todo.length;
      const tk = Date.now();
      for (let i = 0; i < todo.length; i += 256) {
        const batch = todo.slice(i, i + 256);
        const vecs = await embed(batch.map(b => b.card));
        const values = batch.map((b, j) => `(${b.id}, $1, ${dims}, decode('${sha256(b.card).toString("hex")}','hex'), $${j + 2}, '${toPgVector(vecs[j])}'::vector)`).join(",");
        await q(`insert into ckg.embeddings (entity_id, model, dims, text_hash, card, embedding) values ${values}
                 on conflict (entity_id, model) do update set text_hash=excluded.text_hash, card=excluded.card,
                   embedding=excluded.embedding, created_at=now()`, [model, ...batch.map(b => b.card)]);
        embedded += batch.length;
      }
      console.log(`${r.repo.padEnd(24)} ${kind.padEnd(17)} ${String(cards.length).padStart(6)} cards  ${String(todo.length).padStart(6)} embedded  ${Date.now() - tk}ms`);
    }
  }
  // ---- documentation passages ----
  const tc = Date.now();
  const chunks = await q(`select c.blob_sha, c.ordinal, c.heading_path, c.text, coalesce(d.name, '') title
                            from ckg.doc_chunks c left join lateral (select name from ckg.entities e where e.blob_sha=c.blob_sha and e.kind='DOCUMENT' limit 1) d on true
                           where c.embedding is null or c.model <> $1`, [model]);
  for (let i = 0; i < chunks.length; i += 128) {
    const b = chunks.slice(i, i + 128);
    const vecs = await embed(b.map(c => `${c.title} > ${c.heading_path}\n${c.text}`.slice(0, 4000)));
    for (let j = 0; j < b.length; j++)
      await q(`update ckg.doc_chunks set embedding=$3::vector, model=$4 where blob_sha=$1 and ordinal=$2`, [b[j].blob_sha, b[j].ordinal, toPgVector(vecs[j]), model]);
  }
  if (chunks.length) console.log(`${"documentation".padEnd(24)} ${"DOC_CHUNKS".padEnd(17)} ${String(chunks.length).padStart(6)} passages embedded  ${Date.now() - tc}ms`);
  console.log(`\n${embedded} embedded, ${skipped} unchanged, ${chunks.length} doc passages, model ${model}, ${Date.now() - t0}ms`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
