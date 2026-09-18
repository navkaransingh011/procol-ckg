# Code Graph — frontend context for an AI pair (read this first)

You are working on the **frontend** (`fe/`) of Procol's Code Knowledge Graph agent. This file is the
whole context you need to work independently. Everything here is current as of 11 Sept 2026.

## 1. What this product is

A chat-style tool where anyone at Procol (customer success, product, engineers) asks a plain question
about the codebase and gets an answer **grounded in a verified code graph**: every claim carries the
file and line that proves it, and the answer says plainly when the graph cannot tell. Three repos are
indexed: `procol-backend` (Rails), `procol-client-dashboard` (React, buyer side), `web-bidding` (React,
supplier side). The graph lives in Postgres; a Node service answers questions; this `fe/` is the UI.

It is deliberately **not** inside the client dashboard. It is a standalone page, served by the same
Node process as the API in production (one origin, one port).

Status: works end to end on a laptop and on a GCP VM (`procol-ckg`, asia-south1-c). **Sign-in and roles
exist** (13 Sept 2026): `src/components/Login.jsx` is the door; the session is an HttpOnly cookie set by the
service, so the UI never holds a token. `useAgent().me` is `undefined` (checking), `null` (signed out) or
`{email, name, picture, role, label, via, can:{code_names,endpoints,paths,code_source,refs}}`. The role
decides the answer style and what the stream contains; the old Auto/Simple/Code toggle is gone. Use `me.can`
only to hide UI that would be empty (e.g. a trace for a role with no code nodes), never as a guard: the
server already filtered the events. Roles: `config/roles.json`; accounts: `npm run users -- add <email> <role>` / `seed-demo`.

## 2. Repo map (the parts that matter to you)

```
procol-ckg/
  fe/                    <- YOU ARE HERE. Vite + React 18, plain CSS, no UI library. ~530 lines.
    index.html           title, favicon (inline SVG data URI), color-scheme meta
    vite.config.js       dev server :5173, proxies /api -> http://127.0.0.1:8787 (env CKG_URL overrides)
    src/main.jsx         mounts <App/>
    src/App.jsx          layout: header (brand, Auto/Simple/Code toggle, branch picker, New question),
                         stage (hero, composer, suggestions | history chips, active turn), footer meta
    src/useAgent.js      ALL state: me, health, refs, selectedRef, chats[], chatId, turns[], active, asking; ask/stop/newChat/openChat.
                         Chats are saved on the server (/api/chats); a saved turn is replayed through applyEvent(), the same
                         reducer the live stream uses, so old answers redraw identically. URL /c/<chat id> mirrors the open chat.
                         Ticket triage: the composer's Ask/Ticket chip prefixes "triage:"; the server also detects pasted
                         complaints. The stream then carries a `triage` event (verdict knowledge|config|engineering|more_info,
                         confidence, customer, features_found, switches with the customer's effective values, guides, screens,
                         owners, checks, reply_draft, handoff, questions) rendered by TriageCard.jsx; 👍/👎 posts /api/feedback.
                         Events you will see beyond the answer stream: `chat` {id,title,is_new} first, and `rewrite`
                         {question, standalone} when a follow-up was understood via the conversation (shown as "understood as").
    src/api.js           getHealth, getRefs, getAuthConfig, getMe, login(email,password), logout, askStream
                         (fetch + ReadableStream over SSE, credentials: include; NOT EventSource)
    src/components/Login.jsx      the sign-in card: email + password (accounts are created by `npm run users -- add`;
                         Google sign-in is deferred until the VM has a hostname with TLS)
    src/components/IconField.jsx  procurement line icons (gavel, PO, truck, approval, rupee...) drifting in alternating
                         columns above the bar and dissolving at it; pure CSS motion, fades out when a turn is live.
                         App.jsx measures the bar and sets --bar-y so the fade lands exactly on it.
    src/components/Background.jsx the graph constellation canvas, now at .55 opacity under the icon field
    src/components/TemplatePreview.jsx  a template's layout (sheet / form / fields) drawn from mirror data, styled like the platform sheet
    src/components/Composer.jsx   the centered input pill: autosize, Enter=send, Shift+Enter=newline, stop button, progress sweep
    src/lib/usePanZoom.js         diagram pan/zoom: native non-passive wheel (ctrl/cmd+wheel and pinch zoom the diagram, never the page;
                                  plain wheel scrolls the page, shift+wheel pans), two-pointer pinch, zoomBy about a point
    src/components/Workflow.jsx   tools: full screen (portal to <body>, esc closes, plain wheel pans there), fit, +, -, double-click zoom
    src/components/Answer.jsx     one-line live timeline (expandable), prose + "Helpful? Yes / No", workflow aside, templates, tables,
                                  a technical answer is split at "2. Evidence path": section 1 (plain words) is the page, the rest folds
                                  under "Technical detail"; the receipt shows the confidence level as a coloured chip,
                                  the evidence path FOLDED under "Show the evidence path · N facts" for every role (opens itself only
                                  when no prose came back), "Where the trail stops", truncated note, error, receipt
    src/components/TracePath.jsx  the execution path drawn as coloured nodes joined by labelled connectors
    src/styles.css       design tokens (light + dark), every component style. Type: Geist (UI), Instrument Serif
                         (headline only, italic accent word), Geist Mono (code); loaded from Google Fonts in index.html
                         with system fallbacks. Keep the serif to the hero; everything else is the sans.
  src/service/server.mjs   the API + static server (serves fe/dist at / in production)
  src/service/agent.mjs    the answering logic (you will not edit this, but see §5 for what it emits)
  docs/API_CONTRACT.md     the original contract; §5 below is the up-to-date superset
  db/dump/ckg.sql.gz       a full database snapshot (59 MB) — lets you run everything locally
```

