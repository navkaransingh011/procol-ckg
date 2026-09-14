// Role policy: what a signed-in person may see. Enforced here in the service, in three places --
// which retrieval steps run, which facts reach the answer model, and which events reach the browser --
// so a restricted role cannot talk the model into showing code it was never given. The prompt is not the guard.
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../../config/roles.json", import.meta.url), "utf8"));
export const ROLES = Object.keys(cfg.roles);
export const DEFAULT_ROLE = cfg.default_role;

export function policyFor(role) {
  const key = cfg.roles[role] ? role : DEFAULT_ROLE;
  return { role: key, ...cfg.roles[key] };
}

/** Everything allowed: no filtering work at all. */
export const isOpen = (p) => !!(p && p.code_names && p.endpoints && p.paths && p.code_source);

/** Branches the role may read. Anything outside the list falls back to main. */
export function allowedRefs(p, refs) {
  if (!p || p.refs === "*") return refs;
  const ok = refs.filter((r) => p.refs.includes(r));
  return ok.length ? ok : [p.refs[0] || "main"];
}

// Node kinds that are business-facing, never code. Anything else with a `kind` is treated as code.
const NON_CODE = new Set(["DOCUMENT", "FEATURE", "CONFIG", "CONFIGURATION", "PERSON", "TEAM", "OWNER", "CONCEPT", "COMPANY",
                          "TEMPLATE", "APPROVAL_FLOW", "DATASOURCE", "VARIABLE", "SUMMARY", "OVERVIEW"]);
const ENDPOINT_KINDS = new Set(["ENDPOINT", "ROUTE", "HTTP_CALL_SITE", "HTTP_ENDPOINT", "API"]);
const PATH_KEYS = new Set(["path", "line", "start_line", "end_line", "blob_sha", "file", "paths", "site", "scope"]);
const PATH_RE = /`?(?:[\w.-]+\/)+[\w.-]+\.(?:rb|js|jsx|ts|tsx|mjs|erb|yml|yaml|rake|json|sql)(?::\d+(?:-\d+)?)?`?/g;

function hidesKind(kind, p) {
  if (NON_CODE.has(kind)) return false;
  if (ENDPOINT_KINDS.has(kind)) return !p.endpoints;
  return !p.code_names;
}

/** Deep copy with the role's view applied: code nodes dropped, path fields removed, path-like strings scrubbed. */
export function redact(value, p) {
  if (isOpen(p)) return value;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      if (typeof v.kind === "string" && hidesKind(v.kind, p)) return undefined;
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        if (!p.paths && PATH_KEYS.has(k)) continue;
        const w = walk(val);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    if (typeof v === "string" && !p.paths) return v.replace(PATH_RE, "a file");
    return v;
  };
  return walk(value);
}

/** The facts the answer model is allowed to read. Source and greps are whole sections; the rest is per node. */
export function redactFacts(facts, p) {
  if (isOpen(p)) return facts;
  const f = { ...facts };
  if (!p.code_source) { delete f.source; delete f.greps; delete f.live_config_greps; delete f.planned_sql; }
  if (!p.code_names) { delete f.upstream_callers; delete f.edge_chain; delete f.hubs_not_expanded; }
  if (!p.endpoints) delete f.endpoint_families;
  // a lookup is its anchor: when the anchor is a hidden code node, the whole lookup goes, not just the anchor field
  if (Array.isArray(f.lookups)) f.lookups = f.lookups.filter((l) => !(l?.anchor?.kind && hidesKind(l.anchor.kind, p)));
  return redact(f, p);
}

/** One event from the agent, as the role may see it. null = drop it. */
export function filterEvent(ev, p) {
  if (isOpen(p) || !ev) return ev;
  switch (ev.type) {
    case "context_paths": return p.paths ? ev : null;
    case "evidence":
      if (ev.extractor === "docs") return redact(ev, p);
      if (!p.code_names && !(p.endpoints && ev.kind && ENDPOINT_KINDS.has(ev.kind))) return null;
      return redact(ev, p);
    case "claim": return redact(ev, p) ?? null;
    case "token": case "status": case "unresolved": case "truncated": case "error": return redact(ev, p);
    default: return ev;   // intent, table (live platform rows are business data), done
  }
}

/** The answer style the role gets. The UI no longer chooses; the role does. */
export const styleFor = (p) => (p && p.style) || "simple";
