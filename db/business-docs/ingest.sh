#!/usr/bin/env bash
# Ingest every curated business document in this folder into the code graph database.
# Run from the procol-ckg checkout with .env pointing at the target database (laptop or VM):
#   db/business-docs/ingest.sh            # add (fails on a slug that already exists)
#   db/business-docs/ingest.sh --replace  # overwrite documents that are already there
# Afterwards: node --env-file=.env src/ingest-doc.mjs --list
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo ".env not found in $(pwd); see docs/VM_SETUP.md" >&2; exit 1; }
extra=("$@")
while IFS=$'\t' read -r slug title tags owner source; do
  [[ -z "$slug" || "$slug" == \#* ]] && continue
  file="db/business-docs/$slug.md"
  [ -f "$file" ] || { echo "missing $file" >&2; exit 1; }
  echo "== $slug"
  node --env-file=.env src/ingest-doc.mjs --file "$file" --slug "$slug" --title "$title" --tags "$tags" --owner "$owner" --source "upload" "${extra[@]}"
done < db/business-docs/manifest.tsv
node --env-file=.env src/ingest-doc.mjs --list