Node **>= 20.6** (`.nvmrc` says 26; run `nvm use` in the repo root). Root `package.json` has
`fe:install`, `fe:dev`, `fe:build`. `fe/dist` is gitignored — the VM builds it on deploy; never commit it.

## 3. Running the frontend

```bash
cd procol-ckg && nvm use
npm run fe:install            # once
npm run fe:dev                # http://localhost:5173, /api proxied to the service on 8787
npm run fe:build              # -> fe/dist (what production serves)
```

The FE is useless without a service to talk to. Three ways, pick one:

**A. Fully local, no key needed (recommended for FE work).** Postgres 17/18 with the `pgvector` and
`pg_trgm` extensions (macOS: `brew install postgresql@17 pgvector`). Then:
```bash
createdb ckg
psql ckg -c "create extension if not exists pg_trgm; create extension if not exists vector;"
gunzip -c db/dump/ckg.sql.gz | psql -v ON_ERROR_STOP=1 ckg
npm install
cat > .env <<ENV
CKG_DATABASE_URL=postgres://localhost/ckg
CKG_READER_URL=postgres://localhost/ckg
LLM_BASE_URL=mock
LLM_MODE=auto
EMBED_PROVIDER=local
EMBED_MODEL=Xenova/bge-small-en-v1.5
EMBED_DIMS=384
ENV
npm run serve                 # API on 127.0.0.1:8787; with LLM_BASE_URL=mock every answer is a fixed,
                              # real-graph trace with claims prefixed [MOCK] — every event type fires.
```
The dump loads as a normal user; if psql complains about a missing role `ckg_reader`, create it first:
`psql postgres -c "create role ckg_reader login password 'x'"`.

**B. Tunnel to the VM's real service** (needs gcloud + project access):
`gcloud compute ssh procol-ckg --zone asia-south1-c -- -N -L 8787:127.0.0.1:8787`, then `npm run fe:dev`.
Real model answers, real latency (see §6).

