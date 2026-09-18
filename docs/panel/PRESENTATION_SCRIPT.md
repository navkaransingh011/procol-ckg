# Panel presentation script — Procol Code Knowledge Graph

*Spoken script with a live demo. About 18 minutes plus questions. Written 18 September 2026 for Uday Kumar. Text in
quotes is what to say; text in brackets is what to do or point at. Cut the sections marked OPTIONAL if time is short.
Numbers are exact as of 17 September; the deck in this folder and `docs/PROJECT_CONTEXT.md` carry the same figures.*

---

## Before you walk in (10 minutes, once)

- Start the API (`npm run serve`) and the UI, sign in as the CS demo account in one browser tab and keep an
  engineer tab signed in as well. Have the Reliance ticket text (below) in a scratch note ready to paste.
- **Rehearse every demo question once, in order, within the hour before the talk.** Answers are cached per question,
  role and indexed commit, so the live run replays in under a second and cannot stall on the model gateway. Answers
  that showed live platform tables expire after 60 minutes, which is why it has to be the same hour.
- If the gateway is slow anyway, the status line shows the hedge kicking in ("writer model stalled; answered by …").
  Say so out loud: it is a feature, not a failure.
- Keep `docs/panel/Procol-Code-Graph-Panel.pptx` open on a second screen for the architecture slide; everything else
  is the product itself.

---

## 1. Open — the question nobody can answer quickly (1 min)

"Three questions get asked at Procol every single day. *Does Reliance have three-way match switched on?* *How does a
buyer get from an event to a purchase order?* *Which switch controls this behaviour?* Today the answer lives in one
engineer's head, in a document that may be stale, or in a database that only engineering can read. Every one of them
is a Slack thread and a context switch for an engineer."

"What I'm going to show you is a system that answers those questions from the code itself, from the documents we have
written, and from the live platform configuration — and shows you the evidence for every sentence. It cannot change
anything. It reads."

**Key point to land:** *the knowledge exists; it is just not reachable by the people who need it.*

---

## 2. What it is, in one breath (1 min)

"It is a Code Knowledge Graph with an AI agent on top. We index three repositories — the Rails backend, the React client
dashboard and the supplier bidding app — as a graph: which screen calls which endpoint, which handler, which methods,
which tables. Next to the code we put two more layers: the documents people wrote — PRDs, user guides, process docs —
and a read-only mirror of the UAT platform database: configuration switches, templates, approval flows, companies."

[Deck: the three-layer slide.]

"Then a language model writes over those facts, and only those facts. Nothing in an answer exists unless an extractor,
a document passage or a mirrored table row put it there."

**Key numbers, say two or three, not all:** 64,499 Ruby symbols · 7,483 routes · 4,316 frontend call sites · 825 tables ·
123 dashboard screens with 509 clicks · 174 documents · 746 configuration switches · 27,800 live rows searchable by
meaning · 10 branches across the three repositories.

---

## 3. Live demo — the customer-success view (6 min)

[Switch to the CS tab. Say the role out loud: "I am signed in as customer success. No code, no file paths, plain English."]

**Demo 1 — a journey.** Type:

> How does a buyer go from creating an event to generating a PO?

"Watch the top line while it works: one line, what it is doing right now, and a folded row saying how many facts it has
gathered. Nobody has to watch the machinery, but anyone can open it."

[When the answer lands, read the first two sentences aloud, then point at the numbered steps.]

"Two sentences that answer, then the steps once — screen, click, what happens. These steps are not the model's idea of a
procurement flow. They are read from the dashboard code: the routes, the buttons and the navigation calls between
screens. Beside it, the same steps drawn as a workflow; hover a step and the sentence that describes it lights up."

[Point at the receipt line: "confidence high", hops, sources, seconds. Point at "Helpful? Yes / No".]

"Confidence is not the model grading itself. It is computed from how the facts were found: an exact name, a screen
chain read in the order asked, how many independent sources agree. And every answer asks whether it helped; a thumbs
down becomes a test case."

**Demo 2 — a follow-up in the same chat.** Type:

> and where does approval come in?

"It rewrote my follow-up into a standalone question — you can see 'understood as' — using the earlier turn as context,
never as evidence."

**Demo 3 — a configuration switch.** Type:

> Which switch controls whether approval flows can be defined at company level?

"The key, its plain name, the default, how many companies have it on, and the table of who. The switch was found by
meaning and by the words in the question together; typing the exact key always wins."

**Demo 4 — a named customer.** Type:

> Is partial awarding enabled for Reliance?

