// Retention. Entities and edges are commit-scoped and additive by design (sql/001_core.sql),
// so every merge inserts a full tree snapshot and nothing ever leaves. That is correct for
// correctness -- answers are always scoped to one commit -- and unbounded for disk.
//
// This keeps the newest KEEP commits per (repo, ref) and deletes the rest. Two constraints
// shape it:
//   1. inheritObserved() reads the PREVIOUS commit on the ref to carry runtime edges forward.
//      Deleting it silently destroys evidence no extractor can regenerate, so KEEP >= 2.
//      The default of 5 leaves slack for a bad index run or a rollback.
//   2. edges.src/dst_entity_id are FKs into entities, so edges must go first.
//
// A commit referenced by ANY kept ref survives, even if another ref has moved past it.
import { q, tx } from "./db.mjs";

export const DEFAULT_KEEP = 5;

/** Commit shas that must survive: the newest `keep` per (repo_id, ref_name). */
async function survivors(keep) {
  return q(
    `select distinct encode(commit_sha, 'hex') sha from (
       select h.repo_id, h.ref_name, h.commit_sha,
              row_number() over (partition by h.repo_id, h.ref_name order by h.last_seen desc) rn
         from ckg.ref_history h) t
      where rn <= $1`,
    [keep],
  ).then((rows) => rows.map((r) => r.sha));
}

/**
 * Delete entities/edges for commits no live ref still points at.
 * Repo-agnostic rows (commit_sha is null -- shared HTTP_ENDPOINT contract nodes, uploaded
 * DOCUMENTs) are never touched: they belong to no commit and are what cross-repo joins hang on.
 */
export async function collect({ keep = DEFAULT_KEEP, dryRun = false } = {}) {
  if (!Number.isInteger(keep) || keep < 2) throw new Error("keep must be an integer >= 2 (inheritObserved needs the previous commit)");
  const alive = await survivors(keep);

  const [{ n: deadCommits }] = await q(
    `select count(*)::int n from ckg.commits where encode(sha,'hex') <> all($1::text[])`, [alive]);
  if (!deadCommits) return { keep, deadCommits: 0, edges: 0, entities: 0, dryRun };

  const [{ n: edges }] = await q(
    `select count(*)::int n from ckg.edges
      where commit_sha is not null and encode(commit_sha,'hex') <> all($1::text[])`, [alive]);
  const [{ n: entities }] = await q(
    `select count(*)::int n from ckg.entities
      where commit_sha is not null and encode(commit_sha,'hex') <> all($1::text[])`, [alive]);

  if (dryRun) return { keep, deadCommits, edges, entities, dryRun: true };

  // Order is forced by the foreign keys into entities(id):
  //   edges.src/dst/guard_entity_id (001_core.sql) -- no cascade, delete first
  //   summaries.subject_id          (006_summaries.sql) -- no cascade, delete first
  //   embeddings.entity_id          (008_embeddings.sql) -- on delete cascade, handled for us
  // guard_entity_id is why the edge delete is not purely commit-scoped: an edge on a KEPT
  // commit may guard an entity on a dead one. Those edges go too -- the guard they name is
  // about to stop existing.
  // One transaction on one connection (a pooled q() per statement could put begin and delete
  // on different connections) so a failure mid-way cannot orphan a reference.
  await tx(async (c) => {
    await c.query(`delete from ckg.edges
                    where (commit_sha is not null and encode(commit_sha,'hex') <> all($1::text[]))
                       or guard_entity_id in (select id from ckg.entities
                                               where commit_sha is not null
                                                 and encode(commit_sha,'hex') <> all($1::text[]))`, [alive]);
    await c.query(`delete from ckg.summaries
                    where commit_sha is not null and encode(commit_sha,'hex') <> all($1::text[])`, [alive]);
    await c.query(`delete from ckg.entities
                    where commit_sha is not null and encode(commit_sha,'hex') <> all($1::text[])`, [alive]);
  });

  return { keep, deadCommits, edges, entities, dryRun: false };
}

// CLI: node src/gc.mjs [--keep 5] [--dry-run]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
  const keep = Number(arg("keep", DEFAULT_KEEP));
  const dryRun = argv.includes("--dry-run");
  collect({ keep, dryRun })
    .then((r) => {
      console.log(r.dryRun
        ? `dry run: would delete ${r.entities} entities, ${r.edges} edges across ${r.deadCommits} commits (keeping ${r.keep}/ref)`
        : `deleted ${r.entities} entities, ${r.edges} edges across ${r.deadCommits} commits (keeping ${r.keep}/ref)`);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
