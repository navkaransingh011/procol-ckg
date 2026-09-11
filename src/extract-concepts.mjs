#!/usr/bin/env node
// PER-COMMIT extractor for the three layers the graph lacked.
//
// 1. FEATURE  product capabilities, from three human-written sources:
//      mcp_tools/<domain>/*.rb  -- 26 business-capability descriptions with module + display_title
//      ai-review/CODEBASE_INDEX.md "## Key Features" -- someone already wrote the taxonomy
//      app/services/<name>/     -- 128 feature-named directories
// 2. PERSON   contributors, from git log, with OWNS edges weighted by commits touched
// 3. activity recency, so "what is being built now" is answerable
//
// Nothing here is guessed: every FEATURE traces to a doc line or a directory, every OWNS
// edge to git history. Resolutions are DOCUMENTED and VCS so an answer can say which.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { q, one, hex, upsertRepo, pool } from "./db.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const repoDir = path.resolve(arg("repo-dir", "../procol-backend"));
const ref = arg("ref", "main");
const SINCE = arg("since", "12 months ago");

// Per-repo config. Rails and the React apps keep their features in different places,
// and only the backend has mcp_tools. Adding a repo is an entry here, not new code.
const REPO_CONFIG = {
  "procol-backend": {
    docs: ["ai-review/CODEBASE_INDEX.md", "CODEBASE_INDEX.md"],
    featureDirs: [{ prefix: "app/services/", depth: 3 }, { prefix: "app/controllers/api/", depth: 4 }],
    mcpTools: true,
  },
  "procol-client-dashboard": {
    docs: ["CODEBASE_INDEX.md", "ai-review/CODEBASE_INDEX.md"],
    // Only screens are features. 123 component folders are shared UI, not capabilities a
    // CS person would ask about -- they get linked as supporting code via linkDirs.
    featureDirs: [{ prefix: "src/views/", depth: 3 }],
    linkDirs: [{ prefix: "src/redux/", depth: 3 }, { prefix: "src/components/", depth: 3 }],
    mcpTools: false,
  },
  "web-bidding": {
    docs: ["CODEBASE_INDEX.md", "ai-review/CODEBASE_INDEX.md"],
    featureDirs: [{ prefix: "src/views/", depth: 3 }],
    linkDirs: [{ prefix: "src/redux/", depth: 3 }, { prefix: "src/components/", depth: 3 }],
    mcpTools: false,
  },
};

const git = (...a) => execFileSync("git", ["-C", repoDir, ...a], { encoding: "utf8", maxBuffer: 256e6 });
const show = (sha, p) => { try { return git("show", `${sha}:${p}`); } catch { return null; } };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const features = new Map();   // key -> {name, description, source, path, bullets[], keyModels[], dirs[]}
function addFeature(key, patch) {
  const f = features.get(key) || { key, bullets: [], keyModels: [], dirs: [], sources: [] };
  features.set(key, { ...f, ...patch, bullets: [...f.bullets, ...(patch.bullets || [])],
                      keyModels: [...f.keyModels, ...(patch.keyModels || [])],
                      dirs: [...new Set([...f.dirs, ...(patch.dirs || [])])],
                      sources: [...new Set([...f.sources, ...(patch.sources || [])])] });
}

