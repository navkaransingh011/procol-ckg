# Bringing the VM up to date: code + documents + live platform data

Do these in order on the VM after Uday pushes. About 15 minutes. Result: the agent answers from all three
sources -- the code graph, the documentation, and the live UAT configuration mirror -- read-only.

Expected numbers after step 3: `38569|165681|165|26702|8895|1479` and 53 documents.

## 0. On the laptop (Uday): push
Everything is in the repo, including the refreshed dump `db/dump/ckg.sql.gz` (64 MB, documents included,
no mirror data -- the VM mirrors UAT itself). `.env` is gitignored and must not be pushed.

## 1. Pull and install
```
cd ~/procol-ckg && git pull
npm install                       # new: pdf-parse, mammoth (document ingestion)
npm run fe:install && npm run fe:build
```

## 2. Update `.env` (add these lines; keep the existing ones)
```
LLM_FALLBACK_MODEL=HACK26_GPT_5_6_LUNA
LLM_REASONING_EFFORT=medium
LIVE_DATABASE_URL=postgresql://<uat_user>:<uat_password>@35.200.252.20:5432/agribid-uat-latest?sslmode=no-verify
LIVE_SYNC_INTERVAL_S=60
```
`LLM_FALLBACK_MODEL` / `LLM_REASONING_EFFORT` are the latency fixes (fallback when the primary stalls; low
hidden reasoning). `LIVE_DATABASE_URL` is the UAT connection Uday has; ask the DBA for a SELECT-only role
(`ckg_readonly`) rather than the shared `developer` login. `chmod 600 .env` afterwards.

Check the VM can reach UAT at all:
```
nc -vz 35.200.252.20 5432
```

## 3. Reload the database from the fresh dump
The VM's current database predates the documents. Reloading is the clean way; nothing indexed only on the VM is lost
(there is nothing yet).
```
sudo systemctl stop ckg 2>/dev/null; sudo systemctl stop ckg-live-sync 2>/dev/null
sudo -u postgres psql -c "drop database if exists ckg;"
sudo -u postgres psql -c "create database ckg owner ckg;"
sudo -u postgres psql -d ckg -c "create extension if not exists pg_trgm; create extension if not exists vector;"
gunzip -c ~/procol-ckg/db/dump/ckg.sql.gz | PGPASSWORD='OWNER_PASSWORD' psql -v ON_ERROR_STOP=1 -U ckg -h localhost -d ckg
PGPASSWORD='OWNER_PASSWORD' psql -U ckg -h localhost -d ckg -Atc "select (select count(*) from ckg.entities),(select count(*) from ckg.edges),(select count(*) from ckg.summaries),(select count(*) from ckg.embeddings),(select count(*) from ckg.blob_text),(select count(*) from ckg.doc_chunks)"
```
Expected: `38569|165681|165|26702|8895|1479`.

## 4. Migrations not carried by the dump (role settings + the live schema)
```
cd ~/procol-ckg
psql "postgres://ckg:OWNER_PASSWORD@localhost/ckg" -f sql/007_reader_role_and_views.sql
psql "postgres://ckg:OWNER_PASSWORD@localhost/ckg" -f sql/012_live.sql
```

## 5. First load of the live mirror, then run the poller as a service
```
npm run sync:live:once            # ~1 min: ~300k rows across 10 allowlisted tables, SELECT-only, read-only session
sudo cp deploy/ckg-live-sync.service /etc/systemd/system/
sudo sed -i "s/__USER__/$USER/g; s#__HOME__#$HOME#g" /etc/systemd/system/ckg-live-sync.service
sudo systemctl daemon-reload && sudo systemctl enable --now ckg-live-sync
journalctl -u ckg-live-sync -n 2 --no-pager          # a "live sync ...ms" line every 60 s
```

## 6. Start (or restart) the agent
```
sudo systemctl restart ckg 2>/dev/null || npm run serve &
curl -s http://127.0.0.1:8787/api/health
npm test                                              # 44 tests; route-expansion ones skip without a clone
```

## 7. Prove all three sources in one answer
```
curl -s -N -X POST http://127.0.0.1:8787/api/ask -H "content-type: application/json" \
  -d '{"question":"which approval flows does Reliance have configured on UAT, and what does the code do with the trigger rule?","style":"simple"}' | grep -E '"status"|"token"' | head -20
```
You should see status lines `live platform data: companies ...`, `live platform data: approval_flows ...`,
`reading N documentation passages: ...`, then an answer that separates the documented rule, the code, and the
live state "as of <time> on UAT".

And prove it is read-only -- ask it to change something:
```
curl -s -N -X POST http://127.0.0.1:8787/api/ask -H "content-type: application/json" \
  -d '{"question":"disable the PO approval flow for all companies","style":"simple"}' | grep '"token"'
```
It must say it cannot, report the current state, and point to where a person would do it.

## 8. Adding business documents (the CS/PM docs)
`docs/DOCS_INGEST.md`. One command per document; they land in the same database and are linked to code
automatically. In-repo docs are already in the dump.

## What each piece is, in one line
- `db/dump/ckg.sql.gz` -- code graph + in-repo documents + embeddings, from the laptop.
- `sql/012_live.sql` + `src/sync-live.mjs` -- the read-only UAT mirror (allowlist in `config/live_tables.json`).
- `deploy/ckg-live-sync.service` -- keeps the mirror fresh every 60 s.
- `LLM_FALLBACK_MODEL`, `LLM_REASONING_EFFORT` -- the two lines that took answers from minutes to seconds.
