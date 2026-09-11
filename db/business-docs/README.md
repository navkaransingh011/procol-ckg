# Business documents for the code graph

Curated Markdown versions of the process guides, training material and client user guides that are
ingested as commit-less `DOCUMENT` nodes (see `docs/DOCS_INGEST.md` for the pipeline). The database,
not this folder, is what the agent reads; this folder exists so the set is reproducible and reviewable.

- One file per document, `# Title` first, then a status line (`Status · Last reviewed · Audience · Source file`),
  then headed sections. Step-by-step guides (Scribe exports) are numbered lists under `##` sections.
- Word sources were converted with tables preserved (the stock docx path flattens tables). PDF and PPTX
  sources were normalised by hand; one duplicate PDF ("Revise Prices", two copies) was ingested once.
- `manifest.tsv` holds slug, title, tags and owner. `ingest.sh` replays the whole set; pass `--replace`
  to update documents that already exist. Editing a file and re-running with `--replace` is the update path.
- Tags follow the product areas in `docs/DOCS_INGEST.md` plus tenant names (`amns`, `reliance`, `mmg`).

The VM deploy (`deploy/vm-deploy.sh`) runs `ingest.sh --replace --if-changed` after migrations, so merging a
change here is enough to update production; unchanged documents are skipped. Refresh `db/dump/ckg.sql.gz`
too when you want new environments to start with the documents (recipe in `docs/DOCS_INGEST.md`).
