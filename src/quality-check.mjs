#!/usr/bin/env node
// Did this commit's snapshot come out as good as the last one on the same ref?
//
// Why this exists: a snapshot can lose a whole layer without anything failing. The route
// extractor rescued a Ruby error and exited 0, so index-commit recorded a successful parse
// holding zero routes, the run reported ok, and the workflow went green -- with 3,336
// SERVER_ROUTE and 1,583 HANDLER nodes silently missing. Counting is the only thing that
// catches that class of fault, because every individual step genuinely succeeded.
//
// Compares the newest commit on (repo, ref) against the previous one and reports per-kind
// entity and edge counts, embedding coverage, and extractor parse failures.
//
// Usage: node src/quality-check.mjs --repo procol-backend --ref main [--json]
// Exit code is always 0: this reports, it does not gate. The caller decides what to do.
import { q } from "./db.mjs";

// A kind losing this fraction of its rows is worth a human look. Deliberate deletions do
// shrink a snapshot, so a small drop is normal and only a large one is a signal.
const DROP_WARN = 0.02;
// Kinds embed-index builds cards for. An entity of one of these with no vector is invisible
// to semantic anchoring, and semanticAnchor fails silently -- it returns no matches, not an error.
const EMBEDDED_KINDS = ["FEATURE", "DOCUMENT", "HANDLER", "DB_TABLE", "HTTP_ENDPOINT",
                        "EXTERNAL_SERVICE", "HTTP_CALL_SITE", "SYMBOL", "UI_ROUTE", "UI_ACTION"];

/** The newest two commits on a ref, newest first. A fresh ref has only one. */
async function recentCommits(repo, ref, n = 2) {
  return q(
    `select encode(h.commit_sha, 'hex') sha, h.commit_sha, h.repo_id, h.last_seen
       from ckg.ref_history h join ckg.repos r on r.id = h.repo_id
      where r.name = $1 and h.ref_name = $2
      order by h.last_seen desc limit $3`,
    [repo, ref, n],
  );
}

const countsBy = async (table, repoId, sha) =>
  new Map((await q(
    `select kind::text kind, count(*)::int n from ckg.${table}
      where repo_id = $1 and commit_sha = $2 group by kind`, [repoId, sha],
  )).map((r) => [r.kind, r.n]));

/** Entities of embeddable kinds on this commit that have no vector. */
async function unembedded(repoId, sha) {
  const [row] = await q(
    `select count(*) filter (where em.entity_id is null)::int missing, count(*)::int total
       from ckg.entities e
       left join ckg.embeddings em on em.entity_id = e.id
      where e.repo_id = $1 and e.commit_sha = $2 and e.kind::text = any($3)`,
    [repoId, sha, EMBEDDED_KINDS],
  );
  return row || { missing: 0, total: 0 };
}

/** Extractors that threw on a blob in this commit's tree. Cached, so they do not retry. */
async function parseFailures(repoId, sha) {
  return q(
    `select bf.extractor, count(*)::int n, min(left(bf.parse_error, 200)) sample
       from ckg.commit_files cf
       join ckg.blob_facts bf on bf.blob_sha = cf.blob_sha
      where cf.repo_id = $1 and cf.commit_sha = $2 and bf.parse_ok = false
      group by bf.extractor order by 2 desc`,
    [repoId, sha],
  );
}

/**
 * Compare the newest snapshot on a ref against its predecessor.
 * Returns a plain object; callers render it. `warnings` is empty when all is well.
 */
