#!/usr/bin/env node
// Backfill every deployed ref listed in config/refs.json.
// CI indexes ONE ref (the one just merged); this is the cold-start / catch-up path.
//
// Usage: node src/index-all.mjs --root ../  [--repo procol-backend]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const root = path.resolve(arg("root", path.join(HERE, "..", "..")));
const only = arg("repo");
const cfg = JSON.parse(readFileSync(path.join(HERE, "..", "config", "refs.json"), "utf8"));

const rows = [];
for (const [repo, refs] of Object.entries(cfg)) {
  if (repo.startsWith("_")) continue;
  if (only && repo !== only) continue;
  const dir = path.join(root, repo);

  for (const { ref, tenant, env } of refs) {
    // Prefer the remote-tracking ref: local branches may be stale or absent.
    let target = ref;
    try {
      execFileSync("git", ["-C", dir, "rev-parse", "--verify", `origin/${ref}`],
                   { stdio: "ignore" });
      target = `origin/${ref}`;
    } catch { /* fall back to the local name */ }

    try {
      const out = execFileSync("node", [path.join(HERE, "index-commit.mjs"),
        "--repo-dir", dir, "--ref", target, "--trigger", "backfill"],
        { encoding: "utf8", env: process.env });
      const hit = out.match(/\((\d+)% cache hit\)/)?.[1] ?? "?";
      const ents = out.match(/loaded: (\d+) entities/)?.[1] ?? "?";
      const ms = out.match(/in (\d+)ms/)?.[1] ?? "?";
      rows.push({ repo, ref, tenant, env, hit: `${hit}%`, entities: ents, ms });
      console.log(`  ok  ${repo}@${ref}  ${hit}% cached  ${ents} entities  ${ms}ms`);
    } catch (e) {
      rows.push({ repo, ref, tenant, env, hit: "FAIL", entities: "-", ms: "-" });
      console.error(`  FAIL ${repo}@${ref}: ${String(e.message).split("\n")[0]}`);
    }
  }
}
console.log("\n" + JSON.stringify(rows, null, 2));
