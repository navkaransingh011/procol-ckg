// PER-BLOB extractor: Ruby symbols (classes, modules, methods) via the stdlib AST.
// Replaces the one-off Ruby AST dump the graph was bootstrapped from, so a re-index of any
// backend commit regenerates every SYMBOL node itself. Identities match the import exactly:
//   be:sym:Api::V1::TradeController            (class / module)
//   be:sym:Api::V1::TradeController#quote_details   (instance method)
//   be:sym:CustomConfiguration.cached_all_configs   (class method)
// Batched: one Ruby process parses every changed file of a run (thousands on a cold start,
// a handful on a merge). Files the running Ruby cannot parse fall back to a line scanner and
// are marked HEURISTIC so answers can say so.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = "be-ast";
export const VERSION = "1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "be-ast.rb");

// What the bootstrap dump covered: app code, lib, migrations, one-off scripts. Not specs, config, vendor.
export function handles(p) {
  return /^(app|lib|db\/migrate|scripts|mcp_tools)\/.*\.rb$/.test(p) && !/^app\/(assets|views)\//.test(p);
}

/** items: [{sha, buf, path}] -> Map(sha -> {facts, ok, error}) */
export function extractBatch(items) {
  const input = items.map(it => JSON.stringify({ id: it.sha, path: it.path, b64: Buffer.from(it.buf).toString("base64") })).join("\n") + "\n";
  const r = spawnSync("ruby", [SCRIPT], { input, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) throw new Error(`be-ast.rb failed: ${(r.stderr || "").slice(0, 400)}`);
  const out = new Map();
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.ok) out.set(o.id, { ok: true, facts: { schema: 1, parser: o.parser, syntax_error: o.syntax_error, symbols: o.symbols, calls: o.calls, includes: o.includes } });
    else out.set(o.id, { ok: false, error: o.error, facts: { schema: 1, parser: "none", symbols: [], calls: [], includes: {} } });
  }
  for (const it of items) if (!out.has(it.sha)) out.set(it.sha, { ok: false, error: "no output from be-ast.rb", facts: { schema: 1, parser: "none", symbols: [], calls: [], includes: {} } });
  return out;
}

/** Single-blob form of the same thing, for callers that do not batch. */
export function extract(buf, p) {
  const r = extractBatch([{ sha: "one", buf, path: p }]).get("one");
  if (!r.ok) throw new Error(r.error);
  return r.facts;
}

// Rails' `underscore`: "Api::V1::ApprovalWorkflow::TradeController" -> "api/v1/approval_workflow/trade"
const underscore = (klass) => klass.replace(/Controller$/, "").split("::")
  .map(s => s.replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase()).join("/");

export function resolve(facts, file, ctx) {
  const entities = [], edges = [];
  if (!facts?.symbols) return { entities, edges };
  const heur = facts.parser === "regex";
  const includes = facts.includes || {};
  const seen = new Set();

  for (const s of facts.symbols) {
    if (!s.name || s.name.includes("?::") || seen.has(s.name)) continue;
    // A top-level `def` in a script has no owner and its name collides across files (get_config x4).
    // The bootstrap dump carried none of these; neither do we.
    if ((s.kind === "method" || s.kind === "class_method") && !s.owner) continue;
    seen.add(s.name);
    const fqn = `be:sym:${s.name}`;
    const attrs = { subkind: s.kind, parser: facts.parser };
    if (s.owner) attrs.class = s.owner;
    if (s.superclass) attrs.superclass = s.superclass;
    if ((s.kind === "class" || s.kind === "module") && includes[s.name]?.length) attrs.mixins = includes[s.name];
    entities.push({ fqn, kind: "SYMBOL", name: s.name, path: file.path, blobSha: file.blobSha,
                    startLine: s.line, endLine: s.end_line ?? null, attrs,
                    status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
                    confidence: heur ? 0.8 : 1.0, resolution: heur ? "HEURISTIC" : "EXACT" });

    if ((s.kind === "method" || s.kind === "class_method") && s.owner) {
      // class --DECLARES--> method. Same hash as the bootstrap import, so nothing duplicates on the pinned commit.
      edges.push({ kind: "DECLARES", srcFqn: `be:sym:${s.owner}`, dstFqn: fqn,
                   siteHash: ctx.siteHash(`${s.owner}|${fqn}`), startLine: null,
                   confidence: 1.0, resolution: heur ? "HEURISTIC" : "EXACT" });
      // HANDLER (from routes) --DECLARES--> the controller action that implements it.
      // Only lands if the routes extractor produced that handler (edges are filtered on both ends at load).
      if (s.kind === "method" && /Controller$/.test(s.owner)) {
        const handlerFqn = `be:${underscore(s.owner)}#${s.name.split("#").pop()}`;
        edges.push({ kind: "DECLARES", srcFqn: handlerFqn, dstFqn: fqn,
                     siteHash: ctx.siteHash(`${handlerFqn}|${fqn}`), startLine: null,
                     confidence: 0.95, resolution: "EXACT" });
      }
    }
  }

  // Static call edges are OFF by default: they are name-based guesses, and the graph's runtime
  // (observed) CALLS edges are the trustworthy ones. CKG_STATIC_CALLS=1 adds `Const.method` calls as HEURISTIC.
  if (process.env.CKG_STATIC_CALLS === "1") {
    for (const c of facts.calls || []) {
      if (!c.recv || !c.meth || !c.from) continue;
      edges.push({ kind: "CALLS", srcFqn: `be:sym:${c.from}`, dstFqn: `be:sym:${c.recv}.${c.meth}`,
                   siteHash: ctx.siteHash(`${c.from}|${c.recv}.${c.meth}|${c.line}`), startLine: c.line,
                   confidence: 0.7, resolution: "HEURISTIC" });
    }
  }
  return { entities, edges };
}
