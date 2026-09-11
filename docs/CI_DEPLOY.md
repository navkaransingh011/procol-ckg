# Auto-deploy to the VM on merge

Merging to `main` in procol-ckg now runs `.github/workflows/deploy-vm.yml`, which SSHes to the VM
and runs `deploy/vm-deploy.sh`: pull the exact commit, `npm ci`, rebuild the UI, apply migrations,
restart the service, health-check, and roll back if it does not come up.

It NEVER reloads `db/dump/ckg.sql.gz`. That file is a one-time bootstrap artifact; re-loading it
would discard everything indexed since. Schema changes travel as `sql/0NN_*.sql` migrations, which
are all `if not exists` / `create or replace` and safe to re-run.

---

## What auth is required

Two separate things need credentials. Do not confuse them.

| Hop | Who authenticates | Mechanism |
|---|---|---|
| GitHub Actions -> the VM | the workflow | **Workload Identity Federation + IAP tunnel** (recommended) or an SSH key |
| The VM -> GitHub (to `git pull`) | the VM | a **read-only deploy key** on the repo |

### A. GitHub Actions -> VM (recommended: no stored keys, no open port 22)

Run once, as someone with project admin rights. Replace `PROJECT_ID` and `GITHUB_OWNER/REPO`.

```bash
PROJECT_ID=your-gcp-project
REPO=navkaransingh011/procol-ckg
PROJECT_NUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud services enable iamcredentials.googleapis.com iap.googleapis.com compute.googleapis.com --project "$PROJECT_ID"

# 1. a service account the workflow will impersonate
gcloud iam service-accounts create ckg-deployer --project "$PROJECT_ID" \
  --display-name "procol-ckg CI deployer"
SA="ckg-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

# 2. least privilege: reach the instance over IAP and log in as a normal (non-root) OS user
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role roles/compute.viewer
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role roles/iap.tunnelResourceAccessor
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role roles/compute.osLogin

# 3. trust GitHub's OIDC token, restricted to THIS repository
gcloud iam workload-identity-pools create github --project "$PROJECT_ID" --location global \
  --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --project "$PROJECT_ID" --location global --workload-identity-pool github \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository=='${REPO}'"

# 4. let only that repo impersonate the service account
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

# 5. allow IAP's range to reach port 22; the VM needs NO public SSH
gcloud compute firewall-rules create allow-iap-ssh --project "$PROJECT_ID" \
  --network default --direction INGRESS --action allow --rules tcp:22 --source-ranges 35.235.240.0/20

echo "GCP_WIF_PROVIDER = projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/github/providers/github-provider"
echo "GCP_SERVICE_ACCOUNT = ${SA}"
```

Then in GitHub -> Settings -> Secrets and variables -> Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `GCP_WIF_PROVIDER` | the `projects/.../providers/github-provider` string printed above |
| Secret | `GCP_SERVICE_ACCOUNT` | `ckg-deployer@PROJECT_ID.iam.gserviceaccount.com` |
| Variable | `GCP_PROJECT` | your project id |
| Variable | `VM_NAME` | `procol-ckg` |
| Variable | `VM_ZONE` | `asia-south1-c` |

Nothing secret is ever stored: GitHub mints a short-lived token per run.

**Simpler alternative (weaker).** Put a private SSH key in a secret and open port 22.
That means a long-lived credential in GitHub and SSH reachable from GitHub's whole runner IP
range. Only choose this if Workload Identity Federation is blocked for you.

### B. The VM -> GitHub

The VM runs `git fetch`, so it needs read access to a private repo. Use a **deploy key**, which is
scoped to this one repo and cannot push.

On the VM:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/ckg_deploy -N "" -C "procol-ckg deploy key"
cat ~/.ssh/ckg_deploy.pub
git -C ~/procol-ckg remote set-url origin git@github.com:navkaransingh011/procol-ckg.git
printf 'Host github.com\n  IdentityFile ~/.ssh/ckg_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
ssh -o StrictHostKeyChecking=accept-new -T git@github.com || true
```
Paste that public key into GitHub -> the repo -> Settings -> Deploy keys -> Add, **leave "Allow write
access" unchecked**.

---

## One-time VM preparation

```bash
# 1. systemd unit, so the service survives reboots and restarts cleanly
sudo cp ~/procol-ckg/deploy/ckg.service /etc/systemd/system/ckg.service
sudo sed -i "s/__USER__/$USER/g; s#__HOME__#$HOME#g" /etc/systemd/system/ckg.service
sudo systemctl daemon-reload && sudo systemctl enable --now ckg
systemctl status ckg --no-pager

# 2. let the deploy restart the service without an interactive password
echo "$USER ALL=(root) NOPASSWD: /bin/systemctl restart ckg, /bin/systemctl status ckg" \
  | sudo tee /etc/sudoers.d/ckg-deploy
sudo chmod 440 /etc/sudoers.d/ckg-deploy

# 3. prove the deploy script works by hand before trusting CI
bash ~/procol-ckg/deploy/vm-deploy.sh origin/main
```

## Verify the pipeline

Push any change to `main`, or run the workflow manually from the Actions tab. A green run means the
VM is on that commit, migrated, rebuilt, restarted and healthy. `/api/health` reports `last_indexed`,
so you can see the graph is intact.

## Indexing host requirements

The indexer (not the service) needs `git` and **Ruby 3.x** (`sudo apt install -y ruby`): route expansion
and the symbol extractor both shell out to Ruby. Ruby 2.6 works but falls back to a line scanner on files
using Ruby 3 syntax, marking those symbols HEURISTIC.

## Not covered here

This deploys the AGENT. Keeping the GRAPH fresh when procol-backend / procol-client-dashboard /
web-bidding merge is a separate pipeline (`.github/workflows/ckg-index.yml`, still a template).
That one needs a clone of the merged commit, so it either runs on the VM or ships the commit to it.
