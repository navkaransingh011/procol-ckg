// Git is our content-addressing layer. We never hash files ourselves and we never
// diff: `git ls-tree -r` hands us a blob SHA per path, and that SHA IS the cache key.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

async function git(repoDir, args) {
  const { stdout } = await exec("git", ["-C", repoDir, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Resolve a ref (branch, tag, SHA) to its commit metadata. */
export async function resolveRef(repoDir, ref) {
  const out = await git(repoDir, ["log", "-1", "--format=%H%x00%cI%x00%s", ref]);
  const [sha, committedAt, subject] = out.trim().split("\0");
  return { sha, committedAt, subject };
}

/**
 * The whole tree of one commit, as (path, blobSha, sizeBytes).
 * One git call. `-l` gives us the size so we can skip giant files without reading them.
 */
export async function listTree(repoDir, commitSha) {
  const out = await git(repoDir, ["ls-tree", "-r", "-l", "--full-tree", commitSha]);
  const files = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    // "<mode> <type> <object> <size>\t<path>"
    const tabAt = line.indexOf("\t");
    if (tabAt === -1) continue;
    const meta = line.slice(0, tabAt).split(/\s+/);
    const [, type, object, size] = meta;
    if (type !== "blob") continue;               // skip submodules/trees
    files.push({
      path: line.slice(tabAt + 1),
      blobSha: object,
      sizeBytes: size === "-" ? 0 : Number(size),
    });
  }
  return files;
}

/**
 * Read blob contents by SHA. Works even when the ref isn't the checked-out one,
 * so we can index several refs from a single clone without switching branches.
 * Batched through one long-lived `git cat-file --batch` process: on a cold start
 * that is ~1,700 blobs in a couple of seconds instead of 1,700 process spawns.
 */
export async function readBlobs(repoDir, blobShas) {
  const results = new Map();
  if (blobShas.length === 0) return results;

  const { spawn } = await import("node:child_process");
  const proc = spawn("git", ["-C", repoDir, "cat-file", "--batch"]);

  const chunks = [];
  proc.stdout.on("data", (c) => chunks.push(c));
  const done = new Promise((res, rej) => {
    proc.on("error", rej);
    proc.on("close", res);
  });

  proc.stdin.write(blobShas.join("\n") + "\n");
  proc.stdin.end();
  await done;

  // Response stream is: "<sha> <type> <size>\n<size bytes>\n" repeated.
  let buf = Buffer.concat(chunks);
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = buf.subarray(off, nl).toString("utf8");
    const [sha, type, sizeStr] = header.split(" ");
    if (type !== "blob") break;
    const size = Number(sizeStr);
    const start = nl + 1;
    results.set(sha, buf.subarray(start, start + size));
    off = start + size + 1; // trailing newline
  }
  return results;
}

/** Files changed between two commits — used for PR-scoped evaluation, not for indexing. */
export async function changedPaths(repoDir, baseSha, headSha) {
  const out = await git(repoDir, ["diff", "--name-only", `${baseSha}..${headSha}`]);
  return out.split("\n").filter(Boolean);
}

export async function currentBranch(repoDir) {
  return (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}