"This is the answer CS actually needs: the effective value, resolved exactly the way the platform resolves it —
default, then the company's master row, then an active override — and where that value came from."

**Demo 5 — a template.** Type:

> Show me the RFQ Template - Materials used by GMMCO

"Rendered the way the dashboard lays it out, from the same widget definitions the platform uses: groups, columns, who
fills what. 4,792 of the 5,341 templates on UAT draw this way."

**Demo 6 — a pasted ticket.** Click the ticket mode and paste:

> Customer: Reliance Retail. Subject: Approvers not getting the PR approval request. The buyer team at Reliance Retail
> reported that when they submit a purchase request, the approvers do not receive the approval request notification.

"A triage card: the customer resolved, the likely feature, the switches that govern it with their live values for that
customer, the people who touched the code recently, and a verdict — here it asks for more information because Reliance
has zero approval flows for that key on UAT, which is itself the finding. Right or wrong buttons feed calibration."

**Key point to land:** *every one of those six answers came from the same graph; only the question changed.*

---

## 4. Live demo — the engineer view (2 min)

[Switch to the engineer tab. Ask the first question again.]

"Same question, different role. The first section is still plain words — a product manager can read it. Below it,
folded, is 'Technical detail': the evidence path hop by hop with file and line, how each hop is known — observed at
runtime, read from the route table, inferred from a name — what data it touches, known defects on the path, and what
the index could not tell us, with the exact file to open."

[Open "Show the evidence path" and switch Flow → Graph → List once.]

"Roles are not a prompt instruction. The service filters what is retrieved, what the model is shown, and every event
that streams to the browser. A CS answer contains zero file paths by construction; the same question for an engineer
named twelve."

**Demo 7 — honesty.** Type as CS:

> How does the mobile app handle offline bids?

"There is no mobile app. It says the topic is not covered and stops. The confidence is medium, not high, because the
code does have offline-negotiated bids and the system is honest about that too."

---

## 5. How it is built — the technical part (4 min)

[Deck: architecture slide. Speak to it; do not read it.]

**Indexing.**
"Indexing is content-addressed by git blob SHA. A file that did not change between commits is never parsed again, so
re-indexing a branch after a commit costs only the changed files. Entities and edges are stored per commit, and a view
maps each branch to its latest indexed commit — production, UAT and the Reliance tenant branches sit side by side.
Extractors: a Ruby AST parser, Rails routes and schema, external services, frontend HTTP calls, screens and clicks,
documents. Adding a branch is one line in a config file."

**Retrieval — three layers, searched by meaning and by words.**
"Everything is embedded locally with a small open model — no data leaves the machine for search. Vector search alone
turned out to be blunt: on our index a passage that answers the question scores 0.70 and one that merely mentions the
same nouns scores 0.69. So every search now fuses meaning with the question's words through Postgres full-text, and
document passages go through a second, local cross-encoder that reads question and passage together. On the awarding
question the three passages that answer it score 0.99, 0.96 and 0.87 and the rest fall to 0.4. An off-topic question
gets none."

**The LLM layer — two bounded calls, never a free agent.**
"This is the part I want to be precise about. The model is called exactly twice per answer and never chooses tools.

Call one is the **planner**: a small, fast model writes a short JSON plan — which names to look up, which lists, which
live queries, which customer's configuration — given candidates the graph already found by meaning, so it uses real
names and keys instead of guessing. Minimal reasoning budget; the plan is about 150 tokens.

The **service** then runs everything in the plan deterministically and in parallel: graph traces, complete lists,
endpoint families, documents, live rows, screen views and the navigation chain, source code at the indexed commit when
the question needs logic. Then it computes the confidence level from how those facts were found.

Call two is the **writer**: the model receives the facts as JSON and a prompt that says it knows nothing else. It writes
the answer. Then the service checks the output: any file path the model was not given is stripped before display, and
the workflow diagram's steps are validated against the facts or dropped.

The writer can be a different model from the planner — one line of configuration — so the fast model plans and a
stronger one writes if we choose. We measured that this week; more on it in a moment."

**Reliability.**
"The gateway we use stalls unpredictably — a reasoning model is silent while it thinks and then answers all at once.
So each model call is hedged: if the primary has produced nothing after six seconds a duplicate goes to the fallback
model, and whichever produces text first is used; a stalled primary opens a circuit breaker so the next call hedges
immediately. Answers are cached per question, role and indexed commit; live-data answers expire after an hour."

