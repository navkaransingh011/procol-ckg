#!/usr/bin/env node
// Import the teammate's procol_knowledge_base (Ruby AST + TracePoint runtime traces)
// into the ckg graph, tagged with the commit it was built from.
//
// What we take:  methods/classes/modules -> SYMBOL, columns -> DB_TABLE.attrs.columns,
//                ci_jobs -> CI_JOB, jbuilder/dockerfiles/workflows -> FILE, defects ->
//                OBSERVED_DEFECT, runtime `calls` -> CALLS (resolution RUNTIME).
// What we skip:  their routes (592 raw lines; ours are the full 5x expansion, 790 actions).
// What we add:   HANDLER --DECLARES--> SYMBOL, so a trace from the frontend walks straight
//                into the runtime-verified call graph without a join step.
//
// Usage: KB_DATABASE_URL=postgres://localhost/procol_knowledge_base node src/import-kb.mjs
import pg from "pg";
import { createHash } from "node:crypto";
import { q, one, hex, upsertRepo, upsertCommit, pool } from "./db.mjs";

const src = new pg.Pool({ connectionString: process.env.KB_DATABASE_URL || "postgres://localhost/procol_knowledge_base" });
const sq = async (sql, p = []) => (await src.query(sql, p)).rows;
const sha1 = (s) => hex(createHash("sha1").update(s).digest("hex"));

// "api/v1/trade" -> "Api::V1::TradeController"  (Rails camelize + constantize convention)
const controllerClass = (path) =>
  path.split("/").map((seg) => seg.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("")).join("::") + "Controller";

const ENT_SQL = `
  insert into ckg.entities (repo_id, commit_sha, kind, fqn, name, path, start_line, end_line, attrs,
                            status, extractor, confidence, resolution)
  select $1, $2, u.kind::ckg.entity_kind_t, u.fqn, u.name, u.path, u.line, u.line_end, u.attrs,
         'OBSERVED', u.extractor, u.confidence, u.resolution::ckg.resolution_t
    from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::jsonb[],
                $10::text[], $11::numeric[], $12::text[])
      as u(kind, fqn, name, path, line, line_end, attrs, extractor, confidence, resolution)
  on conflict do nothing`;

async function insertEntities(repoId, sha, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    const b = rows.slice(i, i + 1000);
    await q(ENT_SQL, [repoId, hex(sha),
      b.map(r => r.kind), b.map(r => r.fqn), b.map(r => r.name), b.map(r => r.path),
      b.map(r => r.line ?? null), b.map(r => r.lineEnd ?? null), b.map(r => JSON.stringify(r.attrs ?? {})),
      b.map(r => r.extractor), b.map(r => r.confidence), b.map(r => r.resolution)]);
  }
}

