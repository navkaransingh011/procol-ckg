// The blob-fact cache. This is the component that makes a merge cheap.
// Key is (content, extractor, extractor_version) -- never a path, never a commit.
import { q, hex } from "./db.mjs";

/** Which of these blobs do we already have facts for, at this extractor version? */
export async function cachedBlobs(blobShas, extractor, version) {
  if (blobShas.length === 0) return new Set();
  const rows = await q(
    `select encode(blob_sha,'hex') as sha from ckg.blob_facts
      where extractor = $1 and extractor_version = $2
        and blob_sha = any($3::bytea[])`,
    [extractor, version, blobShas.map(hex)],
  );
  return new Set(rows.map((r) => r.sha));
}

export async function registerBlobs(blobs) {
  if (blobs.length === 0) return;
  await q(
    `insert into ckg.blobs (blob_sha, size_bytes, lang)
     select * from unnest($1::bytea[], $2::int[], $3::text[])
     on conflict (blob_sha) do nothing`,
    [blobs.map((b) => hex(b.blobSha)), blobs.map((b) => b.sizeBytes), blobs.map((b) => b.lang ?? null)],
  );
}

export async function storeFacts(rows) {
  if (rows.length === 0) return;
  await q(
    `insert into ckg.blob_facts
       (blob_sha, extractor, extractor_version, facts, parse_ok, parse_error, duration_ms)
     select * from unnest($1::bytea[], $2::text[], $3::text[], $4::jsonb[],
                          $5::boolean[], $6::text[], $7::int[])
     on conflict (blob_sha, extractor, extractor_version) do nothing`,
    [
      rows.map((r) => hex(r.blobSha)),
      rows.map((r) => r.extractor),
      rows.map((r) => r.version),
      rows.map((r) => JSON.stringify(r.facts)),
      rows.map((r) => r.parseOk),
      rows.map((r) => r.parseError ?? null),
      rows.map((r) => r.durationMs ?? null),
    ],
  );
}

/** Load facts for a whole tree -- cache hits and fresh alike -- for the per-commit phase. */
export async function loadFacts(blobShas, extractor, version) {
  if (blobShas.length === 0) return new Map();
  const rows = await q(
    `select encode(blob_sha,'hex') as sha, facts from ckg.blob_facts
      where extractor = $1 and extractor_version = $2
        and blob_sha = any($3::bytea[])`,
    [extractor, version, blobShas.map(hex)],
  );
  return new Map(rows.map((r) => [r.sha, r.facts]));
}

export async function recordCommitFiles(repoId, sha, files) {
  if (files.length === 0) return;
  await q(
    `insert into ckg.commit_files (repo_id, commit_sha, path, blob_sha)
     select $1, $2, * from unnest($3::text[], $4::bytea[])
     on conflict (repo_id, commit_sha, path) do nothing`,
    [repoId, hex(sha), files.map((f) => f.path), files.map((f) => hex(f.blobSha))],
  );
}
