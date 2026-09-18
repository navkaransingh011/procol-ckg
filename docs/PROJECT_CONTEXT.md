# procol-ckg — project context, laid out as slides

*17 September 2026. Owner: Uday Kumar (uday.kumar@procol.in). Repo: github.com/navkaransingh011/procol-ckg.*

**How to use this file.** Each `## Slide N` below is one slide. "On the slide" is what goes on it, already cut to
three to five bullets. "Visual" says what to draw or screenshot. "Say" is the speaker note. Numbers are exact as of
17 September; keep them. If you need a longer, 28-slide version, `docs/panel/` already holds a generated deck
(`Procol-Code-Graph-Panel.pptx`), its content in `deck_content.json`, notes in `SPEAKER_NOTES.md`, and the
`build_deck.py` script that produces it; you can lift slides or figures from there.

**Suggested title for the deck:** *Procol Code Knowledge Graph — grounded answers about the product, for everyone.*

---

## Slide 1 — Title

**On the slide**
- Procol Code Knowledge Graph + AI agent
- Grounded answers about the product, for CS, product, QA and engineering
- Uday Kumar · September 2026

**Visual:** the product's own hero line, "Ask the knowledge base."

**Say:** This is a system that answers questions about how Procol actually works, from the code, the documents and
the live platform, and shows its evidence.

---

## Slide 2 — The problem

**On the slide**
- "Does Reliance have three-way match on?" "How does a buyer get from an event to a PO?" "Which switch controls this?"
- Today the answer lives in an engineer's head, a stale doc, or a database nobody outside engineering can read
- Every such question is a Slack thread and a context switch

**Visual:** three question bubbles pointing at one overloaded engineer.

**Say:** CS and product people ask these every day. Engineers answer them by reading code and querying UAT. The
knowledge exists; it is just not reachable by the people who need it.

---

## Slide 3 — The one idea

**On the slide**
- Index the code as a graph: who calls what, which screen hits which endpoint, which table it touches
- Put the written intent (PRDs, guides) and the live state (UAT configuration) next to it
- Let a model write over verified facts only, and cite every one
- Read-only by construction: it cannot change anything

**Visual:** three stacked layers labelled Code · Documents · Live platform, feeding one "Answer with evidence".

**Say:** The model never invents a fact. Everything it can say came from a deterministic extractor, a document
passage or a mirrored table row, and the UI can show the chip for it.

---

## Slide 4 — What it knows: three repositories

**On the slide**
- procol-backend (Rails): `main`, `main-uat-test`, `reliance-main`, `procol-ckg`
- procol-client-dashboard (React): `main`, `fe-main-uat-test`, `rfx-qa-main`, `reliance-main`, `ril-dev-final`
- web-bidding (React): `main`
- Branches are a config file (`config/refs.json`), not code; roles decide who may ask about which

**Visual:** a table of repo × branch × environment (prod / uat / qa / dev).

**Say:** Production, UAT and the Reliance tenant branches are all indexed side by side, so "on UAT" and "on
production" can be answered separately.

---

## Slide 5 — What it knows: documents and the live platform

**On the slide**
- Documents: in-repo design docs and READMEs, plus uploaded guides (Reliance Retail Procure360, AMNS eRFX,
  PR-based events). A PRD can be attached to the commit that shipped it
- Live: a polled, read-only mirror of 12 UAT tables — companies, master and custom configurations, procol variables,
  templates (with widget layouts), approval flows and conditions, flexi datasources and fields
- Documents are intent, code is behaviour, live rows are current state; the answer keeps the three apart

**Visual:** the three sources as columns with one example fact each.

**Say:** The mirror is allowlisted column by column and sensitive columns never leave UAT. There is no write path
at all, and there will not be one.

---

## Slide 6 — How indexing works

**On the slide**
- Content-addressed by git blob SHA: unchanged files are never re-parsed
- Entities and edges stored per commit; a view maps each branch to its latest indexed commit
- Extractors: Ruby AST, Rails routes and schema, external services, frontend HTTP calls, screens and clicks, documents
- Everything embedded locally (bge-small, 384 dimensions): code, passages, 502 switches, ~27.8k live rows

**Visual:** commit → changed blobs → extractors → entities/edges → `v_refs`, as a left-to-right pipeline.

