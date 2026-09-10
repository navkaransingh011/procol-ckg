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
import * as feHttp from "./extractors/fe-http.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const EXTRACTORS = [feHttp];
const SECRET_PATHS = /(^|\/)(\.env|\.env\..*|.*\.pem|id_rsa.*|.*\.key|.*\.p12)$/;
const MAX_BLOB_BYTES = 512 * 1024;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const siteHash = (p, line, col, kind) =>
  hex(createHash("sha1").update(`${p}:${line}:${col}:${kind}`).digest("hex"));

/** Query-string keys are evidence, never part of path identity. */
function normalizeEndpoint(raw) {
  if (!raw) return null;
  let p = raw.split("?")[0].trim();
  p = p.replace(/\(\.:format\)$/, "");            // Rails
  p = p.replace(/^https?:\/\/[^/]+/, "");         // absolute -> path
  p = p.replace(/\/+$/, "") || "/";
  p = p.replace(/:[A-Za-z_][\w]*/g, "*");         // :id  -> *
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/\/{2,}/g, "/");
}

async function main() {
  const repoDir = arg("repo-dir");
  const ref = arg("ref", "HEAD");
  const trigger = arg("trigger", "manual");
  if (!repoDir) throw new Error("--repo-dir is required");

  const t0 = Date.now();
  const repoName = path.basename(path.resolve(repoDir));
  const commit = await resolveRef(repoDir, ref);

  const repoId = await upsertRepo("procol", repoName, repoName.includes("backend") ? "monolith" : "spa");
  await upsertCommit(repoId, commit.sha, commit.committedAt, commit.subject, null);
  await touchRef(repoId, ref.replace(/^origin\//, ""), commit.sha, null, null);

  const run = await one(
    `insert into ckg.index_runs (repo_id, commit_sha, ref_name, trigger) values ($1,$2,$3,$4) returning id`,
    [repoId, hex(commit.sha), ref, trigger],
  );

  // ---------- tree ----------
  const tree = (await listTree(repoDir, commit.sha))
    .filter((f) => !SECRET_PATHS.test(f.path))       // secrets never enter the graph
    .filter((f) => f.sizeBytes <= MAX_BLOB_BYTES);

  const relevant = tree.filter((f) => EXTRACTORS.some((e) => e.handles(f.path)));
  await registerBlobs(relevant.map((f) => ({ ...f, lang: path.extname(f.path).slice(1) })));
  await recordCommitFiles(repoId, commit.sha, relevant);

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
      for (const sha of misses) {
        const buf = contents.get(sha);
        if (!buf) continue;
        const anyPath = mine.find((f) => f.blobSha === sha)?.path ?? "";
        const s = Date.now();
        try {
          rows.push({ blobSha: sha, extractor: ex.NAME, version: ex.VERSION,
                      facts: ex.extract(buf, anyPath), parseOk: true, durationMs: Date.now() - s });
        } catch (err) {
          rows.push({ blobSha: sha, extractor: ex.NAME, version: ex.VERSION,
                      facts: {}, parseOk: false, parseError: String(err.message).slice(0, 500) });
        }
      }
      await storeFacts(rows);
      parsed += rows.length;
    }
  }

  // ---------- PHASE 2: per-commit resolution ----------
  const factMap = await loadFacts(
    [...new Set(relevant.map((f) => f.blobSha))], feHttp.NAME, feHttp.VERSION);

  const entities = new Map();  // fqn -> row
  const edges = [];
  const addEntity = (r) => { if (!entities.has(r.fqn)) entities.set(r.fqn, r); return r.fqn; };

  let resolvedCount = 0, unresolvedCount = 0;
  for (const f of relevant) {
    const facts = factMap.get(f.blobSha);
    if (!facts?.callSites) continue;
    for (const cs of facts.callSites) {
      const resolved = cs.pathTemplate !== null;
      const fqn = `fe:${f.path}#L${cs.line}`;
      addEntity({
        fqn, kind: "HTTP_CALL_SITE", name: null, path: f.path, blobSha: f.blobSha,
        startLine: cs.line, endLine: cs.line,
        attrs: { method: cs.method, shape: cs.shape, raw: cs.raw,
                 pathTemplate: cs.pathTemplate },
        status: "OBSERVED", extractor: `${feHttp.NAME}@${feHttp.VERSION}`,
        confidence: resolved ? 0.95 : 0.4,
        resolution: resolved ? "EXACT" : "AMBIGUOUS",
      });

      if (resolved) {
        resolvedCount++;
        const norm = normalizeEndpoint(cs.pathTemplate);
        const epFqn = `${cs.method ?? "ANY"} ${norm}`;
        addEntity({
          fqn: epFqn, kind: "HTTP_ENDPOINT", name: norm, path: null, blobSha: null,
          startLine: null, endLine: null, attrs: { method: cs.method, normalized: norm },
          status: "OBSERVED", extractor: `${feHttp.NAME}@${feHttp.VERSION}`,
          confidence: 1.0, resolution: "EXACT", repoAgnostic: true,
        });
        edges.push({ kind: "TARGETS", srcFqn: fqn, dstFqn: epFqn,
                     siteHash: siteHash(f.path, cs.line, cs.col, "TARGETS"),
                     startLine: cs.line, confidence: 0.95, resolution: "EXACT" });
      } else {
        unresolvedCount++;
      }
    }
  }

  // ---------- load ----------
  const ent = [...entities.values()];
  for (let i = 0; i < ent.length; i += 500) {
    const b = ent.slice(i, i + 500);
    await q(
      `insert into ckg.entities
         (repo_id, commit_sha, kind, fqn, name, path, blob_sha, start_line, end_line,
          attrs, status, extractor, confidence, resolution)
       select $1, u.commit_sha, u.kind::ckg.entity_kind_t, u.fqn, u.name, u.path, u.blob_sha,
              u.start_line, u.end_line, u.attrs, u.status::ckg.epistemic_t, u.extractor,
              u.confidence, u.resolution::ckg.resolution_t
         from unnest($2::bytea[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bytea[],
                     $8::int[], $9::int[], $10::jsonb[], $11::text[], $12::text[],
                     $13::numeric[], $14::text[])
           as u(commit_sha, kind, fqn, name, path, blob_sha, start_line, end_line,
                attrs, status, extractor, confidence, resolution)
       on conflict do nothing`,
      [repoId,
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
      where repo_id = $1 and (commit_sha = $2 or commit_sha is null)`,
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
      [repoId, hex(commit.sha), `${feHttp.NAME}@${feHttp.VERSION}`,
       b.map((e) => e.kind), b.map((e) => ids.get(e.srcFqn)), b.map((e) => ids.get(e.dstFqn)),
       b.map((e) => e.siteHash), b.map((e) => e.startLine),
       b.map((e) => e.confidence), b.map((e) => e.resolution)],
    );
    edgeCount += b.length;
  }

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
    `  call sites: ${resolvedCount} resolved, ${unresolvedCount} UNRESOLVED\n` +
    `  loaded: ${ent.length} entities, ${edgeCount} edges in ${ms}ms`,
  );
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
