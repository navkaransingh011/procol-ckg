#!/usr/bin/env node
// Parity check: run be-ast over a commit's tree straight from git (no DB writes) and compare the
// symbol set with the bootstrap import's SYMBOL rows for that commit.
//   node --env-file=.env src/dev/ast-parity.mjs --repo-dir ../procol-backend --commit 1089000b...
import path from "node:path";
import { listTree, readBlobs } from "../git.mjs";
import { q, pool } from "../db.mjs";
import * as beAst from "../extractors/be-ast.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const repoDir = arg("repo-dir", "../procol-backend"); const sha = arg("commit");
const repoName = path.basename(path.resolve(repoDir));

const t0 = Date.now();
const files = (await listTree(repoDir, sha)).filter(f => beAst.handles(f.path));
const contents = await readBlobs(repoDir, [...new Set(files.map(f => f.blobSha))]);
const res = beAst.extractBatch(files.map(f => ({ sha: f.blobSha, buf: contents.get(f.blobSha), path: f.path })));
const parseMs = Date.now() - t0;

const ast = new Map();   // fqn -> {path, parser}
let regexFiles = 0, failed = 0;
for (const f of files) {
  const r = res.get(f.blobSha);
  if (!r?.ok) { failed++; continue; }
  if (r.facts.parser === "regex") regexFiles++;
  const out = beAst.resolve(r.facts, f, { siteHash: () => Buffer.alloc(20) });
  for (const e of out.entities) if (!ast.has(e.fqn)) ast.set(e.fqn, { path: f.path, parser: r.facts.parser, kind: e.attrs.subkind });
}

const kb = new Map((await q(
  `select e.fqn, e.path, e.attrs->>'subkind' sk from ckg.entities e join ckg.repos rp on rp.id=e.repo_id
    where rp.name=$1 and encode(e.commit_sha,'hex')=$2 and e.kind='SYMBOL' and e.extractor like 'kb-import%'`, [repoName, sha]))
  .map(r => [r.fqn, r]));

const both = [...ast.keys()].filter(k => kb.has(k));
const onlyKb = [...kb.keys()].filter(k => !ast.has(k));
const onlyAst = [...ast.keys()].filter(k => !kb.has(k));
const byDir = (arr, m) => { const c = {}; for (const k of arr) { const d = (m.get(k)?.path || "?").split("/").slice(0, 2).join("/"); c[d] = (c[d] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8); };
const byKind = (arr, m, key) => { const c = {}; for (const k of arr) { const d = m.get(k)?.[key] || "?"; c[d] = (c[d] || 0) + 1; } return c; };

console.log(`${repoName}@${sha.slice(0, 8)}: ${files.length} ruby files, parsed in ${parseMs}ms (${regexFiles} via regex fallback, ${failed} failed)`);
console.log(`be-ast symbols: ${ast.size}   kb-import symbols: ${kb.size}`);
console.log(`in both: ${both.length}   recall vs kb: ${(100 * both.length / kb.size).toFixed(1)}%   kb-only (missed): ${onlyKb.length}   ast-only (extra): ${onlyAst.length}`);
console.log(`\nmissed by kind: ${JSON.stringify(byKind(onlyKb, kb, "sk"))}`);
console.log(`missed by dir: ${JSON.stringify(byDir(onlyKb, kb))}`);
const byFile = (arr, m) => { const c = {}; for (const k of arr) { const f = m.get(k)?.path || "?"; c[f] = (c[f] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 10); };
console.log(`missed by file (top 10):`); for (const [f, n] of byFile(onlyKb, kb)) console.log(`  ${String(n).padStart(4)}  ${f}`);
console.log(`missed sample:\n  ${onlyKb.filter(k => !/scripts\//.test(kb.get(k)?.path || "")).slice(0, 12).join("\n  ")}`);
console.log(`\nextra by kind: ${JSON.stringify(byKind(onlyAst, ast, "kind"))}`);
console.log(`extra by dir: ${JSON.stringify(byDir(onlyAst, ast))}`);
console.log(`extra sample:\n  ${onlyAst.slice(0, 15).join("\n  ")}`);
await pool.end();