**Say:** Re-indexing after a commit costs only the changed files. Vectors are reused across branches by text hash,
so five dashboard branches do not mean five times the embedding work.

---

## Slide 7 — How an answer is produced

**On the slide**
1. Sign in; the role is read on every request
2. Follow-ups are rewritten into a standalone question
3. A small model plans: lookups, lists, live queries, per-company configuration
4. Everything is retrieved in parallel: graph traces, documents, live rows, screens and journeys, source when needed
5. Confidence is computed from how the facts were found
6. The model writes over the facts; the UI streams tokens, evidence chips, tables, diagrams, templates

**Visual:** a horizontal pipeline with the six steps; highlight that the model only appears at steps 3 and 6.

**Say:** Two model calls, and neither can skip the graph. Typical latency on a laptop is 5 to 12 seconds.

---

## Slide 8 — Roles: the same question, a different answer

**On the slide**

| Role | Style | Code names | Endpoints | File paths | Quotes source | Branches |
|---|---|---|---|---|---|---|
| CS (default) | plain English | no | no | no | no | `main` |
| Product | plain English | no | no | no | no | `main` |
| QA | auto | yes | yes | no | no | all |
| Engineer | auto | yes | yes | yes | yes | all |

- Every role's answer is understood from the same facts, code included; the role decides what is SHOWN, enforced in
  the service on the facts' tags, the event stream and a scrub of the prose, never by asking the model to hide things

**Visual:** the table; optionally two screenshots of the same question as CS and as Engineer.

**Say:** A CS answer contains zero file paths by construction; the same question for an engineer named twelve.
Changing a role is a config edit and applies on the person's next request.

---

## Slide 9 — What people see: for CS and product

**On the slide**
- Plain-English answers: two or three sentences, then the steps once, then a line only if docs and code differ
- Screen journeys read from the dashboard code: 123 screens, 509 actions, 195 navigation links
- Templates rendered as the platform lays them out: 4,792 of 5,341 drawable
- Workflow diagram beside the answer, steps validated against the facts
- Saved chats with follow-up context; ticket triage from pasted text

**Visual:** one screenshot of a journey answer with its diagram, or the template preview.

**Say:** The journey steps are real clicks, not the model's guess: the extractor reads routes, buttons and
navigation calls from the React code.

---

## Slide 10 — What people see: for engineers and QA

**On the slide**
- Evidence path with file:line and how each hop is known (observed at runtime, exact, heuristic)
- Complete lists and endpoint families, source read at the indexed commit, repo-wide greps
- Where the code reads each configuration key, joined with who has it on
- Per-company effective configuration with the platform's own precedence: default ← company master ← override
- Who touched this area recently, from git history

**Visual:** a technical answer screenshot with evidence chips.

**Say:** The technical answer ends with "Not covered", the concrete gaps and the exact file to open, and a
confidence line copied from the retrieval signal, not self-graded.

---

## Slide 11 — Example: before and after (17 September)

**On the slide**
- Before: "The closest thing I found is the Awarding screen, which may not be exactly what you asked about…" then
  the flow twice, plus "77 approval flows for the create_trade key"
- After: "A buyer starts on the Events screen, clicks Create Event…" then four numbered steps, once. Confidence:
  high — screen chain read from the dashboard code in the order asked, confirmed by document passages
- Both problems were self-inflicted: a prompt rule keyed on a fuzzy *name* match, and six live rows attached to every question

**Visual:** two answer boxes side by side; strike through the hedge and the padding on the left.

**Say:** The fix was in three places: the prompt rules, gating the side channels to state questions only, and a
computed confidence level with one reason that the writer must follow.

---

## Slide 12 — Safety and honesty

**On the slide**
- Read-only mirror; the model's SQL role cannot read users, sessions, chats or logs (migration 019)
- Passwords are scrypt hashes; sessions are hashed; a brute-force brake after five failures
- Answers cite evidence or say "not covered"; file paths the model was not given are stripped before display
- The agent used for development never commits; a person does

**Visual:** a short checklist with ticks.

**Say:** Grounding is enforced twice: the facts are the only input, and the output is scrubbed of anything not in them.

---

## Slide 13 — Architecture and repo map

