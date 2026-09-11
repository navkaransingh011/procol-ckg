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

## 9. Running the service + UI on the VM

Pull the latest code first (the laptop must have committed and pushed it).

```
cd ~/procol-ckg && git pull
```

### 9.1 Runtime
```
sudo apt install -y git ruby
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
node -v      # must be 20.6 or newer
```
Ruby is only used by the indexer (Rails route expansion), not by the service.

### 9.2 Install and build
```
cd ~/procol-ckg && npm install && npm run fe:install && npm run fe:build
```

### 9.3 Source code lives in the database
READ and GREP read `ckg.blob_text` from Postgres, so the **service needs no clones**. Clones are only
needed by the INDEXER (step 10), and only of the commit being indexed. Skip this for a service-only VM.

### 9.4 Secrets
`~/procol-ckg/.env`, then `chmod 600 .env`:
```
CKG_DATABASE_URL=postgres://ckg:OWNER_PASSWORD@localhost/ckg
CKG_READER_URL=postgres://ckg_reader:READER_PASSWORD@localhost/ckg
LLM_BASE_URL=http://slingring.procol.tech/v1
LLM_MODEL=FAST_SMALLER
LLM_API_KEY=<the PROJECT key, not a personal one>
LLM_MODE=auto
EMBED_PROVIDER=local
EMBED_MODEL=Xenova/bge-small-en-v1.5
EMBED_DIMS=384
PORT=8787
CKG_HOST=127.0.0.1
```
Then re-apply the read-only role settings that a dump does not carry:
```
psql "postgres://ckg:OWNER_PASSWORD@localhost/ckg" -f sql/007_reader_role_and_views.sql
```

### 9.5 Prove it
```
curl -s -m 10 http://slingring.procol.tech/v1/models -H "Authorization: Bearer $LLM_API_KEY"   # must list models: the VM can reach Slingring
npm test                                                                                       # 17 tests
npm run serve &  sleep 2;  curl -s http://127.0.0.1:8787/api/health;  kill %1
```

### 9.6 Run it permanently (systemd)
`sudo tee /etc/systemd/system/ckg.service` with:
```
[Unit]
Description=Procol Code Graph agent
After=network.target postgresql.service

[Service]
User=YOUR_LINUX_USER
WorkingDirectory=/home/YOUR_LINUX_USER/procol-ckg
ExecStart=/usr/bin/node --env-file=.env src/service/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
then
```
sudo systemctl daemon-reload && sudo systemctl enable --now ckg
sudo systemctl status ckg --no-pager
journalctl -u ckg -f
```

### 9.7 Reach it
Quick and safe, no open ports: from a laptop with gcloud,
```
gcloud compute ssh procol-ckg --zone asia-south1-c -- -N -L 8787:127.0.0.1:8787
```
then open http://localhost:8787 on the laptop.
For the team: put Caddy or nginx with TLS on a Procol subdomain in front of 127.0.0.1:8787 and restrict
port 443 to office IPs or Identity-Aware Proxy. The service is still in dev auth mode; do not expose it
publicly until the verify endpoint exists.