**Roles and safety.**
"Email and password with hashed credentials, HttpOnly cookie sessions, roles read on every request. The mirror is
read-only and column-allowlisted; there is no write path and there will not be one. The model's own SQL role cannot
read users, sessions, chats or logs."

**Key point to land:** *the model never decides what is true; it only decides how to say it.*

---

## 6. How we know it works — measurement (2 min)

"Until this week we judged answers by reading them. Now there is an evaluation set: 42 questions, 17 of them real ones
people asked, each with expectations a person can check — names that must appear, the confidence level, a numbered
step list, a table or template shown, file paths for engineers and none for CS — plus a model judge for what exact
checks cannot see: does it answer first, does it hedge, does it repeat itself, does it pad."

| Run | Pass | Median latency | Judge: answers · plain · no-repeat · relevant (of 5) |
|---|---|---|---|
| Before this week's retrieval work | 36 of 42 | 8 s | 4.36 · 4.69 · 4.36 · 3.86 |
| With reranker and hybrid search | 38 of 42 | 7.3 s | 4.60 · 4.81 · 4.40 · 3.98 |
| Same, stronger model as writer | 35 of 42 | 12.3 s | 4.45 · 4.83 · 4.67 · 4.57 |

"The stronger writer is plainer, never hedges and is far more relevant — but it stopped naming the thing it was
describing and added five seconds, so the fast model stays for now and the choice is recorded with the numbers. The
harness found five real bugs in one afternoon that reading answers never had. That, more than any single answer, is
what changed this week."

---

## 7. What does not exist yet — say it before they ask (1 min)

"Being honest about gaps is the point of the tool, so here are ours."

- "31.6 percent of frontend HTTP calls are still ambiguous to the regex extractor; a proper parser is not built."
- "The reranker is blind to configuration-switch text; switches rely on full-text and typed keys."
- "Runtime evidence is barely used: three observed defects. Running the tracer in CI would upgrade thousands of
  inferred calls to observed ones."
- "162 features, none linked to a document at the commit level; 16 business documents uploaded."
- "UAT only, no production mirror; no single sign-on, no admin screen; most eval expectations still need CS to confirm
  they are the right answers and not just today's."

---

## 8. What the graph already sees that nobody owns — OPTIONAL (2 min)

"Once the graph exists, it shows problems that nobody at Procol currently owns."

- "1,873 active company overrides that equal the master default — pure noise that hides the real configuration."
- "254 switches never overridden by any company; some are dead."
- "4,791 of 5,341 templates never used on UAT."
- "Blind toggling: when CS turns a switch on for a customer nobody can say what changes. The graph knows every place the
  code reads that key and which screens sit above it."
- "Customer blast radius per pull request: join a PR's changed files to the switches read there and the companies with
  them on, inside the review Ultron already runs."

"Two of these are on the roadmap: blind toggling, because it stops tickets before they exist, and blast radius, because
it puts the graph in front of every engineer every day."

---

## 9. Close (30 s)

"The idea is small: index what we already have, put intent, behaviour and state side by side, and let a model narrate
over verified facts with the evidence one click away. Everything you saw runs on one Postgres database and one Node
service, on a laptop. The next step is Slack, where these questions are already being asked. I'll take questions."

---

## Questions to expect, and the answers

- **"How do you know it isn't making things up?"** — The writer only sees facts as JSON and is told it knows nothing else;
  file paths it was not given are stripped after the fact; diagram steps are validated against the facts; every claim has
  an evidence chip; the eval set checks 42 questions with exact expectations. And when nothing is covered, it says so.
- **"What about security and customer data?"** — Read-only mirror of UAT, allowlisted columns, sensitive columns never
  leave UAT; roles enforced in the service, not the prompt; the model's SQL role cannot read people's chats or ratings;
  passwords hashed; ticket text masked before storage.
- **"What does it cost to run?"** — Embeddings and reranking are local open models; two small-model calls per answer;
  answers cached. The gateway bill is the only variable cost.
- **"How current is it?"** — Indexing is per commit and incremental; the mirror polls UAT roughly every minute; the
  branch list is a config file.
- **"Why not just point ChatGPT at the repo?"** — Because the questions are about behaviour across three repos plus live
  configuration plus documents, per role, with evidence. A chat over a repo has none of the four.
- **"What happens when the model gateway is down?"** — Hedging and failover cover a slow gateway; if both models fail
  the claims and evidence still stream from the graph, so the reader gets the path without prose.
- **"Can it change a setting for me?"** — No, and by design it never will. It reports the current state and says where a
  person would change it.
- **"How long did this take?"** — Say the real number.
