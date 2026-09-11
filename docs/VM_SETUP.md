# procol-ckg: loading the graph database on the VM

For whoever has shell access to the VM `procol-ckg` (asia-south1-c). You need two files/facts from Uday:
the dump `ckg.sql.gz` (~100 MB) and nothing else. You choose two passwords yourself.

Everything below is typed **on the VM**. Do not run any of it on a laptop.

## 1. Put the dump in your home folder
Either the browser SSH window's "Upload file" button, or from a machine with gcloud:
`gcloud compute scp ckg.sql.gz procol-ckg:~/ckg.sql.gz --zone asia-south1-c`.
Check it is there: `ls -lh ~/ckg.sql.gz`

## 2. Install Postgres 17 + pgvector
```
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17 postgresql-17-pgvector
```

## 3. Create users, database, extensions
Pick two passwords (owner and read-only). Keep them; they go into `.env` later.
```
sudo -u postgres psql
```
then inside psql:
```sql
create role ckg login password 'OWNER_PASSWORD';
create role ckg_reader login password 'READER_PASSWORD';
create database ckg owner ckg;
\c ckg
create extension if not exists pg_trgm;
create extension if not exists vector;
\q
```

## 4. Load the dump
```
gunzip -c ~/ckg.sql.gz | psql -v ON_ERROR_STOP=1 -U ckg -h localhost -d ckg
```
Takes 1-3 minutes. If it stops with `\restrict: invalid command`, the psql client is older than 17.6:
`sudo apt upgrade -y postgresql-client-17`, then drop and recreate the database (step 3 from `create database`) and load again.

## 5. Verify
```
psql -U ckg -h localhost -d ckg -Atc "select (select count(*) from ckg.entities), (select count(*) from ckg.edges), (select count(*) from ckg.summaries), (select count(*) from ckg.embeddings)"
```
Expected: `38354|165281|165|26487`. Send these four numbers back to Uday.

## 6. Re-apply the read-only role settings
Role settings (5 s timeout, read-only) are not part of a dump. Once the procol-ckg repo is cloned on the VM:
```
psql -U ckg -h localhost -d ckg -f sql/007_reader_role_and_views.sql
```
Then prove the guard works. This MUST fail with "permission denied":
```
psql "postgres://ckg_reader:READER_PASSWORD@localhost/ckg" -c "delete from ckg.entities where false"
```

## 7. Clean up
```
rm ~/ckg.sql.gz
```

## 8. What goes where on this VM (for the next steps)
| What | Where |
|---|---|
| Postgres data | `/var/lib/postgresql/17/main` (managed by Postgres, never edit) |
| procol-ckg code | `~/procol-ckg` (git clone, after the repo is pushed) |
| secrets | `~/procol-ckg/.env`, `chmod 600`. Lines: `CKG_DATABASE_URL=postgres://ckg:OWNER_PASSWORD@localhost/ckg`, `CKG_READER_URL=postgres://ckg_reader:READER_PASSWORD@localhost/ckg`, plus the project's Slingring key (not a personal one) |
| the three repos the agent reads code from | `/srv/repos/procol-backend`, `/srv/repos/procol-client-dashboard`, `/srv/repos/web-bidding` (git clone each) |
| embedding model cache | `~/.cache/procol-ckg-models` (downloads itself, 34 MB) |

From this point the VM's database is the source of truth. Never load a laptop dump over it again.

## 9. Running the UI + service on the VM (after the repo is cloned)
```
cd ~/procol-ckg && npm install && npm run fe:install && npm run fe:build
npm run serve            # UI and API on http://127.0.0.1:8787 ; put nginx/Caddy with TLS in front
```
