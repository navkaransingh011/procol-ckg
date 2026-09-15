# Keeping the graph fresh: indexing a source repo on merge

`docs/CI_DEPLOY.md` deploys the **agent**. This deploys the **graph**: when procol-backend (and
later procol-client-dashboard, web-bidding) merges to a tracked ref, the new tree lands in the
database on the VM — entities, edges, `blob_text`, embeddings — without anyone running `npm run
index` by hand.

Wired today: **procol-backend @ `procol-ckg` and `main`**.

`procol-ckg` is the pipeline's own branch in procol-backend. It exists so the whole path can run
for real — bundle, tunnel, index, embed, gc — without merging a workflow into `main` first. It is
allowlisted as `env: ci` so its snapshots stay distinguishable from the deployed ones in
`ref_history`. When `main` adopts the workflow, nothing needs editing: both refs are already
listed in the workflow and in `config/refs.json`.

## Shape

```
push to procol-ckg (or main)
  └─ procol-backend/.github/workflows/ckg-push-tree.yml   (the ONLY file added to that repo)
       ├─ builds a git bundle of app lib config db spec test scripts mcp_tools + root *.md
       ├─ WIF → IAP tunnel to VM:22 → ssh -L 8788:127.0.0.1:8788
       └─ POST /index  (HMAC-signed, bundle base64 inside one JSON envelope)
            └─ VM: src/index-service.mjs   (deploy/ckg-index.service, port 8788, loopback only)
                 ├─ checks config/refs.json  → repo@ref allowed? tenant/env?
                 ├─ git clone the bundle into a temp dir
                 ├─ node src/index-commit.mjs --commit-sha <real sha> --as <ref>
                 ├─ node src/embed-index.mjs --repo <repo> --ref <ref>
                 └─ node src/gc.mjs --keep 5
```

### Why a push and not a pull

A GitHub webhook carries metadata only, never file contents, so the VM would need its own
credentials for every source repo to fetch a tree. CI already has the checkout. It ships it, and
the VM keeps zero source-repo credentials.

### Why a git bundle and not a tarball

Blob shas are content hashes. The filtered bundle's blobs are byte-identical to the real repo's,
so `blob_facts` — the per-file parse cache — still hits and an average merge re-parses only what
changed. A tarball has no blob shas and would re-parse the whole tree every time. Only the
bundle's own commit sha is synthetic, which is why the real sha travels beside it in the envelope
and is what the graph records.

## What protects the existing data

Nothing in this pipeline mutates or deletes an earlier commit's rows. The guarantees are in the
schema and the indexer, not in the CI script:

| Concern | What actually holds it |
|---|---|
| Old data corrupted by a new merge | `ckg.entities` / `ckg.edges` are commit-scoped and insert-only (`sql/001_core.sql`). Each run writes a full snapshot under the new `commit_sha`. Nothing is updated in place. |
| Relationships lost across commits | Every edge is re-derived from the new tree in the per-commit phase — exact, not "changed files plus one hop". New relationships appear because the whole tree is resolved, not diffed. |
| Runtime-only evidence lost | `inheritObserved()` copies `CALLS`/`RUNTIME` edges and `OBSERVED_DEFECT` nodes forward **only** when both endpoints' files have an identical blob sha. A changed file drops the edge rather than carrying a stale claim; copies keep `attrs.observed_at` pointing at the commit the evidence was really captured on. |
| Text duplicated or churned | `blob_text` is content-addressed with `on conflict do nothing`: a given file content is stored once, ever, across every repo and commit. |
| Embeddings going stale | The job runs `embed-index.mjs` after every index. Skipping it is silent — `semanticAnchor` returns zero matches with no error and plain-English questions lose their starting point. |
| Disk growing forever | `gc.mjs --keep 5` per `(repo, ref)`. It refuses `keep < 2` because `inheritObserved` needs the previous commit, deletes edges before entities for the FK order, and never touches commit-less rows (shared endpoint contracts, uploaded documents). |
| Two merges racing | The endpoint answers 202 and runs a **serial** queue; the workflow's `concurrency` group also supersedes a queued run with the newer commit. |
| A repo indexing itself under a made-up tenant | `config/refs.json` **on the VM** is the allowlist and the only source of `tenant`/`env`. A ref that is not listed gets 403. The request's own claims are ignored. |

Adding a ref is an edit to `config/refs.json` **on the VM** plus a branch in the source
workflow's `on.push.branches` — not a code change. Both lists must agree: the VM's copy decides,
so a branch added only to the workflow gets a 403 and a ref added only to `refs.json` never fires.

## One-time setup

### 1. VM: the indexer service

```bash
cd ~/procol-ckg

# a secret, shared with each source repo as its CKG_INDEX_SECRET
openssl rand -hex 32
# add to .env (see .env.example), then:
chmod 600 .env

sudo cp deploy/ckg-index.service /etc/systemd/system/ckg-index.service
sudo sed -i "s/__USER__/$USER/g; s#__HOME__#$HOME#g" /etc/systemd/system/ckg-index.service
sudo systemctl daemon-reload && sudo systemctl enable --now ckg-index
curl -s http://127.0.0.1:8788/status
```

