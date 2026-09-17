// PER-BLOB extractor: Rails routes.
// config/routes.rb is ONE blob, so the whole 4,460-route expansion caches on that
// blob's SHA -- it re-runs only when routes.rb itself changes.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = "be-routes";
// 1.2: `mount Engine => '/path'` arrives as KEYWORDS on Ruby 3, which raised inside the stub
//      and made every routes.rb expand to zero routes with a zero exit code. The version bump
//      is the cache invalidation: blob_facts is keyed by (blob, extractor, version), so the
//      empty results already stored under 1.1 are bypassed instead of having to be deleted.
// 1.1: Rails.env modelled -> env-gated routes now expand
export const VERSION = "1.2-mount-kwargs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function handles(p) {
  return p === "config/routes.rb";
}

export function extract(buf) {
  const dir = mkdtempSync(path.join(tmpdir(), "ckg-routes-"));
  const f = path.join(dir, "routes.rb");
  writeFileSync(f, buf);
  const out = execFileSync("ruby", [path.join(HERE, "be-routes.rb"), f], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return { schema: 1, ...JSON.parse(out) };
}

export function resolve(facts, file, ctx) {
  const entities = [], edges = [];
  if (!facts?.routes) return { entities, edges };

  // Deduplicate on controller#action, NOT on route row. The same action is reachable
  // through 5 subdomain constraints; emit ONE handler and put the constraint on the
  // SERVES edge. Otherwise event_groups#participate appears five times.
  const handlers = new Map();

  for (const r of facts.routes) {
    if (!r.controller || !r.action) continue;
    const handlerFqn = `be:${r.controller}#${r.action}`;
    if (!handlers.has(handlerFqn)) {
      handlers.set(handlerFqn, true);
      entities.push({
        fqn: handlerFqn, kind: "HANDLER", name: `${r.controller}#${r.action}`,
        path: `app/controllers/${r.controller}_controller.rb`, blobSha: null,
        startLine: null, endLine: null,
        attrs: { controller: r.controller, action: r.action },
        status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
        confidence: 0.95, resolution: "FRAMEWORK_DUMP",
      });
    }

    const routeFqn = `be:${r.verb} ${r.path}`;
    entities.push({
      fqn: routeFqn, kind: "SERVER_ROUTE", name: r.path, path: "config/routes.rb",
      blobSha: file.blobSha, startLine: null, endLine: null,
      attrs: { verb: r.verb, raw_path: r.path, constraints: r.constraints, source: r.source },
      status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
      confidence: 1.0, resolution: "FRAMEWORK_DUMP",
    });

    // Both sides of the wire attach to the SAME repo-agnostic endpoint node.
    const norm = ctx.normalizeEndpoint(r.path.replace(/^\/api(?=\/|$)/, ""));
    const epFqn = `${r.verb} ${norm}`;
    entities.push({
      fqn: epFqn, kind: "HTTP_ENDPOINT", name: norm, path: null, blobSha: null,
      startLine: null, endLine: null, attrs: { method: r.verb, normalized: norm },
      status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
      confidence: 1.0, resolution: "EXACT", repoAgnostic: true,
    });

    edges.push({ kind: "SERVES", srcFqn: routeFqn, dstFqn: epFqn,
                 siteHash: ctx.siteHash(`routes:${r.verb}:${r.path}`), startLine: null,
                 confidence: 1.0, resolution: "FRAMEWORK_DUMP",
                 attrs: { constraints: r.constraints } });
    edges.push({ kind: "HANDLED_BY", srcFqn: routeFqn, dstFqn: handlerFqn,
                 siteHash: ctx.siteHash(`hb:${r.verb}:${r.path}`), startLine: null,
                 confidence: 0.95, resolution: "FRAMEWORK_DUMP" });
  }
  return { entities, edges };
}
