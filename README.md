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

## Semantic anchoring (pilot)

`ckg.embeddings` holds one vector per entity "card" (name, humanized words, path, routes/columns/members, feature summary).
Vectors are used only to pick a starting node when the question has no identifier in it; facts never come from vectors.

```bash
npm run embed                 # embed all cards on main (content-addressed: unchanged cards are skipped)
npm run eval:anchor           # name-based vs semantic anchoring on eval/questions_anchor.json
node --env-file=.env src/eval-planner-anchor.mjs   # planner vs semantic vs union on the plain questions
```

Provider is `EMBED_PROVIDER=local` (`@huggingface/transformers`, model cached in `~/.cache/procol-ckg-models`) or
`openai` (any `/v1/embeddings`). Pilot result: name anchor 8/8 on named questions, 0/8 on plain ones; semantic 5/8
plain in top-10; planner + semantic union 7/8. See `eval/out/anchor_pilot_*.md`.

## Frontend (`fe/`)

A standalone, minimal chat UI (Vite + React, no UI library). Not part of the client dashboard.

```bash
npm run fe:install        # once
npm run fe:dev            # http://localhost:5173, proxies /api to the service on 8787
npm run fe:build          # writes fe/dist; the service then serves it at http://127.0.0.1:8787/
```

In production the service serves `fe/dist` itself, so UI and API are one process and one origin.
Set `CKG_HOST=0.0.0.0` only if no reverse proxy sits in front; the default binds to localhost.

## Deploying

Merging to `main` auto-deploys to the VM: `.github/workflows/deploy-vm.yml` connects over an IAP
tunnel (Workload Identity Federation, no stored keys) and runs `deploy/vm-deploy.sh` -- pull, build,
migrate, restart, health-check, roll back on failure. Setup and the exact auth required are in
[docs/CI_DEPLOY.md](docs/CI_DEPLOY.md). The bootstrap dump is never re-loaded; schema changes travel
as idempotent `sql/0NN_*.sql` migrations.

## Ruby symbols (be-ast)

`src/extractors/be-ast.{mjs,rb}` regenerates every backend SYMBOL node (classes, modules, instance and
class methods) from source, replacing the one-off Ruby AST dump the graph was bootstrapped from. So a
re-index of any backend commit produces the symbols itself; nothing depends on the dump any more.

- Stdlib `RubyVM::AbstractSyntaxTree`, no gems. One Ruby process per run parses ~4,000 files in under 2 s.
- Identities match the import exactly (`be:sym:Class`, `Class#method`, `Class.method`), and the
  class->method DECLARES hash is the same, so wiring it into the pinned commit added zero duplicates.
- Files the running Ruby cannot parse (Ruby 3 syntax on Ruby 2.6) fall back to a line scanner and are
  marked HEURISTIC. Use Ruby 3.x on the indexing host to avoid the fallback entirely.
- Controllers bridge to their HANDLER node (`api/v1/trade#quote_details` -> `Api::V1::TradeController#quote_details`).
- Static `Const.method` CALLS edges exist behind `CKG_STATIC_CALLS=1` and are off by default: runtime
  (observed) CALLS edges are the trustworthy ones.

Parity against the bootstrap dump (`node src/dev/ast-parity.mjs`): 98.4% of its 23,490 symbols, and the
gap is mostly the dump's own errors -- methods inside `class << self` labelled as instance methods (we
emit the correct class-method form) and ownerless top-level script methods (dropped; they collide by name).
Not covered yet: the 26 `mcp_tool` definitions, which are not Ruby symbols and need their own extractor.

## Observed evidence across commits

Runtime CALLS edges and OBSERVED_DEFECT nodes come from test-run tracing, which does not re-run on every
merge. When a branch moves to a new commit, the indexer **carries each such edge forward if both endpoint
symbols still exist and their files have identical content** (same blob hash), tagging it
`attrs.observed_at = <commit it was captured on>`. Edges touching a changed file are dropped: the body
changed, the observation may no longer hold. Traces expose `observed_at`, and answers say "observed in
tests at <commit>; code unchanged since". Simulated on a 185-file diff: 1,494 carried, 2,950 dropped for
changed files, 139 for removed symbols, 0 for any other reason. A typical merge keeps ~99%.

