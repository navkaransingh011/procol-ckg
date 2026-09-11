# Load the fresh dump on the VM and run the service

The dump ships in the repo at `db/dump/ckg.sql.gz` (~59 MB). It already contains the code graph AND the
source text (so no repo clones are needed to answer questions). This REPLACES any older database on the VM.

Pick two passwords first (owner + read-only). All commands run ON THE VM.

## 1. Pull the repo (has the dump)
```
cd ~/procol-ckg && git pull
ls -lh db/dump/ckg.sql.gz          # ~59 MB
```

## 2. Fresh database + roles + extensions
If a `ckg` database already exists from the first load, drop it first:
```
sudo -u postgres psql -c "drop database if exists ckg;"
```
Then:
```
sudo -u postgres psql <<SQL
create role ckg        login password 'OWNER_PASSWORD';
create role ckg_reader login password 'READER_PASSWORD';
create database ckg owner ckg;
SQL
sudo -u postgres psql -d ckg -c "create extension if not exists pg_trgm;"
sudo -u postgres psql -d ckg -c "create extension if not exists vector;"
```
(If the roles already exist from the first attempt, skip the two `create role` lines.)

## 3. Load the dump (as the owner, no superuser needed)
```
gunzip -c ~/procol-ckg/db/dump/ckg.sql.gz | PGPASSWORD='OWNER_PASSWORD' psql -v ON_ERROR_STOP=1 -U ckg -h localhost -d ckg
```
Runs ~1 min. It should end with no ERROR lines.

## 4. Verify (send these numbers back)
```
PGPASSWORD='OWNER_PASSWORD' psql -U ckg -h localhost -d ckg -Atc "select
  (select count(*) from ckg.entities),
  (select count(*) from ckg.edges),
  (select count(*) from ckg.summaries),
  (select count(*) from ckg.embeddings),
  (select count(*) from ckg.blob_text),
  (select count(*) from ckg.doc_chunks)"
```
Expected: `38569|165681|165|26702|8895|1479`

## 5. Read-only role settings (not carried by a dump) + write test must fail
```
psql "postgres://ckg:OWNER_PASSWORD@localhost/ckg" -f ~/procol-ckg/sql/007_reader_role_and_views.sql
PGPASSWORD='READER_PASSWORD' psql -U ckg_reader -h localhost -d ckg -c "delete from ckg.entities where false"   # MUST say permission denied
```

## 6. Configure and run the service
```
cd ~/procol-ckg
npm install && npm run fe:install && npm run fe:build
cat > .env <<ENV
CKG_DATABASE_URL=postgres://ckg:OWNER_PASSWORD@localhost/ckg
CKG_READER_URL=postgres://ckg_reader:READER_PASSWORD@localhost/ckg
LLM_BASE_URL=http://slingring.procol.tech/v1
LLM_MODEL=FAST_SMALLER
LLM_API_KEY=sk-REPLACE_WITH_REAL_PROJECT_KEY
LLM_MODE=auto
EMBED_PROVIDER=local
EMBED_MODEL=Xenova/bge-small-en-v1.5
EMBED_DIMS=384
PORT=8787
CKG_HOST=127.0.0.1
ENV
chmod 600 .env
# IMPORTANT: replace sk-REPLACE_WITH_REAL_PROJECT_KEY above with the real Slingring key (it starts with sk-).
# The gateway rejects anything not starting with sk-. Health works without it, but questions will 401.
curl -s -m 10 http://slingring.procol.tech/v1/models -H "Authorization: Bearer $(grep LLM_API_KEY .env | cut -d= -f2)"   # must LIST MODELS, not an auth error
npm test    # on a service-only box the 4 route-expansion tests SKIP (they need a backend clone); the rest pass
npm run serve &  sleep 2;  curl -s http://127.0.0.1:8787/api/health;  kill %1
```
No repo clones are required for the service — source code is inside the database.
For permanent running (systemd) and reaching it from a laptop, see section 9.6–9.7 of VM_SETUP.md.
