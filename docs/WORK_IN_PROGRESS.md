# Work in progress — answer accuracy track

*Started 17 September 2026. Pick-up notes for whoever continues (Uday or the development agent). Updated as work lands.*

## Goal

Three changes, in this order, so each is measured by the one before it:

1. **Evaluation set** — a fixed list of real questions with expectations, a harness that runs the real pipeline and
   grades answers (exact checks plus a judge model), a baseline score, and thumbs up/down on every answer to grow the set.
2. **Reranker + hybrid search** — a local cross-encoder reorders the top candidates from vector search fused with
   Postgres full-text, so relevant beats related; sharper confidence thresholds follow.
3. **Stronger writer model** — the final-answer call alone can use a different model (`LLM_WRITER_MODEL`); the planner
   stays on the fast model. Measured on the eval set for quality against latency.

## Status

- [x] 1a. Question set `eval/answers.json` — 42 questions (17 from `ckg.ask_log`, 25 constructed), most marked `verified: false`
      until a human confirms the expectation is the right answer, not just the current one
- [x] 1b. Harness `src/eval-answers.mjs` (`npm run eval:answers [--only ids] [--judge] [--label name] [--compare results.json]`),
      report under `eval/out/answers/<label>/` (REPORT.md, results.json, one .md per question with trace)
- [x] 1c. Baseline run `eval/out/answers/baseline/` (before reranker / hybrid / writer): **36/42 pass**, banned 1, confidence
      high 36 · medium 3 · low 1, median ≈ 8 s (one 20-minute gateway stall on a01 skews the mean), judge (of 5)
      answers 4.36 · plain 4.69 · no-repeat 4.36 · relevant 3.86. Three of the six failures were harness misfires on the
      technical format (arrows in the evidence path; the word "truncated"), fixed in the harness → adjusted baseline 39/42.
      Real misses: a34 and a42 (multi-word screen names never anchored, so the screens layer was not consulted), a37
      (a seven-hop journey grown from loosely similar screens made an off-topic question "high").
- [x] 1d. Thumbs up/down on answers: `sql/021_answer_feedback.sql`, `/api/feedback` with `kind: "answer"`, "Helpful? Yes / No"
      under every non-triage answer (`Answer.jsx`, `useAgent.rateAnswer`). Thumbs-down rows are eval candidates:
      `select question, confidence from ckg.answer_feedback where not helpful order by created_at desc;`
- [x] 2a. `src/service/rerank.mjs` — Transformers.js cross-encoder `Xenova/ms-marco-MiniLM-L-6-v2` (q8), `CKG_RERANK=0`
      to disable, `CKG_RERANK_MODEL` to swap; skips gracefully when the model cannot load; also `fuse()` (RRF)
- [x] 2b. Hybrid retrieval in `src/tools.mjs`: `lexicalQuery` (typed snake_case keys + OR-of-words tsquery), `fuseRanks`;
      `searchDocs` = meaning ∪ words → dedupe → rerank → `DOC_RERANK_FLOOR` 0.2; `searchConfigs` = key ∪ words ∪ meaning
      (typed key scores 1.0 and leads; top-2 word hits lifted to 0.62 so they clear the floor); `searchLive` = meaning ∪ words.
      `sql/020_fulltext.sql` adds generated tsvector columns + GIN indexes (doc_chunks, live.config_index, live.search_index)
- [x] 2c. Wired: `attachDocuments` passes `rerank` through; `confidence.mjs` strongDocs = rerank ≥ 0.5 when present else cosine ≥ 0.70.
      Fixes found by the baseline, also in this step: screens NAMED in the question always get their view (actions, where they
      lead, backend APIs) even outside journey questions; a journey needs a foothold (a named screen, or a UI_ROUTE match ≥ 0.6)
      and carries `named_in_question`; confidence no longer trusts "exact" hits whose names the planner copied from weak
      matches by meaning (the moon question had six exact hits on *_color methods) -- an exact hit counts when the person
      wrote the name, or the match by meaning is strong (≥ 0.72, clear of the runner-up); reranker warm-up at server start.
- [x] 2d. Eval run `eval/out/answers/rerank/` (reranker + hybrid + the fixes above, same FAST_SMALLER writer): **38/42 pass**
      (baseline 36, adjusted 39), banned 1, confidence high 36 · medium 3 · low 1, median 7.3 s, judge answers 4.60 · plain 4.81 ·
      no-repeat 4.40 · relevant 3.98 (all four up from 4.36 · 4.69 · 4.36 · 3.86). a42 (PR Details APIs) now passes through the
      named-screens route; a34 now answers from the graph's NAVIGATES_TO edges (its expectation was wrong and is corrected).
      Remaining: a08 omitted "on UAT" once (style variance), a33 used "appears to" (writer), a37 still "high" -- fixed after the
      run: screens found only by meaning no longer count as a confirming source, and the generic "how does the …" form draws a
      journey only when the question names a screen. Not re-run yet (each full run costs ~7 minutes of gateway time).