Fresh evidence for changed code still needs the tracing harness to run on merge (not in this repo yet).

## Latency

Measured: our pipeline is fast (planning ~1–3 s, retrieval ~0.2 s, writing 3–25 s depending on answer
length). The minutes users saw came from the model gateway, which answers the same one-word request in
0.1 s or hangs it for 2+ minutes, unpredictably. Defences, all in `src/service/llm.mjs`:

| Knob | Default | Effect |
|---|---|---|
| `LLM_HEDGE_MS` | 6 s | with no first token by then, launch a duplicate to the **fallback** model in the background |
| `LLM_FIRST_BYTE_MS` | 12 s | the primary keeps priority until then; only if it produces nothing (or errors) is the warm hedge used. Reasoning models are silent while thinking, so "first byte" = "done thinking" -- a healthy primary must never lose to a faster-starting fallback |
| `LLM_FALLBACK_MODEL` | `HACK26_GPT_5_6_LUNA` in `.env` | used for hedges and later attempts; the answer says when it was used (planner and writer separately) |
| `LLM_FALLBACK_FIRST_BYTE_MS` / `LLM_FALLBACK_REASONING_EFFORT` / `LLM_FALLBACK_MAX_TOKENS` | 30 s / `minimal` / up to 8000 | LUNA reasons at length and its reasoning tokens count against `max_tokens`: at 1500 it returned no text in 6 of 8 probes. The fallback gets a patient deadline, minimal effort, and 3x the primary's budget |
| `LLM_BREAKER_MS` | 3 min | after one primary stall, hedge immediately (t=0) for this long; auto-recovers |
| `LLM_TIMEOUT_MS` / `LLM_ATTEMPTS` | 90 s / 3 | hard cap per attempt / attempts in total |
| `LLM_REASONING_EFFORT` | `low` in `.env` | FAST_SMALLER is a reasoning model: it thinks silently before writing. Default effort took 33 s and could spend the whole `max_tokens` on thinking (empty answer). `low` answered the same request in 1.6 s. Reasoning tokens count against `max_tokens`, so budgets are sized for both. |
| `CKG_ANSWER_CACHE` | on | `ckg.answer_cache`: same question + style + commits replays in ~0 ms; `fresh: true` bypasses |

Every call streams, and the race is decided on the first **content** token: an empty completion
(reasoning ate the budget, or the gateway returned nothing) is a failed attempt and moves to the hedge.
The primary keeps priority until its deadline -- a healthy but slow-thinking primary never loses to a
faster-starting fallback, which matters for accuracy because the fallback is the weaker model. Typical now: a
repeat question 0 s; an identifier question ~1 s (guided) or ~25 s (plan, long technical answer);
a plain-English question 5–40 s; a congested spell costs one fallback latency per call, not minutes.

## Self-contained database

The indexer stores the text of every source file it sees (`ckg.blob_text`, content-addressed), so READ
and GREP run as database queries. The answering service needs **no git clones** -- restore the dump and it
works. Only the indexer needs a clone, and only of the commit being indexed. (~21 MB of text for the three repos.)

## Answer style (`style` per request, or the UI toggle)

Every `/api/ask` accepts `style`: `auto` (default), `simple`, or `code`. `auto` reads the question:
plain wording ("how does X work", "what can a supplier do") gets a warm, non-technical explanation; an
identifier or a code verb ("who calls X", "columns of the bids table") gets the engineer answer with
file:line evidence. The UI has an Auto / Simple / Code toggle that forces it.

## Answer modes (`LLM_MODE`)

| Mode | What happens | Use |
|---|---|---|
| `auto` (default) | Exact identifier + simple trace question → `guided`. Anything in plain words, or asking why/how/what-if → `plan`. | production |
| `guided` | Service picks one anchor by name, traces, model narrates. Sub-second. Fails on plain-English questions. | fast path only |
| `plan` | Model plans (with candidates found by meaning), service runs lookups/lists/SQL/families in parallel, reads source when needed, model writes. Bounded facts payload with one retry. | deep answers |
| `sql` | Model writes read-only SQL itself. Expert mode. | engineers |