// ---------- source A: CODEBASE_INDEX.md "Key Features" (human-written taxonomy)
function fromCodebaseIndex(sha, cfg) {
  let md = null, docPath = null;
  for (const d of cfg.docs) { const t = show(sha, d); if (t) { md = t; docPath = d; break; } }
  if (!md) return 0;
  const lines = md.split("\n");
  // Accept "Key Features", "Features", "Main Modules", "Core Modules" -- repos word it differently.
  const start = lines.findIndex((l) => /^##\s+(\d+\.\s*)?(key\s+)?(features|modules|main\s+modules|core\s+modules|functional\s+areas|key\s+business\s+logic|business\s+logic|event\s+types)\b/i.test(l));
  if (start === -1) return 0;
  let n = 0, cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s+/.test(l)) break;                                  // next top section
    const h = l.match(/^###\s+\d*\.?\s*(.+?)\s*$/) || l.match(/^\*\*(.+?)\*\*\s*$/);
    if (h) { cur = slug(h[1].replace(/\(.*?\)/g, "")); addFeature(cur, { name: h[1].trim(), sources: ["CODEBASE_INDEX"], doc: docPath, docLine: i + 1 }); n++; continue; }
    if (!cur) continue;
    const b = l.match(/^-\s+(.+)$/);
    if (b) addFeature(cur, { bullets: [b[1].trim()] });
    const km = l.match(/\*\*Key Models\*\*:\s*(.+)$/);
    if (km) addFeature(cur, { keyModels: [...km[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) });
  }
  return n;
}

// ---------- source B: mcp_tools (business capabilities, grouped by module)
function fromMcpTools(sha) {
  const listing = (() => { try { return git("ls-tree", "-r", "--name-only", sha, "mcp_tools/").split("\n").filter((f) => f.endsWith(".rb")); } catch { return []; } })();
  const byModule = new Map();
  for (const f of listing) {
    const src = show(sha, f); if (!src) continue;
    const mod = src.match(/"module":\s*"([^"]+)"/)?.[1] || f.split("/")[1];
    const title = src.match(/"display_title":\s*"([^"]+)"/)?.[1] || null;
    const name = src.match(/"name":\s*"([^"]+)"/)?.[1] || path.basename(f, ".rb");
    const desc = src.match(/"description":\s*"([\s\S]*?)"\s*,\s*\n\s*"meta_data"/)?.[1]
              ?? src.match(/"description":\s*"([^"]{10,400})"/)?.[1] ?? null;
    const phases = [...(src.match(/"availability_phases":\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push({ name, title, desc: desc?.replace(/\s+/g, " ").slice(0, 500), phases, file: f });
  }
  for (const [mod, tools] of byModule) {
    addFeature(slug(mod), {
      name: features.get(slug(mod))?.name ?? mod.replace(/_/g, " "),
      sources: ["mcp_tools"], mcpTools: tools,
      bullets: tools.map((t) => `${t.title || t.name}: ${t.desc || ""}`.trim().slice(0, 240)),
      doc: features.get(slug(mod))?.doc ?? tools[0].file,
    });
  }
  return byModule.size;
}

// ---------- source C: app/services + mcp_tools directories as feature boundaries
function fromDirectories(sha, cfg) {
  const prefixes = cfg.featureDirs.map((d) => d.prefix);
  const tree = (() => { try { return git("ls-tree", "-r", "--name-only", sha, ...prefixes).split("\n").filter(Boolean); } catch { return []; } })();
  const dirCount = new Map();
  for (const f of tree) {
    const spec = cfg.featureDirs.find((d) => f.startsWith(d.prefix));
    if (!spec) continue;
    const seg = f.split("/");
    if (seg.length <= spec.depth) continue;            // a bare file at the root is not a feature
    const dir = seg[spec.depth - 1];
    const k = slug(dir);
    dirCount.set(k, (dirCount.get(k) || 0) + 1);
    addFeature(k, { name: features.get(k)?.name ?? dir.replace(/[_-]/g, " "), sources: ["directory"],
                    dirs: [seg.slice(0, spec.depth).join("/")] });
  }
  // A supporting directory with the same name as a feature belongs to it:
  // src/views/orderDetails is the feature; src/redux/orderDetails is how it stores state.
  for (const spec of cfg.linkDirs ?? []) {
    let tree2 = [];
    try { tree2 = git("ls-tree", "-r", "--name-only", sha, spec.prefix).split("\n").filter(Boolean); } catch { /* absent */ }
    for (const f of tree2) {
      const seg = f.split("/");
      if (seg.length <= spec.depth) continue;
      const k = slug(seg[spec.depth - 1]);
      if (!features.has(k)) continue;                 // only attach to an existing feature
      addFeature(k, { dirs: [seg.slice(0, spec.depth).join("/")] });
    }
  }

  // API version directories and generic buckets are not product capabilities
  const NOT_A_FEATURE = new Set(["v1","v2","v3","api","concerns","base","common","shared","utils","helpers","lib","index"]);
  for (const k of [...features.keys()]) {
    const f = features.get(k);
    if (NOT_A_FEATURE.has(k) && !f.sources.some(x => x !== "directory")) features.delete(k);
  }

  // a lone file is not a feature; require some substance unless a doc named it
  for (const [k, c] of dirCount) {
    const f = features.get(k);
    if (c < 3 && f && f.sources.length === 1 && f.sources[0] === "directory") features.delete(k);
  }
  return features.size;
}

async function main() {
  const t0 = Date.now();
  const sha = git("rev-parse", ref).trim();
  const repoName = path.basename(repoDir);
  const repoId = await upsertRepo("procol", repoName, repoName.includes("backend") ? "monolith" : "spa");
  if (!await one(`select 1 from ckg.commits where repo_id=$1 and sha=$2`, [repoId, hex(sha)]))
    throw new Error(`index ${repoName} at ${sha.slice(0, 10)} first`);

  const cfg = REPO_CONFIG[repoName] ?? { docs: ["CODEBASE_INDEX.md"], featureDirs: [], mcpTools: false };
  const nIdx = fromCodebaseIndex(sha, cfg), nMcp = cfg.mcpTools ? fromMcpTools(sha) : 0, nDir = fromDirectories(sha, cfg);

  // A directory-derived feature that duplicates a documented one ("purchase_request" vs
  // "purchase_request_management") reads as broken to a non-engineer. Fold the weaker into
  // the documented one, keeping its dirs so the IMPLEMENTS edges survive.
  // Two sources can name the same capability differently: mcp_tools calls it "purchase_request",
  // CODEBASE_INDEX calls it "Purchase Request Management". Showing both reads as broken to a
  // non-engineer. Fold the shorter slug into the longer one when one strictly contains the other
  // at a word boundary, and keep the longer (usually documented) display name.
  let merged = 0;
  const rank = (f) => (f.sources.includes("CODEBASE_INDEX") ? 2 : 0) + (f.sources.includes("mcp_tools") ? 1 : 0);
  for (const [k, f] of [...features]) {
    if (!features.has(k)) continue;
    const host = [...features.values()].find(d => d.key !== k && features.has(d.key) &&
      (d.key.startsWith(k + "_") || d.key.endsWith("_" + k)) && d.key.length > k.length);
    if (!host) continue;
    const keepName = rank(host) >= rank(f) ? host.name : f.name;
    addFeature(host.key, { name: keepName, dirs: f.dirs, sources: f.sources,
                           bullets: f.bullets, keyModels: f.keyModels, mcpTools: host.mcpTools ?? f.mcpTools,
                           doc: host.doc ?? f.doc, docLine: host.docLine ?? f.docLine });
    features.delete(k); merged++;
  }
  if (merged) console.log(`merged ${merged} directory features into documented ones`);
  console.log(`features: ${nIdx} from CODEBASE_INDEX, ${nMcp} mcp_tool modules, ${features.size} total after directories`);

  // ---------- people + activity from git
  const log = git("log", `--since=${SINCE}`, "--format=%H%x00%ae%x00%an%x00%aI", "--name-only", sha);
  const people = new Map();          // email -> {name, commits, files:Map<path,n>, last}
  const fileActivity = new Map();    // path -> {n, last, authors:Set}
  let cur = null;
  for (const line of log.split("\n")) {
    if (line.includes("\0")) {
      const [, email, name, when] = line.split("\0");
      cur = people.get(email) || { email, name, commits: 0, files: new Map(), last: when };
      cur.commits++; if (when > cur.last) cur.last = when;
      people.set(email, cur); continue;
    }
    if (!line.trim() || !cur) continue;
    cur.files.set(line, (cur.files.get(line) || 0) + 1);
    const fa = fileActivity.get(line) || { n: 0, last: cur.last, authors: new Set() };
    fa.n++; fa.authors.add(cur.email); if (cur.last > fa.last) fa.last = cur.last;
    fileActivity.set(line, fa);
  }
  console.log(`git: ${people.size} contributors, ${fileActivity.size} files touched since ${SINCE}`);

  // ---------- insert FEATURE + PERSON entities
  const ents = [];
  for (const f of features.values()) {
    ents.push({ kind: "FEATURE", fqn: `be:feature:${f.key}`, name: f.name, path: f.doc ?? null,
                line: f.docLine ?? null,
                attrs: { key: f.key, sources: f.sources, bullets: f.bullets.slice(0, 12),
                         key_models: f.keyModels, dirs: f.dirs.slice(0, 40),
                         mcp_tools: (f.mcpTools || []).map((t) => ({ name: t.name, title: t.title, description: t.desc, phases: t.phases })) },
                extractor: "concepts@1.0", confidence: f.sources.includes("directory") && f.sources.length === 1 ? 0.7 : 1.0,
                resolution: f.sources.includes("CODEBASE_INDEX") || f.sources.includes("mcp_tools") ? "DOCUMENTED" : "HEURISTIC" });
  }
  for (const p of people.values()) {
    ents.push({ kind: "PERSON", fqn: `person:${p.email}`, name: p.name, path: null, line: null,
                attrs: { email: p.email, commits: p.commits, last_commit: p.last, files_touched: p.files.size },
                extractor: "concepts@1.0/git", confidence: 1.0, resolution: "VCS" });
  }
  for (let i = 0; i < ents.length; i += 500) {
    const b = ents.slice(i, i + 500);
    await q(`insert into ckg.entities (repo_id, commit_sha, kind, fqn, name, path, start_line, attrs, status, extractor, confidence, resolution)
             select $1, $2, u.kind::ckg.entity_kind_t, u.fqn, u.name, u.path, u.line, u.attrs, 'OBSERVED', u.extractor, u.confidence, u.resolution::ckg.resolution_t
               from unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::int[],$8::jsonb[],$9::text[],$10::numeric[],$11::text[])
                 as u(kind,fqn,name,path,line,attrs,extractor,confidence,resolution)
             on conflict do nothing`,
      [repoId, hex(sha), b.map(e=>e.kind), b.map(e=>e.fqn), b.map(e=>e.name), b.map(e=>e.path), b.map(e=>e.line),
       b.map(e=>JSON.stringify(e.attrs)), b.map(e=>e.extractor), b.map(e=>e.confidence), b.map(e=>e.resolution)]);
  }
  console.log(`entities: ${ents.filter(e=>e.kind==='FEATURE').length} FEATURE, ${ents.filter(e=>e.kind==='PERSON').length} PERSON`);

  // ---------- edges: FEATURE -IMPLEMENTS-> code, PERSON -OWNS-> code
  const idRows = await q(`select id, fqn, kind::text, path, attrs from ckg.entities where repo_id=$1 and commit_sha=$2`, [repoId, hex(sha)]);
  const byFqn = new Map(idRows.map(r => [r.fqn, r.id]));
  // Any path-bearing code node is a valid IMPLEMENTS target. The backend has SYMBOL/FILE/HANDLER;
  // the frontends currently only have HTTP_CALL_SITE, because no JS AST extractor exists yet.
  const CODE_KINDS = ["SYMBOL", "FILE", "HANDLER", "HTTP_CALL_SITE", "UI_COMPONENT", "UI_ROUTE", "STATE_ACTION", "SERVER_ROUTE"];
  const codeByPath = new Map();      // path -> [rows]
  for (const r of idRows) if (r.path && CODE_KINDS.includes(r.kind)) {
    if (!codeByPath.has(r.path)) codeByPath.set(r.path, []);
    codeByPath.get(r.path).push(r);
  }
  const { createHash } = await import("node:crypto");
  const sh = (s) => hex(createHash("sha1").update(s).digest("hex"));
  const edges = [];

  for (const f of features.values()) {
    const fid = byFqn.get(`be:feature:${f.key}`); if (!fid) continue;
    const targets = new Set();
    for (const d of f.dirs) for (const [p, rows] of codeByPath) if (p.startsWith(d + "/") || p === d) rows.forEach(r => targets.add(r.id));
    for (const m of f.keyModels) { const id = byFqn.get(`be:sym:${m}`); if (id) targets.add(id); }
    for (const t of targets) edges.push({ kind: "IMPLEMENTS", src: fid, dst: t, siteHash: sh(`${f.key}|${t}`),
                                          confidence: 0.9, resolution: "DOCUMENTED", extractor: "concepts@1.0", attrs: {} });
  }
  for (const p of people.values()) {
    const pid = byFqn.get(`person:${p.email}`); if (!pid) continue;
    const top = [...p.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
    for (const [file, n] of top) for (const r of codeByPath.get(file) ?? [])
      edges.push({ kind: "OWNS", src: pid, dst: r.id, siteHash: sh(`${p.email}|${r.id}`),
                   confidence: Math.min(0.95, 0.5 + n / 20), resolution: "VCS", extractor: "concepts@1.0/git",
                   attrs: { commits_touching: n, last_commit: p.last } });
  }
  for (let i = 0; i < edges.length; i += 1000) {
    const b = edges.slice(i, i + 1000);
    await q(`insert into ckg.edges (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, status, extractor, confidence, resolution, attrs)
             select $1,$2,u.kind::ckg.edge_kind_t,u.src,u.dst,u.site_hash,'OBSERVED',u.extractor,u.confidence,u.resolution::ckg.resolution_t,u.attrs
               from unnest($3::text[],$4::bigint[],$5::bigint[],$6::bytea[],$7::text[],$8::numeric[],$9::text[],$10::jsonb[])
                 as u(kind,src,dst,site_hash,extractor,confidence,resolution,attrs)
             on conflict do nothing`,
      [repoId, hex(sha), b.map(e=>e.kind), b.map(e=>e.src), b.map(e=>e.dst), b.map(e=>e.siteHash),
       b.map(e=>e.extractor), b.map(e=>e.confidence), b.map(e=>e.resolution), b.map(e=>JSON.stringify(e.attrs))]);
  }
  const ek = edges.reduce((a,e)=>(a[e.kind]=(a[e.kind]||0)+1,a),{});
  console.log(`edges: ${JSON.stringify(ek)}`);

  // ---------- activity onto FILE/SYMBOL attrs, so "what is hot" is a query
  let touched = 0;
  for (const [file, fa] of fileActivity) {
    const r = await q(`update ckg.entities set attrs = attrs || jsonb_build_object('activity',
                          jsonb_build_object('commits_12mo',$3::int,'last_commit',$4::text,'authors',$5::int))
                        where repo_id=$1 and commit_sha=$2 and path=$6 returning id`,
                      [repoId, hex(sha), fa.n, fa.last, fa.authors.size, file]);
    touched += r.length;
  }
  console.log(`activity stamped on ${touched} entity rows`);

  // A FEATURE's own path is its doc file, so path-based activity is meaningless for it.
  // Aggregate over the code it IMPLEMENTS -- that is the real "is this being built now" signal.
  const fa = await q(
    `with agg as (
       select f.id,
              -- sum of per-file touch counts, not distinct commits: one commit spanning 40
              -- files in this feature contributes 40. Ranks activity correctly; is not a commit count.
              sum((t.attrs->'activity'->>'commits_12mo')::int)       as commits,
              max(t.attrs->'activity'->>'last_commit')               as last_commit,
              count(distinct t.id) filter (where t.attrs ? 'activity') as active_nodes,
              count(distinct t.id)                                    as nodes
         from ckg.entities f
         join ckg.edges g on g.src_entity_id = f.id and g.kind = 'IMPLEMENTS'
         join ckg.entities t on t.id = g.dst_entity_id
        where f.repo_id = $1 and f.commit_sha = $2 and f.kind = 'FEATURE'
        group by f.id)
     update ckg.entities e
        set attrs = e.attrs || jsonb_build_object('activity', jsonb_build_object(
              'file_touches_12mo', coalesce(agg.commits,0), 'last_commit', agg.last_commit,
              'code_nodes', agg.nodes, 'active_nodes', agg.active_nodes))
       from agg where e.id = agg.id returning e.id`,
    [repoId, hex(sha)]);
  console.log(`feature activity rolled up from code for ${fa.length} features`);
  console.log(`done in ${Date.now() - t0}ms`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
