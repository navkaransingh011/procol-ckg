# Adding business documents to the Code Graph

For whoever holds the PRDs, process docs, policies and Notion/Confluence pages. This is the whole context
an AI pair needs to add them so the agent can compare **what the documents say** with **what the code does**.

## What happens to a document

1. It is converted to Markdown (PDF, Word, HTML and plain text are accepted; Markdown is best).
2. It becomes a `DOCUMENT` node in the same Postgres database as the code graph. Uploaded documents are
   **commit-less**: they are visible under every branch, unlike in-repo docs which belong to a commit.
3. Its text is split into passages by heading (about 40-350 words each), and every passage gets an embedding
   for semantic search. Passages are content-addressed: re-adding an unchanged document costs nothing.
4. Every code identifier the document names -- `ApprovalFlow`, `approval_flows`, `Api::V1::TradeController#quote_details`,
   `fx_datasource_fields` -- becomes a `MENTIONS` edge to that node in the current `main` commits. When a branch
   moves to a new commit, the indexer re-links automatically.
5. When someone asks a question, the top matching passages are placed next to the code facts. The answer states
   the documented rule, states what the code shows, and says whether they **agree, conflict, or the code side is
   not visible**. Code wins over a document on conflict, and the answer says the doc may be stale.

Documents are `DOCUMENTED` evidence: intent, not proof. A doc naming a method is a mention, not a definition.

## Command

Run from the `procol-ckg` checkout, with `.env` pointing at the database (laptop or VM):

```bash
node --env-file=.env src/ingest-doc.mjs --file "Approval Policy v3.docx" \
  --title "Approval policy" \
  --tags approvals,workflow,finance \
  --owner "CS team" \
  --url "https://www.notion.so/procol/approval-policy"
```

| Flag | Required | Meaning |
|---|---|---|
| `--file` | yes | `.md .txt .docx .pdf .html` (Notion: Export -> Markdown; Google Docs: Download -> Markdown or .docx) |
| `--title` | no | defaults to the first `#` heading, else the file name. Becomes the node name users see. |
| `--tags` | recommended | comma-separated product areas: `approvals`, `flexi`, `bidding`, `onboarding`, `reporting`, `p2p`, `intake` |
| `--owner` | recommended | team or person who maintains the doc, so "who should I ask" can answer |
| `--url` | recommended | where the living copy is, so answers can point people back to it |
| `--slug` | no | stable id (`doc:upload/<slug>`); defaults to a slug of the title |
| `--replace` | when updating | overwrite an existing document with the same slug |

Also: `--list` shows everything uploaded; `--delete <slug>` removes one.

## What makes a document useful to the agent

- **Headings.** Chunking follows `#`, `##`, `###`. A 40-page doc with no headings becomes a few giant passages
  that match everything weakly. Add headings before ingesting if the source has none.
- **Real identifiers.** Where the doc talks about a screen, table, service or endpoint, use the actual name from
  the code (`approval_flow_conditions`, `WorkflowRuns::ApprovalService`, `/approval_workflow/approval_flows`).
  Each one becomes a link. Prose like "the approvals table" links to nothing.
- **One topic per document.** A "Finance processes" mega-doc should be split into approval policy, PO rules,
  invoice matching. Retrieval and tagging both get sharper.
- **Dates and status.** Put "Last reviewed: 2026-08" or "Status: proposed" near the top. Answers surface it
  when a doc and the code disagree.
- **Skip** meeting notes, chat exports, and changelogs. They add noise, not rules.

## Shipping a PRD with the code (commit / PR attached documents)

A document can belong to a specific commit, linked to **exactly the files that commit changed** (by diff, not by
guessing names). That is how the business logic of a feature travels with the code that implements it.

Three ways to get the PRD in, from most to least automatic:

1. **In the repo, with the feature.** Put it at `docs/prd/<feature>.md` in the same PR. The indexer picks it up on
   merge as a `prd` document of that commit and links every identifier it names. Optional YAML front matter ties it
   to a feature without guessing:
   ```
   ---
   title: Clara chatbot sessions
   feature: clara
   jira: PROC-4312
   owner: Product
   status: shipped
   tags: clara, sessions, auth
   prd: https://www.notion.so/procol/...
   ---
   ```
2. **In the PR description.** Use the block in `docs/PR_TEMPLATE_SNIPPET.md`. When the reindex job runs on merge it
   stores the PR's business-context section as a document of that commit and links it to the changed files
   (`DESCRIBES` edges). *(Automation lands with the CI reindex job; until then use option 3.)*
3. **By hand, after the fact:**
   ```
   node --env-file=.env src/ingest-doc.mjs --file prd.md --repo procol-backend --commit <sha> \
        --files app/models/session.rb,app/services/clara/auth.rb --pr 4312 --url <pr or prd url>
   ```
   `--files` is the list the commit changed; with a clone available use `--repo-dir ../procol-backend` instead and
   the list is read from git. The commit must already be indexed. Remove one with `--delete doc:commit/<sha12>/<slug>`.

What the agent then does: for a question about that feature it finds the PRD by meaning, sees which code it
describes, and answers "the rule says X, the code does Y, they agree / conflict", citing both. Verified on a sample
PRD attached to backend main: 96 nodes across 3 changed files linked, and the question "why must a Clara token never
log the user out, and does the code do that?" answered from PRD + code in 9 seconds.

## Batch

```bash
for f in ~/docs/business/*.md; do
  node --env-file=.env src/ingest-doc.mjs --file "$f" --tags "$(basename "$(dirname "$f")")" --owner "Product";
done
node --env-file=.env src/ingest-doc.mjs --list
```

## Check it worked

```bash
node --env-file=.env src/ingest-doc.mjs --list          # your doc, its chunk count, tags
```
Then ask the agent a question the document answers. The status stream shows
`reading N documentation passages: <your title>`, the trace shows a teal document node, and the answer
cites `uploads/<slug>.md § <heading>`.

## Sharing the result

The database, not the repo, holds the documents. The curated set lives in `db/business-docs/` (one Markdown
file per document plus `manifest.tsv`), and **the VM deploy ingests it on every release**
(`deploy/vm-deploy.sh` runs `db/business-docs/ingest.sh --replace --if-changed`; unchanged documents are
skipped). So the path to production is: add or edit the Markdown there, add a manifest row, merge to `main`.
Ad-hoc `ingest-doc.mjs` runs on the VM still work but are not tracked; prefer the folder.
`db/dump/ckg.sql.gz` is a bootstrap artifact for new environments; refresh it after a batch on a laptop
(`pg_dump -Fp --no-owner ckg | grep -v -E "^(CREATE EXTENSION|COMMENT ON EXTENSION|ALTER DEFAULT PRIVILEGES FOR ROLE) " | gzip -9`),
but the deploy never reloads it.

## Not yet built

Automatic pulls from Notion / Google Drive on a schedule, and an upload button in the UI. Both feed this same
pipeline; the command above is the contract they will call.
