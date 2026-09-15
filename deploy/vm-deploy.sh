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

# Bash keeps reading the file it opened, so when this deploy changes vm-deploy.sh itself the OLD
# version would finish the run and the new steps would only take effect on the NEXT deploy.
# Re-exec once so the freshly checked-out script is the one that runs the rest of this deploy.
if [ "$BEFORE" != "$AFTER" ] && [ -z "${CKG_DEPLOY_REEXEC:-}" ] && ! git diff --quiet "$BEFORE" "$AFTER" -- deploy/vm-deploy.sh; then
  echo "==> deploy script changed in this release; re-running the new version"
  exec env CKG_DEPLOY_REEXEC=1 bash "$REPO_DIR/deploy/vm-deploy.sh" "$TARGET_REF"
fi

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

# Business documents live in the database, not the repo, so the deploy keeps them in sync with
# db/business-docs/. Unchanged documents are skipped; a failure here must never block a release
# (answers simply fall back to code-only until the next deploy).
echo "==> syncing business documents"
if ! db/business-docs/ingest.sh --replace --if-changed; then
  echo "!! business document sync failed; continuing the deploy" >&2
fi

echo "==> restarting $SERVICE"
sudo systemctl restart "$SERVICE"

# The indexer is a second process running THIS SAME checkout (deploy/ckg-index.service). Without
# this it keeps executing the pre-deploy code until someone restarts it by hand, so a fix to an
# extractor would ship to the agent and not to indexing. Skipped silently when the unit is not
# installed, and never fatal: a release must not fail because indexing is down.
if systemctl list-unit-files "${CKG_INDEX_SERVICE:-ckg-index}.service" --no-legend | grep -q .; then
  echo "==> restarting ${CKG_INDEX_SERVICE:-ckg-index}"
  sudo systemctl restart "${CKG_INDEX_SERVICE:-ckg-index}" || \
    echo "!! ${CKG_INDEX_SERVICE:-ckg-index} did not restart; indexing is stale until it does" >&2
fi

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