- [x] 3a. `LLM_WRITER_MODEL` (+ `LLM_WRITER_REASONING_EFFORT`) in `llm.mjs` (`chatStream`/`chat` take `model`; the hedge is
      whichever configured model the writer is not) and `agent.mjs` (`writeAnswer` only; planner, follow-up rewrite, flow
      block and triage stay on `LLM_MODEL`). Startup banner prints the writer. The gateway offers exactly two models:
      `FAST_SMALLER` (current) and `HACK26_GPT_5_6_LUNA`.
- [x] 3b. Eval run `eval/out/answers/writer-luna/` with `LLM_WRITER_MODEL=HACK26_GPT_5_6_LUNA` (same retrieval as the rerank run):
      **35/42 pass** (rerank run 38), banned 0 (from 1), median 12.3 s (from 7.3), avg 112 words (from 183), judge answers 4.45
      (from 4.60) · plain 4.83 · no-repeat 4.67 · relevant 4.57 (from 3.98). LUNA writes tighter, plainer, better-focused prose
      and never used a banned phrase -- but it stopped NAMING the subject ("It asks for..." instead of "The Vendor Onboarding -
      Non-Food Supplies template asks for...", failing a21, a30, a33, a42) and once denied content that was in the facts
      (a30: said the Reliance guide has no post-award section while six of its passages were attached). **Decision: keep
      `FAST_SMALLER` as the writer for now; `.env` unchanged.** A "name the subject in the first sentence" rule was added to
      both prompts afterwards (a21 passes with FAST_SMALLER on recheck); LUNA is worth re-measuring with it, and is the better
      choice if latency and naming are acceptable to CS -- that is Uday's call, made from the two reports.
- [x] Recheck after the last rule changes (`eval/out/answers/recheck/`, six questions): a08, a21, a34 pass; a37 is now medium
      (its expectation accepts low|medium: the code does have offline-negotiated bids); a30 missed once more (writer variance
      on the small model: it passed in the rerank run); a42 is a KNOWN GAP kept failing on purpose -- the screens extractor
      records no backend APIs for PR Details because its calls live in `redux/purchaseRequisition/api.js`.
- [x] Docs: README ("Measuring answers, reranking, and the writer model"), PROVIDERS.md (writer model, local reranker),
      API_CONTRACT.md (`/api/feedback` both shapes), `.env.example`, PROJECT_CONTEXT.md slides 15-16

## Decisions so far

- Order is eval → reranker → writer, because the eval set makes the other two provable.
- Nothing is committed by the agent; Uday commits. Live mirror stays read-only.

## 18 Sep — roles decide what is SHOWN, not what is understood

CS answers were thin because retrieval itself was role-gated: no source, no greps, code lookups dropped before the
writer saw them. Now every role's answer is understood from the same facts (`policy.mjs` `redactFacts` keeps code
lookups, source, greps and endpoint families; strips paths; tags `presentation` and `may_show_code/endpoints/paths/source`),
the plain prompt says "understand from the code, explain in product words", and the prose is scrubbed afterwards
(`codeNamesIn` collects the code names the facts held, `scrubCodeNames` replaces them and code shapes -- `A::B#c`,
`POST /x`, `/api/...`, directory paths -- and drops any "In the code" line). Status lines no longer list code names for
those roles ("looking up 8 names in the code"). EXTERNAL_SERVICE names (SAP, HubSpot) count as product words. Cache
version 6. Measured on the two questions that prompted it: both CS answers went from one or three sentences to six or
seven specific steps with zero code identifiers. Full eval not re-run yet (`--label roles-read-code`).

## Open items, in order

1. Have CS confirm the 42 expectations (`verified: false` entries) so the set measures truth, not current behaviour.
2. Re-measure LUNA as writer now that both prompts demand the subject's name: `LLM_WRITER_MODEL=HACK26_GPT_5_6_LUNA
   npm run eval:answers -- --judge --label writer-luna-2 --compare eval/out/answers/rerank/results.json`.
3. A full FAST_SMALLER re-run after the last rule changes (`--label rerank-2 --compare eval/out/answers/rerank/results.json`).
4. The reranker is blind to configuration-switch text (all ~0 for the flexi lock question); switches rely on full-text + typed
   keys. Options: a domain-tuned reranker, or richer switch descriptions in `live.config_index`.
5. Screens extractor: attribute Redux API modules (`redux/<feature>/api.js`) to the screens that import their slice, so
   `backend_apis` is not empty for PR Details and its kin (eval a42).
6. VM: `npm run migrate` now includes 020 (full-text columns) and 021 (answer feedback); the reranker weights download on
   first start (needs network once) or copy `~/.cache/procol-ckg-models` across.

## How to resume

Read this file, then `git status` in procol-ckg to see what is staged. Each step above names its files. Reports: the three
runs under `eval/out/answers/` (baseline, rerank, writer-luna) plus `recheck`; `REPORT.md` in each is the summary and
`<id>.md` holds every answer with its retrieval trace.