The indexer shells out to `git` and to **Ruby 3.x** (`sudo apt install -y ruby`) — route expansion
and the symbol extractor both need it. Ruby 2.6 works but falls back to a line scanner on Ruby 3
syntax and marks those symbols `HEURISTIC`.

Let the deploy restart it without a password. The existing `/etc/sudoers.d/ckg-deploy` only covers
`ckg`; replace it:

```bash
echo "$USER ALL=(root) NOPASSWD: /bin/systemctl restart ckg, /bin/systemctl status ckg, /bin/systemctl restart ckg-index, /bin/systemctl status ckg-index" \
  | sudo tee /etc/sudoers.d/ckg-deploy
sudo chmod 440 /etc/sudoers.d/ckg-deploy
```

`deploy/vm-deploy.sh` restarts `ckg-index` from then on. Without it the indexer keeps running the
pre-deploy code, so an extractor fix would reach the agent and not the indexing.

### 2. The source repo (procol-backend)

Add `.github/workflows/ckg-push-tree.yml` — copy `deploy/ckg-push-tree.yml`. Nothing else in that
repo changes.

Then, in that repo's Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `GCP_WIF_PROVIDER` | same value procol-ckg uses |
| Secret | `GCP_SERVICE_ACCOUNT` | `ckg-deployer@<project>.iam.gserviceaccount.com` |
| Secret | `CKG_SSH_KEY` | private half of the VM's deploy keypair |
| Secret | `CKG_INDEX_SECRET` | the `INDEX_WEBHOOK_SECRET` from the VM's `.env` |
| Variable | `GCP_PROJECT` | the graph VM's project id |
| Variable | `VM_NAME` | `procol-ckg` |
| Variable | `VM_ZONE` | `asia-south1-c` |
| Variable | `VM_SSH_USER` | the VM's deploy user |

The Workload Identity provider must trust this repository too. Its attribute condition is pinned
to procol-ckg today, so widen it once to the set of repos that index:

```bash
gcloud iam workload-identity-pools providers update-oidc github-provider \
  --project "$PROJECT_ID" --location global --workload-identity-pool github \
  --attribute-condition "assertion.repository in ['Procol-Tech/procol-ckg','Procol-Tech/procol-backend']"

gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/github/attribute.repository/Procol-Tech/procol-backend"
```

No new firewall rule and no new port: the run tunnels to **22**, which `allow-iap-ssh` already
permits from `35.235.240.0/20`, and forwards to the loopback 8788 from inside the VM.

### 3. Prove it by hand before trusting CI

From the VM, with `INDEX_WEBHOOK_SECRET` exported:

```bash
cd /tmp && rm -rf t && git clone --depth 1 <backend-url> t
cd t && git bundle create /tmp/tree.bundle --all
SHA=$(git rev-parse HEAD)
python3 -c "
import base64, json
print(json.dumps({'repo':'procol-backend','ref':'main','sha':'$SHA',
                  'bundle':base64.b64encode(open('/tmp/tree.bundle','rb').read()).decode()}))" > /tmp/body.json
SIG="sha256=$(openssl dgst -sha256 -hmac "$INDEX_WEBHOOK_SECRET" -hex < /tmp/body.json | awk '{print $NF}')"
curl -fsS -X POST http://127.0.0.1:8788/index -H 'content-type: application/json' \
  -H "x-ckg-signature: $SIG" --data-binary @/tmp/body.json
watch -n5 'curl -s http://127.0.0.1:8788/status'
```

## Operating it

```bash
journalctl -u ckg-index -f                      # live index runs
curl -s http://127.0.0.1:8788/status | jq       # queue depth + last 20 jobs
curl -s http://127.0.0.1:8787/api/health        # last_indexed, as the agent sees it
```

Cache health, which is what keeps a merge cheap:

```bash
psql "$CKG_DATABASE_URL" -Atc "
  select repo_id, blobs_cached, blobs_parsed,
         round(100.0*blobs_cached/nullif(blobs_cached+blobs_parsed,0)) pct
    from ckg.index_runs order by id desc limit 5"
```

Below ~50% on an established ref means the per-blob cache stopped hitting — usually a bundle whose
paths changed — and every merge is re-parsing the whole tree.

### Failure modes

| Symptom | Cause |
|---|---|
| `401 bad signature` | `CKG_INDEX_SECRET` in the repo ≠ `INDEX_WEBHOOK_SECRET` in the VM's `.env`. |
| `403 ... not in config/refs.json` | The pushed ref is not allowlisted on the VM. Add it there first. |
| `413 body too large` | Bundle over `INDEX_MAX_BODY` (64 MB default, base64'd). Trim the path list in the workflow or raise the limit. |
| Workflow hangs before the POST | The IAP tunnel or the SSH forward never came up — check `CKG_SSH_KEY` and that the service account still has `roles/iap.tunnelResourceAccessor`. |
| Job `failed` | `journalctl -u ckg-index` has the indexer's own output. The graph is unchanged: the failed run's partial commit is simply never pointed at by a ref, and `gc.mjs` removes it. |

## Not covered here

Documents (`docs/DOCS_INGEST.md`) and the live UAT mirror (`docs/VM_UPDATE.md`) are separate
pipelines with their own cadence. Neither is touched by an index run.