async function main() {
  const t0 = Date.now();
  const [meta] = await sq(`select repo, commit_sha, branch, count(*)::int n from entities group by 1,2,3`);
  const sha = meta.commit_sha;
  console.log(`source: ${meta.repo}@${meta.branch} ${sha.slice(0, 10)}  (${meta.n} entities)`);

  const repoId = await upsertRepo("procol", "procol-backend", "monolith");
  const commit = await one(`select 1 from ckg.commits where repo_id=$1 and sha=$2`, [repoId, hex(sha)]);
  if (!commit) throw new Error(`index the backend at ${sha} first (node src/index-commit.mjs --ref ${sha} --as main)`);

  const ents = await sq(`select id, kind, name, file_path, line_start, line_end, metadata, discovered_via from entities`);
  const byId = new Map(ents.map(e => [e.id, e]));
  const out = [];
  const fqnOf = new Map();       // their uuid -> our fqn
  const columnsByTable = new Map();

  for (const e of ents) {
    let row = null;
    const base = { path: e.file_path, line: e.line_start, lineEnd: e.line_end, extractor: "kb-import@1.0/ruby-ast", confidence: 1.0, resolution: "EXACT" };
    switch (e.kind) {
      case "method": case "class_method":
        row = { ...base, kind: "SYMBOL", fqn: `be:sym:${e.name}`, name: e.name,
                attrs: { subkind: e.kind, class: e.name.split(/[#.]/)[0] } }; break;
      case "class": case "module":
        row = { ...base, kind: "SYMBOL", fqn: `be:sym:${e.name}`, name: e.name, attrs: { subkind: e.kind } }; break;
      case "column": {
        const t = e.metadata?.table; if (!t) break;
        if (!columnsByTable.has(t)) columnsByTable.set(t, []);
        columnsByTable.get(t).push({ name: e.name.split(".").pop(), type: e.metadata?.column_type }); break; }
      case "ci_job":
        row = { ...base, kind: "CI_JOB", fqn: `be:ci:${e.name}`, name: e.name, attrs: { ...e.metadata, workflow: e.name.split("::")[0] } }; break;
      case "workflow": case "dockerfile": case "api_response_template":
        row = { ...base, kind: "FILE", fqn: `be:file:${e.file_path}`, name: e.name, attrs: { subkind: e.kind === "api_response_template" ? "jbuilder" : e.kind } }; break;
      case "tool_definition":
        row = { ...base, kind: "SYMBOL", fqn: `be:sym:mcp:${e.name}`, name: e.name, attrs: { subkind: "mcp_tool", ...e.metadata } }; break;
      case "external_dependency":
        row = { ...base, kind: "EXTERNAL_SERVICE", fqn: `be:external:${e.name}`, name: e.name, attrs: { subkind: "github_action" } }; break;
      case "observed_defect":
        row = { ...base, kind: "OBSERVED_DEFECT", fqn: `be:defect:${e.name}`, name: e.name, attrs: e.metadata ?? {},
                extractor: `kb-import@1.0/${e.discovered_via || "runtime"}`, resolution: "RUNTIME", confidence: 1.0 }; break;
      default: break; // route: skipped on purpose, ours are more complete
    }
    if (row) { out.push(row); fqnOf.set(e.id, row.fqn); }
  }
  await insertEntities(repoId, sha, out);
  const kinds = out.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {});
  console.log(`entities imported: ${out.length}  ${JSON.stringify(kinds)}`);

  // columns: enrich our DB_TABLE rows (created by be-schema at this same commit)
  let colTables = 0;
  for (const [table, cols] of columnsByTable) {
    const r = await q(`update ckg.entities set attrs = attrs || jsonb_build_object('columns', $3::jsonb)
                        where repo_id=$1 and commit_sha=$2 and kind='DB_TABLE' and name=$4 returning id`,
                      [repoId, hex(sha), JSON.stringify(cols), table]);
    if (r.length) colTables++;
  }
  console.log(`columns attached to ${colTables}/${columnsByTable.size} tables`);

  // id map for edges
  const idRows = await q(`select id, fqn, kind::text, attrs from ckg.entities where repo_id=$1 and commit_sha=$2`, [repoId, hex(sha)]);
  const idOf = new Map(idRows.map(r => [r.fqn, r.id]));

  // relationships
  const rels = await sq(`select from_entity_id, to_entity_id, rel_type, confidence, evidence from relationships`);
  const edges = [];
  for (const r of rels) {
    const a = fqnOf.get(r.from_entity_id), b = fqnOf.get(r.to_entity_id);
    if (!a || !b || !idOf.has(a) || !idOf.has(b)) continue;
    const ev = r.evidence || {};
    if (r.rel_type === "calls") {
      edges.push({ kind: "CALLS", src: idOf.get(a), dst: idOf.get(b), line: ev.line ?? null,
                   siteHash: sha1(`${a}|${b}|${ev.file}|${ev.line}`), confidence: 0.95, resolution: "RUNTIME",
                   extractor: `tracepoint@${ev.source || "runtime"}`, attrs: { receiver_class: ev.receiver_class, file: ev.file } });
    } else if (r.rel_type === "depends_on") {
      edges.push({ kind: "USES_SERVICE", src: idOf.get(a), dst: idOf.get(b), line: null,
                   siteHash: sha1(`${a}|${b}|dep`), confidence: 1.0, resolution: "EXACT", extractor: "kb-import@1.0/gha", attrs: {} });
    } else {
      // Normalise direction: code --TRIGGERS_DEFECT--> defect, whichever way they stored it,
      // so a forward trace through the code reaches the bug.
      const aIsDefect = byId.get(r.from_entity_id)?.kind === "observed_defect";
      const [codeF, defF] = aIsDefect ? [b, a] : [a, b];
      edges.push({ kind: "TRIGGERS_DEFECT", src: idOf.get(codeF), dst: idOf.get(defF), line: ev.line ?? null,
                   siteHash: sha1(`${codeF}|${defF}|${r.rel_type}`), confidence: 1.0, resolution: "RUNTIME",
                   extractor: "kb-import@1.0/runtime", attrs: { rel_type: r.rel_type, ...ev } });
    }
  }

  // class/module --DECLARES--> each of its methods. Their DB stored methods and classes
  // as unrelated rows; without this edge a trace from a class goes nowhere.
  let declared = 0;
  for (const r of idRows) {
    if (r.kind !== "SYMBOL" || !["method", "class_method"].includes(r.attrs.subkind)) continue;
    const owner = idOf.get(`be:sym:${r.attrs.class}`);
    if (!owner) continue;
    edges.push({ kind: "DECLARES", src: owner, dst: r.id, line: null, siteHash: sha1(`${r.attrs.class}|${r.fqn}`),
                 confidence: 1.0, resolution: "EXACT", extractor: "kb-import@1.0/ruby-ast", attrs: { via: "class_owns_method" } });
    declared++;
  }
  console.log(`class -> method DECLARES edges: ${declared}`);

  // the bridge: HANDLER (ours, from routes) --DECLARES--> SYMBOL (theirs, the Ruby method)
  let linked = 0, unlinked = [];
  for (const h of idRows.filter(r => r.kind === "HANDLER")) {
    const klass = controllerClass(h.attrs.controller);
    const symFqn = `be:sym:${klass}#${h.attrs.action}`;
    if (idOf.has(symFqn)) {
      edges.push({ kind: "DECLARES", src: h.id, dst: idOf.get(symFqn), line: null,
                   siteHash: sha1(`${h.fqn}|${symFqn}`), confidence: 0.95, resolution: "EXACT", extractor: "kb-link@1.0", attrs: {} });
      linked++;
    } else unlinked.push(`${h.attrs.controller}#${h.attrs.action}`);
  }

  // A defect nobody linked is invisible to every trace. Their title names the method
  // ("S3Upload#upload_excel_to_s3: real network call ...") -- link it, but as HEURISTIC:
  // derived from a name, not observed in execution, and the confidence says so.
  let orphansLinked = 0;
  const linkedDefects = new Set(edges.filter(e => e.kind === "TRIGGERS_DEFECT").map(e => e.dst));
  for (const d of idRows.filter(r => r.kind === "OBSERVED_DEFECT" && !linkedDefects.has(r.id))) {
    const m = d.fqn.replace(/^be:defect:/, "").match(/^([A-Z][\w:]*[#.][\w?!]+)/);
    const sym = m && idOf.get(`be:sym:${m[1]}`);
    if (!sym) continue;
    edges.push({ kind: "TRIGGERS_DEFECT", src: sym, dst: d.id, line: null, siteHash: sha1(`${m[1]}|${d.fqn}|name_prefix`),
                 confidence: 0.8, resolution: "HEURISTIC", extractor: "kb-link@1.0/name-prefix",
                 attrs: { rel_type: "contains_defect", via: "defect title names the method; not execution-linked in source DB" } });
    orphansLinked++;
  }
  console.log(`orphan defects linked by name (HEURISTIC): ${orphansLinked}`);

  for (let i = 0; i < edges.length; i += 1000) {
    const b = edges.slice(i, i + 1000);
    await q(`insert into ckg.edges (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, start_line,
                                    status, extractor, confidence, resolution, attrs)
             select $1, $2, u.kind::ckg.edge_kind_t, u.src, u.dst, u.site_hash, u.line, 'OBSERVED',
                    u.extractor, u.confidence, u.resolution::ckg.resolution_t, u.attrs
               from unnest($3::text[], $4::bigint[], $5::bigint[], $6::bytea[], $7::int[], $8::text[], $9::numeric[], $10::text[], $11::jsonb[])
                 as u(kind, src, dst, site_hash, line, extractor, confidence, resolution, attrs)
             on conflict do nothing`,
      [repoId, hex(sha), b.map(e => e.kind), b.map(e => e.src), b.map(e => e.dst), b.map(e => e.siteHash), b.map(e => e.line),
       b.map(e => e.extractor), b.map(e => e.confidence), b.map(e => e.resolution), b.map(e => JSON.stringify(e.attrs))]);
  }
  const ek = edges.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {});
  console.log(`edges imported: ${edges.length}  ${JSON.stringify(ek)}`);
  console.log(`handlers bridged to Ruby methods: ${linked} linked, ${unlinked.length} without a matching method`);
  if (unlinked.length) console.log(`  e.g. ${unlinked.slice(0, 5).join(", ")}`);
  console.log(`done in ${Date.now() - t0}ms`);
  await src.end(); await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
