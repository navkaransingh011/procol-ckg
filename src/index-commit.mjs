#!/usr/bin/env node
// Index one (repo, ref) into the knowledge graph.
//
// TWO PHASES, and the split is the whole design:
//   PER-BLOB   -- parse one file in isolation. Cached by content SHA. Skipped on a hit.
//   PER-COMMIT -- resolve across the tree into entities + edges. Always re-runs, because
//                 it is pure in-memory work: exact, not "changed files plus one hop".
//
// Usage: node src/index-commit.mjs --repo-dir <path> --ref <ref> [--trigger push]

import { resolveRef, listTree, readBlobs } from "./git.mjs";
import { q, one, hex, upsertRepo, upsertCommit, touchRef } from "./db.mjs";
import { cachedBlobs, registerBlobs, storeFacts, loadFacts, recordCommitFiles } from "./cache.mjs";
import * as feHttp     from "./extractors/fe-http.mjs";
import * as beRoutes   from "./extractors/be-routes.mjs";
import * as beSchema   from "./extractors/be-schema.mjs";
import * as beExternal from "./extractors/be-external.mjs";
import * as beAst      from "./extractors/be-ast.mjs";
import * as docs       from "./extractors/docs.mjs";
import { linkDocMentions } from "./doclink.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeEndpoint } from "./normalize.mjs";

const EXTRACTORS = [feHttp, beRoutes, beSchema, beExternal, beAst, docs];
const SECRET_PATHS = /(^|\/)(\.env|\.env\..*|.*\.pem|id_rsa.*|.*\.key|.*\.p12)$/;
// What gets its TEXT stored (so the agent can read and grep it without a clone).
const SOURCE_DIRS = /^(app|lib|config|db|src|spec|test)\//;
const SOURCE_EXT = /\.(rb|rake|erb|jbuilder|haml|slim|js|jsx|ts|tsx|mjs|cjs|json|ya?ml|less|css|scss|sql|md)$/;

/** Store file text for blobs not yet kept. Content-addressed: a blob is stored once, ever. */
async function storeBlobText(repoDir, files) {
  const uniq = [...new Set(files.map((f) => f.blobSha))];
  if (!uniq.length) return 0;
  const have = new Set((await q(`select encode(blob_sha,'hex') h from ckg.blob_text where blob_sha = any($1::bytea[])`,
                                [uniq.map(hex)])).map((r) => r.h));
  const misses = uniq.filter((s) => !have.has(s));
  let stored = 0;
  for (let i = 0; i < misses.length; i += 300) {
    const batch = misses.slice(i, i + 300);
    const contents = await readBlobs(repoDir, batch);
    const rows = [];
    for (const sha of batch) {
      const buf = contents.get(sha);
      if (!buf || buf.includes(0)) continue;                       // binary: skip
      const text = buf.toString("utf8");
      rows.push([hex(sha), text, text.split("\n").length]);
    }
    if (!rows.length) continue;
    const values = rows.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(",");
    await q(`insert into ckg.blob_text (blob_sha, text, lines) values ${values} on conflict (blob_sha) do nothing`, rows.flat());
    stored += rows.length;
  }
  return stored;
}
const MAX_BLOB_BYTES = 512 * 1024;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const siteHash = (key) => hex(createHash("sha1").update(String(key)).digest("hex"));


/**
 * Observed evidence survives a re-index when the code it was observed in did not change.
 * Runtime CALLS edges and OBSERVED_DEFECT nodes come from test-run tracing, which does not re-run on
 * every merge. For the new commit, copy each such edge from the previous commit when BOTH endpoint
 * symbols still exist AND their files have identical content (same blob hash). Edges touching a
 * changed file are dropped -- the body changed, the observation may no longer hold. Copies keep
 * attrs.observed_at = the commit the evidence was actually captured on, so answers can say so.
 */
