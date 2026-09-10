# procol-ckg — Code Knowledge Graph

Deterministic facts about the Procol codebase, keyed to `(repo, commit)`, updated
incrementally on every merge to a deployed ref.

## The one idea

Git already content-addresses every file. `git ls-tree -r <commit>` gives a **blob SHA**
per path — a fingerprint of that file's exact bytes. That SHA is the cache key:

```
for each (path, blob_sha) in tree:
    blob_sha already in blob_facts?  -> reuse stored facts, DO NOT PARSE
    else                             -> parse once, store under that blob_sha
```

No diffing, no base commit, no mtimes. Renames are cache hits. A brand-new tenant branch
hits the cache on its first run.

## Two phases, and the split is the design

| Phase | Work | Cached? |
|---|---|---|
| **Per-blob** | Parse one file alone: symbols, call sites (unresolved), imports, route declarations, intra-function string folding | **Yes** — by content SHA |
| **Per-commit** | Resolve imports/callees across the tree into entities + edges | No — but it's pure in-memory work, so it re-runs **completely** every time |

Phase 2 re-runs in full rather than using a "changed files + one hop" heuristic. One hop
misses two-hop invalidations, and a subtly stale edge is the one failure this project
cannot afford. Full re-resolution is exact and costs milliseconds.

## Measured on procol-client-dashboard

| Ref | Parsed | Cached | Hit | Time |
|---|---|---|---|---|
| `main` (cold) | 1807 | 0 | 0% | 348ms |
| `main` (again) | 0 | 1807 | 100% | 126ms |
| `reliance-main` | 758 | 827 | 52% | 242ms |
| `ril-qa-final` | 67 | 1532 | 96% | 173ms |
| `jindal-sandbox` | 231 | 1679 | 88% | 198ms |

15,279 file instances across the 10 deployed refs collapse to 2,915 distinct blobs — **77% dedup**.

The incremental case, on a deployed ref: `ril-ppd-final` parses **31 of 1,599** files (98% cached) in 175ms.

## Rules

1. **Append-only.** Never UPDATE, never DELETE. A merge inserts rows under a new SHA;
   old rows stay. History is what remains.
2. **Query by commit, not by "latest".** With ~12 tenant refs, "current" is ambiguous —
   current *for whom?* Resolve ref -> commit via `ref_history`, then filter on that SHA.
   This is also why no deletion tombstone is needed: an entity absent from a commit's
   rows is absent, full stop. Use `entity_diff(repo, from_sha, to_sha)` to ask what changed.
3. **Deployed refs only** (`config/refs.json`). Not the other ~2,100 branches. A query
   about RIL prod must never surface a fact that exists only in someone's feature branch.
4. **The LLM never writes structural facts.** `ckg_reader` has no INSERT. Intent summaries
   are captions on a graph the model cannot edit.
5. **Secrets never enter the graph.** `.env*`, `*.pem`, `id_rsa*`, `*.key`, `*.p12` are
   dropped at the tree-walk stage, before any read.

## Cross-repo linking

Client and server never link to each other. Both attach to a shared, repo-agnostic
`HTTP_ENDPOINT` node:

```
frontend call site --TARGETS--> [ POST /purchase_requests/*/publish ] <--SERVES-- rails route
```

No resolver pass, no ingestion-order dependency, N x M becomes N + M. Two reports fall out
free: `TARGETS` with no `SERVES` (dead frontend calls), `SERVES` with no `TARGETS` (unused
endpoints). Generalizes unchanged to gRPC services, queue topics, and CI `uses:`.

## Extractor versioning

`blob_facts` is keyed `(blob_sha, extractor, extractor_version)`. Bumping a version
invalidates exactly that extractor and re-extracts on the next run. Nothing else moves.

Current: `fe-http@0.1-regex` — provisional, proves the pipeline. Replacing it with
`fe-http@1.0-babel` is a one-line version bump.

## Setup

```bash
createdb ckg
export CKG_DATABASE_URL=postgres://localhost/ckg
npm install && npm run migrate
node src/index-commit.mjs --repo-dir ../procol-client-dashboard --ref origin/main
```

**CI needs a hosted Postgres.** GitHub runners cannot reach a laptop. Provision it on
whichever cloud your infra team already operates before wiring `.github/workflows/ckg-index.yml`.

## Known gaps (v0.1)

- `fe-http@0.1-regex` mis-folds template literals containing a nested ternary. Real
  example found on `main`: `` `/companies/${id}/vendor_members${x ? `?a=${b}` : ""}` ``.
  This is precisely why the Babel version is required — it is a parsing problem, not a
  pattern problem.
- Bare-identifier call sites (~224 on `main`) are stored as `resolution='AMBIGUOUS'`,
  `pathTemplate=null`. Deliberate: they need scope-aware variable tracing.
- Backend extractors not yet written. `procol-backend` indexes zero entities today.
- Multi-line `promisifiedXHR(` calls are missed by the regex (~75 of 785).
