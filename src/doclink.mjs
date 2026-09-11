// Links a commit-less DOCUMENT node to the code it names, per commit. Shared by the ingest CLI and the indexer
// (which re-links every uploaded doc whenever a branch moves to a new commit).
import { createHash } from "node:crypto";
import { q, hex } from "./db.mjs";

/** Link a commit-less DOCUMENT to the code it names, against the CURRENT commit of every repo (or a given one). */
export async function linkDocMentions(docId, mentions, { repoId = null, commitSha = null } = {}) {
  const scope = repoId ? [{ repo_id: repoId, sha: commitSha }]
    : await q(`select distinct on (r.repo_id) r.repo_id, encode(r.commit_sha,'hex') sha from ckg.ref_history r where r.ref_name='main' order by r.repo_id, r.last_seen desc`);
  let linked = 0;
  for (const sc of scope) {
    const targets = [];
    for (const { key, n } of mentions || []) {
      const kind = key.slice(0, key.indexOf(":")), name = key.slice(key.indexOf(":") + 1);
      const fqns = kind === "snake" ? [`be:table:${name}`, `be:sym:${name}`] : [`be:sym:${name}`];
      for (const f of fqns) targets.push({ f, n });
    }
    if (!targets.length) continue;
    const rows = await q(`select id, fqn from ckg.entities where repo_id=$1 and commit_sha=decode($2,'hex') and fqn = any($3::text[])`, [sc.repo_id, sc.sha, targets.map(t => t.f)]);
    const byFqn = new Map(rows.map(r => [r.fqn, r.id]));
    const edges = targets.filter(t => byFqn.has(t.f));
    if (!edges.length) continue;
    const site = (t) => hex(createHash("sha1").update(`doc:${docId}|${t.f}`).digest("hex"));
    await q(`insert into ckg.edges (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, attrs, status, extractor, confidence, resolution)
             select $1, decode($2,'hex'), 'MENTIONS', $3, u.dst, u.site, jsonb_build_object('times', u.n), 'OBSERVED', 'ingest-doc@1.0', u.conf, 'DOCUMENTED'
               from unnest($4::bigint[], $5::bytea[], $6::int[], $7::numeric[]) as u(dst, site, n, conf) on conflict do nothing`,
            [sc.repo_id, sc.sha, docId, edges.map(t => byFqn.get(t.f)), edges.map(site), edges.map(t => t.n), edges.map(t => Math.min(0.95, 0.6 + t.n * 0.05))]);
    linked += edges.length;
  }
  return linked;
}
