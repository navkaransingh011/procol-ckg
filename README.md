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

## Known gaps (current)

- `fe-http@0.1-regex` is still the regex extractor: 31.6% of dashboard call sites resolve to no endpoint (bare identifiers
  such as `url`), and template literals with nested ternaries mis-fold. The Babel-based `fe-http@1.0` remains the fix.
- Screens reach only the call sites inside their own view folder (22.5%); the Redux/api.js layer has no extractor yet.
- `procol-backend@main` is still the bootstrap-imported commit; every other backend branch is fully extractor-generated.
- Runtime `CALLS` evidence exists only from the import; the tracer harness that would refresh it on merge lives outside this repo.
- Push-model indexing (`src/index-service.mjs`, `deploy/ckg-push-tree.yml`) is built but has not indexed anything yet; the
  VM is still indexed by hand (docs/VM_UPDATE.md).
- FEATURE / PERSON / OWNS layers come from the import and are not re-derived by the indexer.

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

## Screens and clicks (fe-screens)

The layer a CS or PM question lives in: **which screen, which button, then what**. `src/extractors/fe-screens.mjs`
reads the React dashboards and produces, per commit:

- `UI_ROUTE` -- every screen from `src/app/routes/routeConfigs.js`: human name, route path, breadcrumb parents,
  search keywords, permission key, and the view folder that renders it (via `routeComponentsConfigs.js`).
- `UI_ACTION` -- the buttons, wizard steps, tabs, dialog titles and menu items inside a screen's view folder. Labels
  come from `src/translations/en.json` when the code uses `t("...")`, else from the literal JSX text.
- Edges: screen `DECLARES` action; screen `ISSUES_HTTP` call site (the `fe-http` call sites in its folder, so a click
  chains to the backend handler through `TARGETS`/`SERVES`); screen `NAVIGATES_TO` screen (from `history.push`, `to=`).

Measured on `procol-client-dashboard@main`: 123 screens, ~510 actions, 190 screen-to-screen links, e.g. Purchase Requisition -> Add Items,
Create PO, Reorder, Upload PRs, Purchase Cart; Awarding -> Create Proposal, Create PO, Create Contract; New Event ->
Select Template > Edit & Configure Event > Select Participants. Every role may see this layer (it is product language),
and the answer prompt asks for journeys as screens and clicks in order, then what the system does after each.

Journeys: `screenJourney` (src/tools.mjs) walks the `NAVIGATES_TO` graph from the first screen a question names to the
last, through the ones in between, and the answer uses that chain as its backbone (facts.screen_journey).
Known gaps: shared components are attributed through imports (two hops), so a few actions still have no screen; labels
built at runtime and navigations computed from data are invisible to a regex extractor; the click for a hop is the
button nearest the navigation call in the same file, so some hops have none.
Bump `VERSION` in the extractor to re-extract every file.

## Per-company configuration and ticket triage

`src/service/configs.mjs` resolves a customer's switches the way the platform does (`CustomConfiguration.cached_all_configs`:
default <- company master <- active override) and reports what agrees and differs across the companies a name matches
(names repeat; company ids are always shown). The planner calls it for "what is on/off for <customer>" (`config_for`) and
"which companies have X" (`companies_with`). `config/tenants.json` maps tenant words to company name patterns.

`src/service/triage.mjs` turns a pasted ticket into a card: customer, likely feature with confidence, governing switches with
the customer's effective values, guides, screens, owners, and a verdict (knowledge / config / engineering / more_info) the
model may pick only from the set the facts allow. Feedback lands in `ckg.triage_feedback`; calibrate with
`src/eval-triage.mjs`. See docs/TRIAGE.md.

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
| `LLM_REASONING_EFFORT` | `medium` in `.env` (planner stays `minimal`) | FAST_SMALLER is a reasoning model: it thinks silently before writing. Default effort took 33 s and could spend the whole `max_tokens` on thinking (empty answer). `low` answered the same request in 1.6 s. Reasoning tokens count against `max_tokens`, so budgets are sized for both. |
| `CKG_ANSWER_CACHE` | on | `ckg.answer_cache`: same question + style + commits replays in ~0 ms; `fresh: true` bypasses |

Every call streams, and the race is decided on the first **content** token: an empty completion
(reasoning ate the budget, or the gateway returned nothing) is a failed attempt and moves to the hedge.
The primary keeps priority until its deadline -- a healthy but slow-thinking primary never loses to a
faster-starting fallback, which matters for accuracy because the fallback is the weaker model. Typical now: a
repeat question 0 s; an identifier question ~1 s (guided) or ~25 s (plan, long technical answer);
a plain-English question 5–40 s; a congested spell costs one fallback latency per call, not minutes.

## Documents

Human-written docs are first-class graph nodes (`DOCUMENT`), chunked by heading and embedded for semantic
search, linked by `MENTIONS` edges to the code they name. Two sources, one pipeline:
- **in-repo docs** (README, `docs/**`, `ai-review/**`, service READMEs; changelogs skipped) via the `docs`
  extractor on every index run -- 63 documents, 1,475 passages today;
