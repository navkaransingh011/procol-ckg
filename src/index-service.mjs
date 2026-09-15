// Indexing endpoint. Runs as its own process (deploy/ckg-index.service) on its own port so a
// long embed run cannot starve the agent that is answering questions on 8787.
//
// Why a push and not a pull: the VM has no credentials for the source repos, and a GitHub
// webhook carries metadata only -- never file contents. So CI, which already has the tree
// checked out, ships it: a git bundle of just the paths the extractors read, plus the real
// commit sha. Blob shas are content hashes, so the blob_facts cache still hits even though
// the bundle's own commit sha is synthetic (see --commit-sha in index-commit.mjs).
//
// Requests return 202 immediately and the work runs on a serial queue: two merges landing
// seconds apart must not index the same repo concurrently.
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.INDEX_PORT || 8788);
const HOST = process.env.INDEX_HOST || "127.0.0.1";
const SECRET = process.env.INDEX_WEBHOOK_SECRET || "";
const MAX_BODY = Number(process.env.INDEX_MAX_BODY || 64 * 1024 * 1024);
const KEEP = Number(process.env.INDEX_GC_KEEP || 5);
const ROOT = path.resolve(process.env.CKG_REPO_DIR || path.join(os.homedir(), "procol-ckg"));

// config/refs.json is the VM's own answer to "which refs may be indexed, and what are they".
// Deliberately not taken from the request: a source repo's CI should not be able to invent a
// tenant, or index a ref nobody agreed to carry, just by changing its own workflow file.
async function loadRefs() {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, "config/refs.json"), "utf8"));
  } catch (e) {
    console.error(`cannot read config/refs.json: ${e.message}`);
    return {};
  }
}

if (!SECRET) {
  console.error("INDEX_WEBHOOK_SECRET is required: without it anyone who can reach this port can write to the graph");
  process.exit(1);
}
// Every job spawns node with ROOT as its cwd; a wrong path there surfaces as a confusing
// per-job ENOENT instead of a startup error.
try {
  await fs.access(path.join(ROOT, "src/index-commit.mjs"));
} catch {
  console.error(`CKG_REPO_DIR does not look like the procol-ckg checkout: ${ROOT}`);
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * Timing-safe HMAC check over the RAW body. Must be the raw bytes, not a re-serialised
 * object: any difference in key order or whitespace changes the digest.
 */
function verify(raw, signature) {
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts, env: { ...process.env, ...opts.env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// ---------- queue ----------
// Serial on purpose. Indexing writes entities/edges for one commit and inheritObserved reads
// the ref's previous commit; two runs on the same ref at once would race that read.
const queue = [];
let running = false;
const history = [];   // last 20 jobs, for GET /status

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    job.started = new Date().toISOString();
    job.state = "running";
    try {
      await indexJob(job);
      job.state = "ok";
    } catch (e) {
      job.state = "failed";
      job.error = String(e.message || e);
      log(`job ${job.id} FAILED:`, job.error);
    }
    job.finished = new Date().toISOString();
    history.unshift(job);
    history.length = Math.min(history.length, 20);
  }
  running = false;
}

async function indexJob(job) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "ckg-index-"));
  try {
    const bundle = path.join(work, "tree.bundle");
    await fs.writeFile(bundle, job.bundle);
    job.bundle = null;                                    // release the buffer once on disk

    // A bundle is a single-file git repo. Cloning it gives a real object store, which is what
    // ls-tree and cat-file need -- a plain tarball would have no blob shas and no cache.
    const repoDir = path.join(work, job.repo);
    await run("git", ["clone", "-q", bundle, repoDir], { cwd: work });

    log(`job ${job.id}: indexing ${job.repo}@${job.ref} ${job.sha.slice(0, 8)}`);
    await run("node", [
      "src/index-commit.mjs",
      "--repo-dir", repoDir,
      "--repo-name", job.repo,
      "--ref", "HEAD",
      "--as", job.ref,
      "--commit-sha", job.sha,
      "--trigger", "push",
      ...(job.tenant ? ["--tenant", job.tenant] : []),
      ...(job.env ? ["--env", job.env] : []),
    ]);

    // Embeddings are what semantic anchoring runs on. Skipping this leaves every entity on the
    // new commit unembedded, and semanticAnchor then returns zero matches with no error --
    // plain-English questions silently lose their starting point.
    log(`job ${job.id}: embedding`);
    await run("node", ["src/embed-index.mjs", "--repo", job.repo, "--ref", job.ref]);

    log(`job ${job.id}: gc (keep ${KEEP}/ref)`);
    await run("node", ["src/gc.mjs", "--keep", String(KEEP)]);

    log(`job ${job.id}: done`);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- http ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/status") {
    return send(res, 200, {
      ok: true,
      queued: queue.length,
      running,
      recent: history.map(({ id, repo, ref, sha, state, error, started, finished }) =>
        ({ id, repo, ref, sha: sha?.slice(0, 8), state, error, started, finished })),
    });
  }

  if (req.method !== "POST" || url.pathname !== "/index") return send(res, 404, { error: "not found" });

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (e) {
    return send(res, 413, { error: String(e.message) });
  }

  if (!verify(raw, req.headers["x-ckg-signature"])) {
    log("rejected: bad signature");
    return send(res, 401, { error: "bad signature" });
  }

  // Body is multipart-free on purpose: a JSON envelope with the bundle base64'd inside keeps
  // the signature over exactly one byte string.
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return send(res, 400, { error: "invalid json" });
  }

  const { repo, ref, sha, bundle } = payload;
  if (!repo || !ref || !sha || !bundle) return send(res, 400, { error: "repo, ref, sha and bundle are required" });
  if (!/^[0-9a-f]{40}$/i.test(sha)) return send(res, 400, { error: "sha must be a 40-char hex sha" });
  // No dots: repo becomes a path segment under the temp dir, and ".." would escape it.
  if (!/^[\w-]+$/.test(repo)) return send(res, 400, { error: "repo must be a bare name ([A-Za-z0-9_-])" });

  // Allowlist, and the only source of tenant/env. A ref that is not in refs.json is rejected
  // rather than indexed under a guess: an unknown tenant pollutes every tenant-scoped answer.
  const known = (await loadRefs())[repo]?.find((r) => r.ref === ref);
  if (!known) return send(res, 403, { error: `${repo}@${ref} is not in config/refs.json` });
  const { tenant = null, env = null } = known;

  const job = {
    id: crypto.randomUUID().slice(0, 8),
    repo, ref, sha: sha.toLowerCase(), tenant, env,
    bundle: Buffer.from(bundle, "base64"),
    state: "queued",
    queued: new Date().toISOString(),
  };
  queue.push(job);
  log(`queued ${job.id}: ${repo}@${ref} ${job.sha.slice(0, 8)} (${queue.length} in queue)`);
  drain();                                                // deliberately not awaited

  send(res, 202, { accepted: true, job: job.id, queued: queue.length });
}).listen(PORT, HOST, () => log(`index service on ${HOST}:${PORT}, repo ${ROOT}, gc keep ${KEEP}`));
