// Role policy: what a signed-in person may SEE. Every role's answer is worked out from the same facts, code included:
// a customer-success person deserves the answer the source proves, not a thinner one. The role decides presentation --
// which facts reach the browser as claims and evidence, whether paths and code names may appear in prose, whether
// source may be quoted -- and it is enforced here in the service, in three places: the facts handed to the writer are
// tagged and stripped of paths, every event to the browser is filtered, and code-shaped text that slips into prose or
// status lines is scrubbed. The prompt asks the writer to speak in product words; this module makes sure of it.
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
// EXTERNAL_SERVICE is business-facing: "it syncs to SAP" is something CS must be able to say.
const NON_CODE = new Set(["DOCUMENT", "FEATURE", "CONFIG", "CONFIGURATION", "PERSON", "TEAM", "OWNER", "CONCEPT", "COMPANY", "UI_ROUTE", "UI_ACTION",
                          "TEMPLATE", "APPROVAL_FLOW", "DATASOURCE", "VARIABLE", "SUMMARY", "OVERVIEW", "EXTERNAL_SERVICE"]);
const ENDPOINT_KINDS = new Set(["ENDPOINT", "ROUTE", "HTTP_CALL_SITE", "HTTP_ENDPOINT", "API", "SERVER_ROUTE"]);
const PATH_KEYS = new Set(["path", "line", "start_line", "end_line", "blob_sha", "file", "paths", "site", "scope"]);
// file paths with an extension (and optional :line), and bare directory paths under the usual roots
const PATH_RE = /`?(?:[\w.-]+\/)+[\w.-]+\.(?:yaml|rake|json|jsx|tsx|mjs|erb|yml|sql|rb|js|ts|md)(?::\d+(?:-\d+)?)?`?|`?\b(?:app|src|lib|config|db|spec|test|uploads)\/[\w./-]*[\w-]`?/g;
// code shapes that need no lookup to recognise: Ruby constants with :: or #method, HTTP verb + path, /api paths
const CODE_RE = [
  [/`?\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)+(?:[#.][a-z_][\w?!]*)?`?/g, "the system"],
  [/`?\b[A-Z][A-Za-z0-9]*#[a-z_][\w?!]*`?/g, "the system"],
  [/`?\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[\w/:*.{}-]+`?/g, "the API"],
  [/`?(?<![\w])\/(?:api|v\d)\/[\w/:*.{}-]+`?/g, "the API"],
];
const IN_THE_CODE_RE = /^[ \t]*(?:[-*]\s*)?(?:\*\*|_)?In the code:?(?:\*\*|_)?[^\n]*\n?/gim;

function hidesKind(kind, p) {
  if (NON_CODE.has(kind)) return false;
  if (ENDPOINT_KINDS.has(kind)) return !p.endpoints;
  return !p.code_names;
}

const genericFor = (kind) => (ENDPOINT_KINDS.has(kind) ? "the API" : kind === "DB_TABLE" ? "the database" : kind === "JOB" ? "a background job" : "the system");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tidy = (t) => t
  .replace(/`(the system|the API|the database|a background job|a file)`/g, "$1")
  .replace(/\b(the system|the API|the database|a background job|a file)(?:(?:,|\s+and|\s+or|\s*·)?\s+\1\b)+/g, "$1")
  .replace(/\b(the|a) (the|a) /g, "$1 ")
  .replace(/ {2,}/g, " ");

/** Scrub code shapes from prose or a status line: exact names the facts held (longest first), then the generic shapes. */
export function scrubCodeNames(text, names = []) {
  let t = String(text || "").replace(IN_THE_CODE_RE, "");
  for (const { name, kind } of [...names].sort((a, b) => b.name.length - a.name.length))
    t = t.replace(new RegExp(`\`?(?<![\\w:#./])${escapeRe(name)}(?![\\w?!])\`?`, "g"), genericFor(kind));
  for (const [re, rep] of CODE_RE) t = t.replace(re, rep);
  return tidy(t);
}

/**
 * The code names present in a set of facts, for exact scrubbing: names and fqns of hidden-kind nodes that look like
 * code (punctuation or a CamelCase hump). Plain single words such as "Bid" or "Proposal" are left alone -- they are
 * product words too, and removing them would garble the sentence.
 */
export function codeNamesIn(facts, p) {
  if (!p || p.code_names) return [];
  const out = new Map();
  const codey = (s) => typeof s === "string" && s.length >= 4 && /[:#./_]|[a-z][A-Z]/.test(s) && !/\s/.test(s);
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (typeof v.kind === "string" && hidesKind(v.kind, p)) for (const s of [v.name, v.fqn]) if (codey(s)) out.set(s, { name: s, kind: v.kind });
    if (typeof v.endpoint === "string" && !p.endpoints) out.set(v.endpoint, { name: v.endpoint, kind: "HTTP_ENDPOINT" });
    for (const val of Object.values(v)) walk(val);
  };
  walk(facts);
  return [...out.values()];
}

/** Deep copy with the role's view applied: code nodes dropped, path fields removed, path-like and code-like strings scrubbed. */
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
    if (typeof v === "string") {
      let s = v;
      if (!p.paths) s = s.replace(PATH_RE, "a file");
      if (!p.code_names) s = scrubCodeNames(s);
      return s;
    }
    return v;
  };
  return walk(value);
}

/** Only path fields and path-like strings removed; nodes and code text stay. Used for the writer's facts. */
function stripPaths(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, val] of Object.entries(v)) if (!PATH_KEYS.has(k)) o[k] = walk(val);
      return o;
    }
    return typeof v === "string" ? v.replace(PATH_RE, "a file") : v;
  };
  return walk(value);
}

/**
 * The facts the writer READS. Everything stays -- code lookups, source, greps, endpoint families -- because the
 * answer must be understood from the code whoever asks. What the role may not see is marked (may_show_*) so the
 * prompt writes in product words, and paths are stripped when the role may not see them. The prose is scrubbed
 * afterwards regardless (scrubCodeNames), so a slip in the writing never reaches the reader.
 */
export function redactFacts(facts, p) {
  if (isOpen(p)) return facts;
  const f = { ...facts, presentation: p.code_names ? "technical" : "plain",
              may_show_code: !!p.code_names, may_show_endpoints: !!p.endpoints, may_show_paths: !!p.paths, may_show_source: !!p.code_source };
  return p.paths ? f : stripPaths(f);
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
    case "triage": return redact(ev, p);
    case "flow": return p.code_names ? ev : { ...ev, steps: ev.steps.map((s) => (s.source === "code" || (s.ref && !["document", "config", "live"].includes(s.source))) ? { ...s, ref: null } : s) };
    case "token": case "status": case "unresolved": case "truncated": case "error": return redact(ev, p);
    default: return ev;   // intent, table (live platform rows are business data), done
  }
}

/** The answer style the role gets. The UI no longer chooses; the role does. */
export const styleFor = (p) => (p && p.style) || "simple";