export async function qualityCheck({ repo, ref }) {
  const commits = await recentCommits(repo, ref);
  if (!commits.length) return { repo, ref, error: `no indexed commit for ${repo}@${ref}` };

  const [now, prev] = commits;
  const out = {
    repo, ref,
    commit: now.sha,
    previous: prev?.sha || null,
    entities: [], edges: [], warnings: [],
  };

  const [entNow, edgNow] = await Promise.all([
    countsBy("entities", now.repo_id, now.commit_sha),
    countsBy("edges", now.repo_id, now.commit_sha),
  ]);
  const [entPrev, edgPrev] = prev
    ? await Promise.all([
        countsBy("entities", prev.repo_id, prev.commit_sha),
        countsBy("edges", prev.repo_id, prev.commit_sha),
      ])
    : [new Map(), new Map()];

  for (const [label, nowMap, prevMap, sink] of
       [["entity", entNow, entPrev, out.entities], ["edge", edgNow, edgPrev, out.edges]]) {
    for (const kind of [...new Set([...nowMap.keys(), ...prevMap.keys()])].sort()) {
      const n = nowMap.get(kind) || 0;
      const p = prevMap.get(kind) || 0;
      sink.push({ kind, now: n, prev: p, delta: n - p });
      if (!prev) continue;
      // A kind that existed and is now entirely gone is the loud case: that is a whole
      // layer of the graph disappearing, which is what happened with the routes.
      if (p > 0 && n === 0) out.warnings.push(`${label} ${kind}: ${p} -> 0, the kind vanished entirely`);
      else if (p > 0 && n < p * (1 - DROP_WARN))
        out.warnings.push(`${label} ${kind}: ${p} -> ${n} (${(100 * (p - n) / p).toFixed(1)}% fewer)`);
    }
  }

  const emb = await unembedded(now.repo_id, now.commit_sha);
  out.embeddings = emb;
  // Anything unembedded is worth saying, because the failure mode downstream is silence:
  // semanticAnchor returns zero matches rather than an error, and plain-English questions
  // lose their starting point with nothing in any log.
  if (emb.missing > 0)
    out.warnings.push(`embeddings: ${emb.missing} of ${emb.total} entities have no vector; semantic search cannot reach them`);

  const fails = await parseFailures(now.repo_id, now.commit_sha);
  out.parse_failures = fails;
  for (const f of fails)
    out.warnings.push(`extractor ${f.extractor}: ${f.n} blob(s) failed to parse — ${f.sample}`);

  return out;
}

/** Markdown for a GitHub job summary. Compact: only kinds that moved, plus every warning. */
export function renderMarkdown(r) {
  if (r.error) return `### Code graph quality\n\n${r.error}\n`;
  const L = [`### Code graph quality — \`${r.repo}@${r.ref}\``, ""];
  L.push(r.previous
    ? `Commit \`${r.commit.slice(0, 8)}\` compared against \`${r.previous.slice(0, 8)}\`.`
    : `Commit \`${r.commit.slice(0, 8)}\`. First snapshot on this ref, so there is nothing to compare against.`);
  L.push("");

  for (const [title, rows] of [["Entities", r.entities], ["Edges", r.edges]]) {
    const moved = rows.filter((x) => x.delta !== 0);
    if (!rows.length) continue;
    L.push(`**${title}** — ${rows.length} kind${rows.length === 1 ? "" : "s"}, ${rows.reduce((a, x) => a + x.now, 0).toLocaleString()} rows`
         + (r.previous ? `, ${moved.length} changed` : ""));
    if (moved.length) {
      L.push("", "| kind | previous | now | change |", "|---|---:|---:|---:|");
      for (const x of moved)
        L.push(`| \`${x.kind}\` | ${x.prev.toLocaleString()} | ${x.now.toLocaleString()} | ${x.delta > 0 ? "+" : ""}${x.delta.toLocaleString()} |`);
    }
    L.push("");
  }

  if (r.embeddings)
    L.push(`**Embeddings** — ${(r.embeddings.total - r.embeddings.missing).toLocaleString()} of ${r.embeddings.total.toLocaleString()} embeddable entities have a vector.`, "");

  if (r.warnings.length) {
    L.push("**Warnings**", "");
    for (const w of r.warnings) L.push(`- ${w}`);
  } else {
    L.push("No regressions: nothing lost a kind, nothing shrank beyond noise, everything embeddable is embedded.");
  }
  return L.join("\n") + "\n";
}

// CLI: node src/quality-check.mjs --repo procol-backend --ref main [--json]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
  const repo = arg("repo");
  const ref = arg("ref", "main");
  if (!repo) { console.error("--repo is required"); process.exit(2); }
  qualityCheck({ repo, ref })
    .then((r) => {
      console.log(argv.includes("--json") ? JSON.stringify(r) : renderMarkdown(r));
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