**On the slide**
- `config/` refs, roles, tenants, live tables · `sql/` 19 migrations · `fe/` React + Vite UI
- `src/extractors/` be-ast, be-routes, be-schema, be-external, fe-http, fe-screens, docs
- `src/tools.mjs` every read tool · `src/service/` server, agent, llm, policy, auth, chats, followup, flow,
  configs, triage, confidence
- `eval/` question sets and tickets · `test/` 74 tests, all passing

**Visual:** a folder tree or a boxes-and-arrows diagram: extractors → Postgres (pgvector) → service → UI.

**Say:** One Postgres database holds the graph, the embeddings, the documents, the live mirror and the app tables.
Nothing else to run except the poller and the Node service.

---

## Slide 14 — Running it and deploying it

**On the slide**
- Local: Node 26, Postgres with pgvector, `.env` → `npm run migrate` → `index:all` → `embed` → `sync:live:once`
  → `users -- seed-demo` → `serve` + `fe:dev`
- VM checklist pending: migrate (014–019), index the UAT and Reliance branches, `embed`, restart `ckg-live-sync`,
  seed accounts, `CKG_COOKIE_SECURE=1` behind TLS
- Docs: `docs/VM_SETUP.md`, `VM_UPDATE.md`, `CI_DEPLOY.md`, `AUTH.md`, `CHATS.md`, `TRIAGE.md`

**Visual:** two columns, Laptop and VM, each a short ordered list.

**Say:** Deployment is a pull, a migrate and a re-index; branches and roles are config, so adding one needs no code.

---

## Slide 15 — Known gaps, honestly

**On the slide**
- Evaluation: 42 graded questions (`eval/answers.json`) and 3 example tickets; most expectations still need a human to confirm
- Retrieval: bge-small scores are compressed (relevant 0.70–0.73, related 0.65–0.69); a local cross-encoder now reranks
  documents and full-text is fused with vectors, but the reranker is blind to configuration-switch text
- Coverage: 31.6 percent of frontend HTTP call sites still ambiguous (regex extractor); no Redux extractor, no runtime tracer
- Product: no Google SSO, admin UI, password reset, environment picker or shared chat links; UAT only, no production mirror

**Visual:** four rows with a red/amber marker each.

**Say:** These are the things that do not exist yet. The next slide is the order we would build them in.

---

## Slide 16 — Next steps, in priority order

**On the slide**
1. Grow and verify the evaluation set: confirm the 42 expectations with CS, add thumbs-down questions from `ckg.answer_feedback`
2. Reranker and full-text hybrid are in (documents); extend to switches with a domain-tuned reranker or better switch descriptions
3. Writer model: `LLM_WRITER_MODEL` exists; keep whichever the eval set scores higher against latency
4. Babel-based extractors to close the ambiguous call sites; more uploaded business documents
5. Production mirror, staleness alerts, SSO and admin UI

**Visual:** a numbered ladder; mark 1 as the gate for measuring the rest.

**Say:** Step 1 is what turns opinions into numbers. Everything after it gets measured on that set before it ships.

---

## Appendix A — Working rules

- The development agent never commits or pushes; Uday commits.
- The live mirror is read-only, no exceptions, even if a user asks the agent to change something.
- procol-client-dashboard and procol-backend are read, never modified, for this project.
- Never reuse keys or credentials that the platform or anyone else uses.
- Demo accounts: `cs.demo@`, `product.demo@`, `qa.demo@`, `engineer.demo@procol.in`; passwords are hashed and not
  recoverable — ask Uday, or seed your own with `npm run users -- seed-demo --password '<shared>'`.

## Appendix B — Glossary

- **Anchor** — the graph node a lookup starts from; "exact" when matched by name, "approximate" when by a similar token.
- **Ref** — an indexed git branch; `ckg.v_refs` maps it to its latest indexed commit.
- **Live** — the UAT mirror tables; "as of" is the last poll time.
- **Effective configuration** — the value the platform applies for a company after default, company master and override.
- **Screen journey** — the chain of dashboard screens and clicks between two screens, read from React routes and navigation calls.
- **Flow** — the validated step list drawn as a diagram beside an answer.
- **Triage** — the card for a pasted support ticket: customer, likely feature, governing switches, owners, verdict.
- **Confidence** — high / medium / low, computed from exact name hits, in-order screen chains, source agreement and
  semantic margin; the writer's tone follows it.