**C. Real model locally.** As A, but `LLM_BASE_URL=http://slingring.procol.tech/v1`,
`LLM_MODEL=FAST_SMALLER`, `LLM_API_KEY=sk-...` (an internal gateway; ask Uday for the project key;
reachable only from Procol's network). `.env` is gitignored — never commit it or paste keys anywhere.

## 4. The API (all relative to the same origin; in dev, Vite proxies `/api`)

`GET /api/health` -> `{ ok, entities, edges, refs, last_indexed, provider, auth_mode }`
  `auth_mode` is `"dev"` today; the footer shows an amber "dev auth" tag when so.
`GET /api/refs`   -> `{ refs: [{ ref, tenant, env, repo, indexed_at }] }`  (11 rows: 9 dashboard branches + backend main + web-bidding main)
`POST /api/ask`   body `{ question, refs?: ["main"], style?: "auto"|"simple"|"code", fresh?: boolean }` -> `text/event-stream`
  Answers are cached per (question, style, commits). A repeat replays in ~0 ms with a leading `status`
  "answered before (…); replaying from cache" and `done.cached === true`. Send `fresh: true` to bypass
  (an "Ask again" affordance is a good FE addition).

Read the stream with `fetch` + `ReadableStream` (as `api.js` does). Frames are `data: <json>\n\n`;
`: ping` keep-alive comments arrive every 15 s — ignore non-`data:` lines.

## 5. Every event the service emits (superset of docs/API_CONTRACT.md)

| type | payload | what it means / how the FE uses it |
|---|---|---|
| `intent` | `{ intent: "simple"\|"code", chosen: "auto"\|"simple"\|"code" }` | first event; which answer style the service resolved. Shown as a tag on the answer. |
| `status` | `{ text }` | progress lines: "planning (FAST_SMALLER) with 8 candidates by meaning", "looking up: A · B", "reading source at the indexed commit", "writing the plain-English answer". THIS is the progress signal (see §6). Hook keeps the last 6 in `turn.steps`. |
| `claim` | `{ id, text, kind, name, path, line, edge, depth, evidence_ids[], confidence }` | one node of the execution path. `kind` ∈ HTTP_CALL_SITE, HTTP_ENDPOINT, SERVER_ROUTE, HANDLER, SYMBOL, DB_TABLE, EXTERNAL_SERVICE, FEATURE, OBSERVED_DEFECT, DOCUMENT (a documentation passage that matched; `name` = doc title, `text` includes the section; teal node), … `edge` = edge kind that led here (TARGETS, SERVES, HANDLED_BY, DECLARES, CALLS, TRIGGERS_DEFECT), null for the anchor. Rendered by TracePath. |
| `evidence` | `{ id, repo, path, line, commit, ref, extractor }` | provenance for a claim (`evidence_ids` points here). `repo` decides node colour. HTTP_ENDPOINT claims have NO evidence/path on purpose (they are the contract between repos). |
| `unresolved` | `{ fqn, path, line, reason }` | a call site whose URL is built at runtime. **A normal outcome, not an error.** Rendered as "Where the trail stops". Never red. |
| `truncated` | `{ reason, at_depth }` | trace was bounded. Small note. |
| `context_paths` | `{ paths: string[] }` | every file path the model was shown. Diagnostic; FE ignores today. |
| `table` | `{ title, columns: string[], rows: string[][], total, complete, as_of, source }` | a COMPLETE result set from the live platform mirror (e.g. all 78 configs whose default is true). Render as a scrollable table under the answer with the title and "as of" time; the prose only summarises and says "see the table below". |
| `token` | `{ text }` | answer prose. NOTE: arrives as ONE or a few large chunks, not word by word (§6). The service appends a final footer token: `"\n\nRead from main: procol-backend@1089000b · procol-client-dashboard@4005ff00 · web-bidding@7325f662"`. |
| `error` | `{ code, message }` | `llm_failed`, `agent_failed`, `network` (set client-side). Facts already on screen stay valid. |
| `done` | `{ claim_count, evidence_count, unresolved_count, refs, ms, mode: "guided"\|"plan", provider, timings?: { plan_ms, retrieve_ms, answer_ms }, lookups?, matched?, lists?, families?, source_blocks?, greps?, candidates_by_meaning? }` | end of stream. Receipt row uses claim_count, evidence_count, unresolved_count, refs, ms. |

Rules the FE must honour (product, not style):
1. Never render a claim without a way to see its evidence (today: `title` tooltip on the node).
2. `unresolved` is never an error state.
3. Always show which refs were read (the service also appends it to the prose).
4. If the model fails, the claims/evidence/trace are still correct — show them.

## 6. Truths that shape the UI

- **Latency.** Fast path ("guided", exact identifier questions): ~1 s. Deep path ("plan", anything asked in
  plain words or asking why/how): 40–135 s. The model (`FAST_SMALLER`, ~7 words/s) returns its text in one
  burst at the end, so prose does NOT stream visibly. The `status` events ARE the progress — make the wait
  legible (a step timeline is a good FE task, see §8).
- **Answer styles.** `simple` = plain English for CS/PM, 4–8 sentences, optional trailing "In the code:" line.
  `code` = six numbered sections in markdown-ish text (1. Answer, 2. Evidence path, 3. Data & side effects,
  4. Known defects, 5. What the graph cannot tell you, 6. Confidence) with backticked identifiers.
  Today `Answer.jsx` renders prose as `white-space: pre-wrap` plain text — no markdown rendering yet.
- **Honesty signals the service adds itself** (do not strip): the refs footer; a `status` like
  "removed 1 file path the model guessed but was not given"; "primary model stalled; answered by fallback
  model …"; "(No prose available …)" fallback text.
- **Branch matters.** Tenants run different code; `refs` changes the answer. Default `main`.
- **Audience is everyone at Procol.** Default styling leans calm and non-technical; engineers switch to Code.

## 7. Design language (keep it)

Minimal, quiet, one accent. Centered composer as the hero at rest; after the first question it moves to the
top of a 680 px column and the answer flows beneath. Tokens in `styles.css` (`:root` light, dark via
`prefers-color-scheme`): ground `--bg`, `--surface`; ink `--ink/--ink-2/--ink-3`; hairlines `--line/--line-2`;
accent `--accent #5b5bd6` (frontend nodes, focus, active states); `--amber` (backend nodes, warnings);
`--danger` only for real errors. System font stack (no external fonts — the VM may be offline); monospace
for paths/identifiers. Radius 14/22 px. Motion is small and respects `prefers-reduced-motion`. Every control
has a visible `:focus-visible`. Node colours: indigo = frontend repo, amber = backend, dashed grey = the
HTTP endpoint contract between them — the colour change IS the repo boundary; teal = a documentation
passage (what people wrote), which is intent, not code.

## 8. Good next things to build (highest value first)

1. **Render the technical answer's markdown** (headings 1–6, backticks, bullets) instead of pre-wrap text.
   Keep it dependency-light (a tiny renderer or a pinned small lib). Backticked paths should look like code.
2. **Progress timeline** from `status` events while `asking`: a vertical list of steps with the current one
   pulsing; collapse to one line when done. This is the single biggest perceived-latency win.
3. **"Details" collapse in simple mode**: show the plain answer, tuck the trace path + receipt behind a
   disclosure so CS users are not confronted with hop diagrams.
4. **Evidence panel**: click a node -> side panel with repo, path:line, commit, extractor, resolution.
   Source lines would need a new endpoint (there is none for the UI yet; propose `GET /api/source?repo&path&from&to`
   — the service already has `readSource` internally; coordinate before assuming it).
5. **Local graph view**: an interactive 1–2-hop neighbourhood of the answer's claims (force layout on canvas).
   NOT a whole-graph view (38k nodes / 165k edges) — that is an unreadable hairball.
6. Conversation persistence in `localStorage` (turns + selected ref/style), copy-answer button, keyboard
   shortcuts (`/` focus, `Esc` stop), branch picker grouped by tenant/env, show `timings` from `done`, mobile pass.

Keep the bundle small (today ~150 KB JS). Ask before adding a dependency heavier than a few KB.

## 9. Conventions and guardrails

- Plain CSS with tokens; no Tailwind, no component library. React 18 function components + hooks. JS/JSX.
- All API calls relative (`/api/...`); `VITE_CKG_URL` may override the base — never hardcode a host or port.
- `fe/dist` is build output: never commit. `.env` is secret: never commit, never print.
- **Do not commit or push unless the human explicitly asks.** Show diffs; they commit.
- No lint/format tooling is configured in `fe/` yet; match the existing style (2-space, double quotes, semicolons).
- Test manually against mock mode (option A) for layout and against the VM (option B) for real timing.

## 10. People and decisions already made

- Uday Kumar — owner, product decisions, commits everything himself. Navkaran Singh — VM/infra.
- Decided: standalone FE (not a dashboard module); minimal centered chat; answer style auto-detected with a
  manual toggle; service serves the built UI; database is self-contained (no repo clones needed to answer).
- Open elsewhere (not FE): real login (Procol session verify endpoint), CI that re-indexes on merge,
  runtime-trace refresh, glossary of Procol terms for better anchoring.

## 11. Glossary

- **graph / CKG** — nodes (files, routes, handlers, methods, tables, endpoints, features) + edges (TARGETS, SERVES,
  HANDLED_BY, DECLARES, CALLS, IMPLEMENTS…) in Postgres, one set per indexed commit, append-only.
- **anchor** — the node a question starts from. **claim** — a node in the answer's path. **evidence** — its file:line.
- **HTTP_ENDPOINT** — the repo-agnostic contract node where a frontend call meets a backend route; has no file.
- **resolution** — how a fact is known: RUNTIME (observed in tests) > EXACT / FRAMEWORK_DUMP > HEURISTIC (name-based) > AMBIGUOUS (unresolvable).
- **guided / plan / auto** — fast deterministic path / deep planned path / the router that picks (default).
- **refs** — deployed branches (`main`, `reliance-main`, `ril-qa-final`, …); tenants run different code.
