#!/usr/bin/env bash
# Runs ON THE VM. Pulls the pushed commit, rebuilds, migrates, restarts, health-checks.
# Idempotent and safe to re-run. It NEVER reloads db/dump/ckg.sql.gz -- that is a one-time
# bootstrap artifact; re-loading it would discard everything indexed since.
set -euo pipefail

REPO_DIR="${CKG_REPO_DIR:-$HOME/procol-ckg}"
SERVICE="${CKG_SERVICE:-ckg}"
HEALTH_URL="${CKG_HEALTH_URL:-http://127.0.0.1:8787/api/health}"
TARGET_REF="${1:-origin/main}"

echo "==> deploying $TARGET_REF into $REPO_DIR"
cd "$REPO_DIR"

# .env is gitignored, so a hard reset never touches secrets.
git fetch --prune origin
BEFORE="$(git rev-parse HEAD)"
git reset --hard "$TARGET_REF"
AFTER="$(git rev-parse HEAD)"
echo "==> $BEFORE -> $AFTER"

echo "==> installing dependencies"
npm ci --omit=dev
npm --prefix fe ci

echo "==> building the UI"
npm run fe:build

# Every migration is `if not exists` / `create or replace`, and the ckg_reader role creation is
# exception-guarded, so an existing role keeps its password.
echo "==> applying migrations"
set -a; . ./.env; set +a
npm run migrate

echo "==> restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> waiting for health"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"ok":true'; then
    echo "==> healthy:"
    curl -fsS --max-time 5 "$HEALTH_URL"
    echo
    exit 0
  fi
  sleep 2
done

echo "!! service did not become healthy; rolling back to $BEFORE" >&2
git reset --hard "$BEFORE"
npm ci --omit=dev && npm --prefix fe ci && npm run fe:build
sudo systemctl restart "$SERVICE"
journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
exit 1