- **uploaded business documents** (PRDs, process docs, Notion exports; md/txt/docx/pdf/html) via
  `node --env-file=.env src/ingest-doc.mjs --file ... --tags ... --owner ...` -- commit-less, visible under
  every branch, re-linked to each new commit. Guide: [docs/DOCS_INGEST.md](docs/DOCS_INGEST.md).

Answers put the documented rule next to the code and say whether they agree, conflict, or the code side is
not visible; code wins on conflict and the answer says the doc may be stale.

## Live platform data (UAT mirror)

A read-only mirror of a few platform tables -- configs, templates, approval flows, flexi datasources -- lives in
schema `live` of our own Postgres, so answers can join **what the docs intend**, **what the code enforces**, and
**who has it switched on right now**. The model never touches UAT.

- `config/live_tables.json` is the allowlist: 10 tables, 93 columns. Only those columns are ever SELECTed
  (PII, secrets and filled-in commercial data are not; e.g. `procol_variables.value` is excluded).
- `src/sync-live.mjs` polls by `updated_at` every 60 s (first load ~1 min for ~300k rows, then ~1.5 s a pass)
  and reconciles ids every 30 min to see deletes. Runs as `deploy/ckg-live-sync.service` on the VM.
  Why polling: UAT is Postgres 14 with `wal_level=replica`; column-filtered logical replication needs 15+ and a
  restart. Polling reaches the same freshness within a minute and keeps sensitive columns from ever leaving.
- `query_live` is the only door: one allowlisted table, equality/substring filters, 200-row cap, exact total,
  `as_of` timestamp. The planner may chain `"company_id": "$companies.id"` to resolve a company by name first.
- **Configuration switches are found by meaning.** `live.config_index` embeds every switch's key + human name +
  description + default (502 today, refreshed by the poller, content-addressed). A question like "the lock so two
  flexi PO transactions cannot run together" resolves to `fx_response_sequence_advisory_lock_enabled` without
  anyone guessing the key; the planner receives these CANDIDATE CONFIGS before it plans. Set questions use JSON
  filters (`contains: {"defaults": {"value": true}}`), and the SQL step knows the live schema.
- **Every named live row is searchable by meaning.** `live.search_index` embeds templates, approval flows, flexi
  datasources and environment switches (27.8k rows, refreshed by the poller, content-addressed). With the config
  catalogue index this makes the live layer semantic like code and documents: all three layers are searched on every
  question, and their best matches reach the planner as candidates (CANDIDATE NODES / CONFIGS / LIVE ROWS).
- **Side facts are gated.** Switches and platform rows found by meaning reach the planner and the writer only when the
  question is about platform state (configuration words, a named customer, a template / approval flow / datasource) or
  the planner asks for live data -- and then only the top two that stand clear of the rest (`clearTop` in
  `src/service/confidence.mjs`: the runner-up joins within 0.05, a flat field is noise). A journey question no longer
  picks up "77 approval flows for create_trade" because a row sounded similar.
- **Calibrated confidence.** `assessConfidence` grades every answer from HOW its facts were found -- an exact name hit,
  a screen chain read in the order asked, a strong match by meaning clear of the runner-up, agreement between
  independent sources (code, documents, screens, live rows), and whether a state question was answered by data. The
  level and one reason go to the writer as `facts.confidence` (the prompt asserts on high, names the one weaker link on
  medium, states the missing piece on low), appear as a status line, and ride on the `done` event. The old
  "The closest thing I found is X, which may not be exactly what you asked about" opener is gone: a fuzzy name match
  is a retrieval detail, not a verdict, and a journey answer is about the journey.
- **A PRD can ship with a commit.** `ingest-doc.mjs --commit <sha> --repo <name> --files ...` (or `--repo-dir`) stores a
  document AT that commit with `DESCRIBES` edges to every node in the files it changed; in-repo `docs/prd/**` with YAML
  front matter does the same automatically on index. See docs/DOCS_INGEST.md and docs/PR_TEMPLATE_SNIPPET.md.
- **Lists are tables, shaped by the question.** Any live result with more than a few rows is sent to the UI as an exact
  table (all rows, sync time, filter, copy) and the prose only summarises it. Columns follow the wording: "what are the
  configs" shows key + name; add "status"/"on" for status, "describe" for descriptions, "details" for everything; the
  filter column itself is never shown. "all / every / list / how many" fetch the whole set (up to 500).
- Any `config_key` that comes back (candidate or row) is grepped in the backend, with context, so the answer
  can say where the code reads it and what it does there.
- `.env` needs `LIVE_DATABASE_URL` (a UAT connection; use `sslmode=no-verify`, the cert is self-signed) and
  optionally `LIVE_SYNC_INTERVAL_S`. **Ask for a read-only UAT role**: the `developer` login can write.

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