async function inheritObserved(repoId, newSha, prevSha) {
  if (!prevSha || prevSha === newSha) return { calls: 0, defects: 0, defect_edges: 0, dropped: 0 };
  const params = [repoId, hex(prevSha), hex(newSha)];
  // pairs of (old id -> new id) for symbols whose file content is unchanged
  const same = `select o.id as old_id, n.id as new_id from ckg.entities o
                  join ckg.entities n on n.repo_id = o.repo_id and n.kind = o.kind and n.fqn = o.fqn
                                     and n.commit_sha = $3 and n.blob_sha is not distinct from o.blob_sha
                 where o.repo_id = $1 and o.commit_sha = $2 and o.blob_sha is not null`;
  const [{ n: candidates }] = await q(`select count(*)::int n from ckg.edges g where g.repo_id=$1 and g.commit_sha=$2 and g.kind='CALLS' and g.resolution='RUNTIME'`, [repoId, hex(prevSha)]);
  const calls = await q(
    `with same as (${same})
     insert into ckg.edges (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, start_line, end_line,
                            guard_expr, attrs, status, extractor, confidence, resolution)
     select $1, $3, g.kind, s.new_id, d.new_id, g.site_hash, g.start_line, g.end_line, g.guard_expr,
            coalesce(g.attrs,'{}'::jsonb) || jsonb_build_object('observed_at', coalesce(g.attrs->>'observed_at', encode($2,'hex')), 'inherited', true),
            g.status, g.extractor, g.confidence, g.resolution
       from ckg.edges g join same s on s.old_id = g.src_entity_id join same d on d.old_id = g.dst_entity_id
      where g.repo_id = $1 and g.commit_sha = $2 and g.kind = 'CALLS' and g.resolution = 'RUNTIME'
     on conflict do nothing returning 1`, params);
  // defects: copy the node when the symbol it hangs off is unchanged, then the edge
  const defects = await q(
    `with same as (${same}),
     src_defects as (
       select distinct df.id as old_id from ckg.edges g join ckg.entities df on df.id = g.dst_entity_id
        where g.repo_id = $1 and g.commit_sha = $2 and g.kind = 'TRIGGERS_DEFECT' and df.kind = 'OBSERVED_DEFECT'
          and g.src_entity_id in (select old_id from same))
     insert into ckg.entities (repo_id, commit_sha, kind, fqn, name, path, blob_sha, start_line, end_line, attrs, status, extractor, confidence, resolution)
     select df.repo_id, $3, df.kind, df.fqn, df.name, df.path, df.blob_sha, df.start_line, df.end_line,
            coalesce(df.attrs,'{}'::jsonb) || jsonb_build_object('observed_at', coalesce(df.attrs->>'observed_at', encode($2,'hex')), 'inherited', true),
            df.status, df.extractor, df.confidence, df.resolution
       from ckg.entities df where df.id in (select old_id from src_defects)
     on conflict do nothing returning 1`, params);
  const defectEdges = await q(
    `with same as (${same}),
     newdef as (select o.id as old_id, n.id as new_id from ckg.entities o
                  join ckg.entities n on n.repo_id = o.repo_id and n.kind = o.kind and n.fqn = o.fqn and n.commit_sha = $3
                 where o.repo_id = $1 and o.commit_sha = $2 and o.kind = 'OBSERVED_DEFECT')
     insert into ckg.edges (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, start_line, end_line,
                            guard_expr, attrs, status, extractor, confidence, resolution)
     select $1, $3, g.kind, s.new_id, d.new_id, g.site_hash, g.start_line, g.end_line, g.guard_expr,
            coalesce(g.attrs,'{}'::jsonb) || jsonb_build_object('observed_at', coalesce(g.attrs->>'observed_at', encode($2,'hex')), 'inherited', true),
            g.status, g.extractor, g.confidence, g.resolution
       from ckg.edges g join same s on s.old_id = g.src_entity_id join newdef d on d.old_id = g.dst_entity_id
      where g.repo_id = $1 and g.commit_sha = $2 and g.kind = 'TRIGGERS_DEFECT'
     on conflict do nothing returning 1`, params);
  return { calls: calls.length, defects: defects.length, defect_edges: defectEdges.length, dropped: candidates - calls.length, from: prevSha.slice(0, 8) };
}

