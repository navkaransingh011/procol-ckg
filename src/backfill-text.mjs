#!/usr/bin/env node
// One-off: for a commit ALREADY in a local clone, record its full source tree (commit_files + blobs)
// and store the text, so DB-based READ/GREP work at that commit. Used to enrich the teammate's
// imported commit (kb-import populated entities but not the file tree).
//   node --env-file=.env src/backfill-text.mjs --repo-dir ../procol-backend --commit <sha> --ref main
import path from "node:path";
import { listTree, readBlobs, resolveRef } from "./git.mjs";
import { q, hex, upsertRepo } from "./db.mjs";
import { registerBlobs, recordCommitFiles } from "./cache.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const repoDir = arg("repo-dir"); const commitArg = arg("commit", "HEAD");
const SECRET = /(^|\/)(\.env|\.env\..*|.*\.pem|id_rsa.*|.*\.key|.*\.p12)$/;
const SOURCE_DIRS = /^(app|lib|config|db|src|spec|test)\//;
const SOURCE_EXT = /\.(rb|rake|erb|jbuilder|haml|slim|js|jsx|ts|tsx|mjs|cjs|json|ya?ml|less|css|scss|sql|md)$/;
const MAX = 2 * 1024 * 1024;

const repoName = path.basename(path.resolve(repoDir));
const repoId = await upsertRepo("procol", repoName, repoName.includes("backend") ? "monolith" : "spa");
const sha = (await resolveRef(repoDir, commitArg)).sha;
const commitExists = await q(`select 1 from ckg.commits where repo_id=$1 and sha=decode($2,'hex')`, [repoId, sha]);
if (!commitExists.length) { console.error(`commit ${sha} not in ckg.commits for ${repoName}; index it first`); process.exit(1); }

const tree = (await listTree(repoDir, sha))
  .filter(f => !SECRET.test(f.path) && SOURCE_DIRS.test(f.path) && SOURCE_EXT.test(f.path) && f.sizeBytes <= MAX);
console.log(`${repoName}@${sha.slice(0,8)}: ${tree.length} source files`);

await registerBlobs(tree.map(f => ({ ...f, lang: path.extname(f.path).slice(1) })));
await recordCommitFiles(repoId, sha, tree);

const uniq = [...new Set(tree.map(f => f.blobSha))];
const have = new Set((await q(`select encode(blob_sha,'hex') h from ckg.blob_text where blob_sha=any($1::bytea[])`, [uniq.map(hex)])).map(r => r.h));
const misses = uniq.filter(s => !have.has(s));
let stored = 0;
for (let i = 0; i < misses.length; i += 300) {
  const batch = misses.slice(i, i + 300);
  const contents = await readBlobs(repoDir, batch);
  const rows = [];
  for (const s of batch) { const b = contents.get(s); if (!b || b.includes(0)) continue; const t = b.toString("utf8"); rows.push([hex(s), t, t.split("\n").length]); }
  if (!rows.length) continue;
  const vals = rows.map((_, j) => `($${j*3+1},$${j*3+2},$${j*3+3})`).join(",");
  await q(`insert into ckg.blob_text (blob_sha,text,lines) values ${vals} on conflict (blob_sha) do nothing`, rows.flat());
  stored += rows.length;
}
const [cov] = await q(`select count(*) files, count(bt.blob_sha) with_text from ckg.commit_files cf left join ckg.blob_text bt on bt.blob_sha=cf.blob_sha where cf.repo_id=$1 and cf.commit_sha=decode($2,'hex')`, [repoId, sha]);
console.log(`stored ${stored} new blobs; coverage at ${sha.slice(0,8)}: ${cov.with_text}/${cov.files} files`);
process.exit(0);