async function main() {
  const repoDir = arg("repo-dir");
  const ref = arg("ref", "HEAD");
  const trigger = arg("trigger", "manual");
  const tenant = arg("tenant", null);
  const env = arg("env", null);
  const asRef = arg("as", null);   // record a raw SHA under the ref name it was, e.g. --ref 1089000b3a --as main
  if (!repoDir) throw new Error("--repo-dir is required");

  const t0 = Date.now();
  const repoName = path.basename(path.resolve(repoDir));
  const commit = await resolveRef(repoDir, ref);

  const repoId = await upsertRepo("procol", repoName, repoName.includes("backend") ? "monolith" : "spa");
  // A ref currently pointing at an imported (kb-import) commit holds data no extractor can reproduce
  // -- runtime edges, defects, summaries, embeddings. Re-pointing it to local HEAD would drop all of
  // that silently. Refuse unless --force. (Once the dump is re-generated from CI this guard is moot.)
  const refName0 = (asRef || ref).replace(/^origin\//, "");
  const cur = await one(`select encode(h.commit_sha,'hex') sha from ckg.ref_history h
                          where h.repo_id=$1 and h.ref_name=$2 order by last_seen desc limit 1`, [repoId, refName0]).catch(() => null);
  if (cur && cur.sha !== commit.sha && !argv.includes("--force")) {
    const [imp] = await q(`select count(*)::int n from ckg.entities where repo_id=$1 and commit_sha=decode($2,'hex') and extractor like 'kb-import%'`, [repoId, cur.sha]);
    if (imp.n > 0) {
      console.error(`refusing: ${repoName}@${refName0} points at imported commit ${cur.sha.slice(0,8)}. Ruby symbols regenerate (be-ast) and runtime `
                  + `calls/defects are carried forward for unchanged files, but features/owners, summaries and embeddings `
                  + `are not yet re-derived by this run (the reindex job will). Pass --force to move the ref anyway.`);
      process.exit(3);
    }
  }
  await upsertCommit(repoId, commit.sha, commit.committedAt, commit.subject, null);
  await touchRef(repoId, (asRef || ref).replace(/^origin\//, ""), commit.sha, tenant, env);

  const run = await one(
    `insert into ckg.index_runs (repo_id, commit_sha, ref_name, trigger) values ($1,$2,$3,$4) returning id`,
    [repoId, hex(commit.sha), ref, trigger],
  );

  // ---------- tree ----------
  const tree = (await listTree(repoDir, commit.sha))
    .filter((f) => !SECRET_PATHS.test(f.path))       // secrets never enter the graph
    .filter((f) => f.sizeBytes <= MAX_BLOB_BYTES);

  const relevant = tree.filter((f) => EXTRACTORS.some((e) => e.handles(f.path)));
  // Source text kept in the database: everything READ/GREP may need, not only what extractors parse.
  const sourceFiles = tree.filter((f) => SOURCE_DIRS.test(f.path) && SOURCE_EXT.test(f.path));
  const tracked = [...new Map([...relevant, ...sourceFiles].map((f) => [f.path, f])).values()];
  await registerBlobs(tracked.map((f) => ({ ...f, lang: path.extname(f.path).slice(1) })));
  await recordCommitFiles(repoId, commit.sha, tracked);
  const textStored = await storeBlobText(repoDir, sourceFiles);

  if (textStored) console.log(`source text stored for ${textStored} new blobs (${sourceFiles.length} files in tree)`);

  // ---------- PHASE 1: per-blob, cache-gated ----------
  let parsed = 0, cached = 0;
  for (const ex of EXTRACTORS) {
    const mine = relevant.filter((f) => ex.handles(f.path));
    const uniq = [...new Set(mine.map((f) => f.blobSha))];
    const hits = await cachedBlobs(uniq, ex.NAME, ex.VERSION);
    const misses = uniq.filter((s) => !hits.has(s));
    cached += hits.size;

    if (misses.length) {
      const contents = await readBlobs(repoDir, misses);
      const rows = [];
      const pathOf = (sha) => mine.find((f) => f.blobSha === sha)?.path ?? "";
      if (typeof ex.extractBatch === "function") {
        // One process for the whole batch (the Ruby AST extractor): thousands of files in seconds.
        const s = Date.now();
        const items = misses.filter((sha) => contents.get(sha)).map((sha) => ({ sha, buf: contents.get(sha), path: pathOf(sha) }));
        const res = ex.extractBatch(items);
        const per = items.length ? Math.round((Date.now() - s) / items.length) : 0;
        for (const it of items) {
          const r = res.get(it.sha);
          rows.push({ blobSha: it.sha, extractor: ex.NAME, version: ex.VERSION, facts: r.facts,
                      parseOk: !!r.ok, parseError: r.ok ? undefined : String(r.error).slice(0, 500), durationMs: per });
        }
      } else {
        for (const sha of misses) {
          const buf = contents.get(sha);
          if (!buf) continue;
          const s = Date.now();
          try {
            rows.push({ blobSha: sha, extractor: ex.NAME, version: ex.VERSION,
                        facts: ex.extract(buf, pathOf(sha)), parseOk: true, durationMs: Date.now() - s });
          } catch (err) {
            rows.push({ blobSha: sha, extractor: ex.NAME, version: ex.VERSION,
                        facts: {}, parseOk: false, parseError: String(err.message).slice(0, 500) });
          }
        }
      }
      await storeFacts(rows);
      parsed += rows.length;
    }
  }

  // ---------- doc chunks: content-addressed passages for semantic retrieval ----------
  {
    const docFiles = relevant.filter((f) => docs.handles(f.path));
    const shas = [...new Set(docFiles.map((f) => f.blobSha))];
    if (shas.length) {
      const have = new Set((await q(`select distinct encode(blob_sha,'hex') h from ckg.doc_chunks where blob_sha = any($1::bytea[])`, [shas.map(hex)])).map((r) => r.h));
      const todo = shas.filter((s) => !have.has(s));
      if (todo.length) {
        const facts = await loadFacts(todo, docs.NAME, docs.VERSION);
        let rows = [];
        for (const sha of todo) for (const c of facts.get(sha)?.chunks || []) rows.push([hex(sha), c.ordinal, c.heading_path, c.text, c.words]);
        for (let i = 0; i < rows.length; i += 300) {
          const b = rows.slice(i, i + 300);
          await q(`insert into ckg.doc_chunks (blob_sha, ordinal, heading_path, text, words)
                   select * from unnest($1::bytea[], $2::int[], $3::text[], $4::text[], $5::int[]) on conflict do nothing`,
                  [b.map(r => r[0]), b.map(r => r[1]), b.map(r => r[2]), b.map(r => r[3]), b.map(r => r[4])]);
        }
        console.log(`  doc chunks stored: ${rows.length} passages from ${todo.length} new document blobs (${docFiles.length} docs in tree)`);
      }
    }
  }

  // ---------- PHASE 2: per-commit resolution ----------
  // Always re-runs COMPLETELY. Not "changed files + one hop": that heuristic misses
  // two-hop invalidations, and a subtly stale edge is the one failure we cannot afford.
  // This is pure in-memory work, so exactness is free.
  const entities = new Map();          // fqn -> row (first writer wins)
  const edges = [];
  const ctx = { siteHash, normalizeEndpoint };
  const addEntity = (r) => { if (!entities.has(r.fqn)) entities.set(r.fqn, r); };

  const stats = {};
  for (const ex of EXTRACTORS) {
    if (typeof ex.resolve !== "function") continue;
    const mine = relevant.filter((f) => ex.handles(f.path));
    if (!mine.length) continue;
    const facts = await loadFacts(
      [...new Set(mine.map((f) => f.blobSha))], ex.NAME, ex.VERSION);
    let n = 0;
    for (const f of mine) {
      const got = facts.get(f.blobSha);
      if (!got) continue;
      const out = ex.resolve(got, f, ctx);
      out.entities.forEach(addEntity);
      edges.push(...out.edges);
      n += out.entities.length;
    }
    stats[ex.NAME] = n;
  }

  const unresolvedCount = [...entities.values()]
    .filter((e) => e.kind === "HTTP_CALL_SITE" && e.resolution === "AMBIGUOUS").length;
  const resolvedCount = [...entities.values()]
    .filter((e) => e.kind === "HTTP_CALL_SITE" && e.resolution !== "AMBIGUOUS").length;

  // ---------- load ----------
  const ent = [...entities.values()];
  for (let i = 0; i < ent.length; i += 500) {
    const b = ent.slice(i, i + 500);
    await q(
      `insert into ckg.entities
         (repo_id, commit_sha, kind, fqn, name, path, blob_sha, start_line, end_line,
          attrs, status, extractor, confidence, resolution)
       select u.repo_id, u.commit_sha, u.kind::ckg.entity_kind_t, u.fqn, u.name, u.path, u.blob_sha,
              u.start_line, u.end_line, u.attrs, u.status::ckg.epistemic_t, u.extractor,
              u.confidence, u.resolution::ckg.resolution_t
         from unnest($1::int[], $2::bytea[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::bytea[], $8::int[], $9::int[], $10::jsonb[], $11::text[], $12::text[],
                     $13::numeric[], $14::text[])
           as u(repo_id, commit_sha, kind, fqn, name, path, blob_sha, start_line, end_line,
                attrs, status, extractor, confidence, resolution)
       on conflict ((coalesce(repo_id,0)), (coalesce(commit_sha,'\\x00'::bytea)), kind, fqn) do update
         set end_line   = coalesce(ckg.entities.end_line,   excluded.end_line),
             start_line = coalesce(ckg.entities.start_line, excluded.start_line),
             blob_sha   = coalesce(ckg.entities.blob_sha,   excluded.blob_sha)`,
      [b.map((r) => (r.repoAgnostic ? null : repoId)),
       b.map((r) => (r.repoAgnostic ? null : hex(commit.sha))),
       b.map((r) => r.kind), b.map((r) => r.fqn), b.map((r) => r.name), b.map((r) => r.path),
       b.map((r) => (r.blobSha ? hex(r.blobSha) : null)),
       b.map((r) => r.startLine), b.map((r) => r.endLine),
       b.map((r) => JSON.stringify(r.attrs)), b.map((r) => r.status),
       b.map((r) => r.extractor), b.map((r) => r.confidence), b.map((r) => r.resolution)],
    );
  }

  const idRows = await q(
    `select id, fqn from ckg.entities
      where (repo_id = $1 or repo_id is null)
        and (commit_sha = $2 or commit_sha is null)`,
    [repoId, hex(commit.sha)],
  );
  const ids = new Map(idRows.map((r) => [r.fqn, r.id]));

  let edgeCount = 0;
  for (let i = 0; i < edges.length; i += 500) {
    const b = edges.slice(i, i + 500).filter((e) => ids.has(e.srcFqn) && ids.has(e.dstFqn));
    if (!b.length) continue;
    await q(
      `insert into ckg.edges
         (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, start_line,
          status, extractor, confidence, resolution)
       select $1, $2, u.kind::ckg.edge_kind_t, u.src, u.dst, u.site_hash, u.start_line,
              'OBSERVED'::ckg.epistemic_t, $3, u.confidence, u.resolution::ckg.resolution_t
         from unnest($4::text[], $5::bigint[], $6::bigint[], $7::bytea[], $8::int[],
                     $9::numeric[], $10::text[])
           as u(kind, src, dst, site_hash, start_line, confidence, resolution)
       on conflict do nothing`,
      [repoId, hex(commit.sha), 'multi',
       b.map((e) => e.kind), b.map((e) => ids.get(e.srcFqn)), b.map((e) => ids.get(e.dstFqn)),
       b.map((e) => e.siteHash), b.map((e) => e.startLine),
       b.map((e) => e.confidence), b.map((e) => e.resolution)],
    );
    edgeCount += b.length;
  }

  // uploaded documents are commit-less; re-link what they mention to this commit's nodes
  {
    const uploads = await q(`select id, attrs->'mentions' m from ckg.entities where kind='DOCUMENT' and commit_sha is null`);
    let n = 0; for (const u of uploads) n += await linkDocMentions(u.id, u.m || [], { repoId, commitSha: commit.sha });
    if (uploads.length) console.log(`  uploaded docs re-linked to this commit: ${n} mentions across ${uploads.length} documents`);
  }

  const inherited = await inheritObserved(repoId, commit.sha, cur?.sha);
  if (inherited.calls || inherited.dropped || inherited.defects)
    console.log(`  observed evidence carried from ${inherited.from}: ${inherited.calls} runtime calls, ${inherited.defects} defects (${inherited.defect_edges} links); ${inherited.dropped} runtime calls dropped (file changed)`);

  const ms = Date.now() - t0;
  await q(
    `update ckg.index_runs set files_in_tree=$2, blobs_total=$3, blobs_cached=$4,
       blobs_parsed=$5, entities_added=$6, edges_added=$7, duration_ms=$8,
       finished_at=now(), ok=true where id=$1`,
    [run.id, tree.length, cached + parsed, cached, parsed, ent.length, edgeCount, ms],
  );

  const pct = cached + parsed ? Math.round((cached / (cached + parsed)) * 100) : 0;
  console.log(
    `${repoName}@${ref} ${commit.sha.slice(0, 8)}\n` +
    `  tree ${tree.length} files, ${relevant.length} relevant\n` +
    `  blobs: ${parsed} parsed, ${cached} cached (${pct}% cache hit)\n` +
    `  by extractor: ${JSON.stringify(stats)}\n` +
    `  call sites: ${resolvedCount} resolved, ${unresolvedCount} UNRESOLVED\n` +
    `  loaded: ${ent.length} entities, ${edgeCount} edges in ${ms}ms`,
  );
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
