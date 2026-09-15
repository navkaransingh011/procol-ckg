// PER-BLOB extractor: what a person SEES and CLICKS in the React dashboards. Screens (routes with their
// human names), the buttons / wizard steps / tabs / dialog titles inside each screen, and where a screen
// navigates next. This is the layer "go to Purchase Requisitions, click Add PO" lives in; the code layer
// (fe-http, be-*) says what happens after the click. Regex-based, cacheable by blob SHA.
export const NAME = "fe-screens";
export const VERSION = "0.6-regex";
export const NEEDS_COMMIT_FACTS = true;          // resolve() joins routes + labels + files of the same commit

const ROUTE_CFG = /(^|\/)src\/app\/routes\/routeConfigs\.js$/;
const ROUTE_CMP = /(^|\/)src\/app\/routes\/routeComponentsConfigs\.js$/;
const LABELS = /(^|\/)src\/translations\/en\.json$/;
const UI_FILE = /(^|\/)src\/(views|components|pages|screens|containers)\/.+\.(jsx|js|tsx)$/;

export function handles(p) {
  if (p.includes("node_modules") || /\.(test|spec|stories)\.(jsx?|tsx?)$/.test(p)) return false;
  return ROUTE_CFG.test(p) || ROUTE_CMP.test(p) || LABELS.test(p) || UI_FILE.test(p);
}

const lineIndex = (src) => { const starts = [0]; for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1); return (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; starts[m] <= idx ? (lo = m) : (hi = m - 1); } return lo + 1; }; };

/** `[ROUTE_KEYS.X]: { key, path, name, breadNav, component: Components.AsyncY, searchKeywords }` blocks. */
function extractRoutes(src) {
  const routes = [];
  const re = /\[ROUTE_KEYS\.([A-Z0-9_]+)\]\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } } }
    if (end < 0) break;
    const body = src.slice(m.index, end + 1);
    const get = (k) => (new RegExp(`\\b${k}\\s*:\\s*["']([^"']*)["']`).exec(body) || [])[1] || null;
    const list = (k) => { const b = new RegExp(`\\b${k}\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(body); if (!b) return []; return [...b[1].matchAll(/["']([^"']+)["']|name\s*:\s*["']([^"']+)["']/g)].map((x) => x[1] || x[2]).filter(Boolean); };
    const component = (/\bcomponent\s*:\s*(?:Components\.)?([A-Za-z0-9_]+)/.exec(body) || [])[1] || null;
    const routePath = get("path");
    if (!routePath) continue;
    routes.push({ route_key: m[1], permission: get("key"), path: routePath, name: get("name") || m[1], parents: list("breadNav").filter((n) => n !== get("name") && !n.startsWith(":") && !n.startsWith("/")), component, keywords: list("searchKeywords") });
  }
  return routes;
}

/** `export const AsyncX = lazy(() => import("../../views/x"))` -> { AsyncX: "src/views/x" } */
function extractComponents(src, filePath) {
  const base = filePath.split("/").slice(0, -1);
  const out = {};
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) {
    const parts = [...base];
    for (const seg of m[2].split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
    out[m[1]] = parts.join("/");
  }
  return out;
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else if (typeof v === "string" && v.length <= 120) out[key] = v;
  }
  return out;
}

const TAG_ROLE = [[/^<(?:Steps\.)?Step\b/, "step"], [/^<(?:Tabs\.)?TabPane\b/, "tab"], [/^<Menu\.Item\b/, "menu"], [/^<(?:Button|Dropdown\.Button|Radio\.Button|Popconfirm)\b/, "button"],
                  [/^<(?:Modal|Drawer|Card|PageHeader)\b/, "title"]];
const NOISE = new Set(["cancel", "close", "ok", "okay", "yes", "no", "back", "done", "loading", "error", "warning", "info", "success", "edit", "delete", "remove", "clear", "reset", "search", "filter", "sort", "view", "more", "less", "show", "hide", "apply", "select", "download", "upload", "copy", "add", "save"]);
/** The role of a t("...") call: the nearest enclosing JSX tag and, for props, the attribute it sits in. */
const roleAt = (src, idx) => {
  const before = src.slice(Math.max(0, idx - 400), idx);
  const tagStart = before.lastIndexOf("<");
  if (tagStart < 0) return null;
  const tag = before.slice(tagStart);
  const attr = /\b(placeholder|label|title|tab|text|btnText|buttonText|ctaText|actionText|okText)\s*=\s*\{?\s*$/.exec(before);
  if (attr && /^(text|btnText|buttonText|ctaText|actionText|okText)$/.test(attr[1])) return "button";     // <ProcolButton text={t("events.newEvent")} />
  if (attr && attr[1] !== "title") return attr[1] === "tab" ? "tab" : attr[1];
  for (const [re, role] of TAG_ROLE) if (re.test(tag)) return role === "title" ? (attr ? "title" : null) : role;
  if (attr) return "title";
  return null;
};

/** Buttons, steps, tabs, titles: as literal text or as t("key"); plus in-app navigations. */
function extractUi(src) {
  const lineOf = lineIndex(src);
  const tKeys = [], strings = [], navigations = [];
  for (const m of src.matchAll(/\b(?:i18next\.)?t\(\s*["']([a-zA-Z0-9_.]+)["']/g)) {
    const role = roleAt(src, m.index);
    tKeys.push({ key: m[1], role, line: lineOf(m.index) });
  }
  for (const m of src.matchAll(/<(?:Steps\.)?Step\b[^>]*\btitle=["']([^"']{2,60})["']/g)) strings.push({ text: m[1], role: "step", line: lineOf(m.index) });
  for (const m of src.matchAll(/<(?:Button|Dropdown\.Button|Radio\.Button)\b(?:[^>]|=>)*>(?:\s*<[A-Za-z][^>]*\/>)?\s*([A-Z][^<{}\n]{1,48}?)\s*</g)) strings.push({ text: m[1].trim(), role: "button", line: lineOf(m.index) });
  for (const m of src.matchAll(/<(?:Tabs\.)?TabPane\b[^>]*\btab=["']([^"']{2,50})["']/g)) strings.push({ text: m[1], role: "tab", line: lineOf(m.index) });
  for (const m of src.matchAll(/<(?:Modal|Drawer|Card|PageHeader|Popconfirm)\b[^>]*\btitle=["']([A-Z][^"']{2,60})["']/g)) strings.push({ text: m[1], role: "title", line: lineOf(m.index) });
  for (const m of src.matchAll(/<Menu\.Item\b(?:[^>]|=>)*>\s*([A-Z][^<{}\n]{1,40}?)\s*</g)) strings.push({ text: m[1].trim(), role: "menu", line: lineOf(m.index) });
  for (const m of src.matchAll(/(?:history\.push|navigate|router\.push)\(\s*[`"'](\/[A-Za-z0-9_\-/:]+)|\bpathname\s*:\s*[`"'](\/[A-Za-z0-9_\-/:]+)|\bto=\{?\s*[`"'](\/[A-Za-z0-9_\-/:]+)/g))
    navigations.push({ path: (m[1] || m[2] || m[3]).replace(/\/$/, ""), line: lineOf(m.index) });
  for (const m of src.matchAll(/(?:getRoute|generatePath)\(\s*ROUTE_KEYS\.([A-Z0-9_]+)|\bROUTES\.([A-Z0-9_]+)\.path\b/g))
    navigations.push({ route_key: m[1] || m[2], line: lineOf(m.index) });
  const imports = [];
  for (const m of src.matchAll(/import\s[^;]*?from\s+["']((?:\.{1,2}\/|(?:components|views|pages|containers|screens|app)\/)[^"']+)["']/g)) imports.push(m[1]);
  return { tKeys: tKeys.slice(0, 400), strings: strings.slice(0, 200), navigations: navigations.slice(0, 80), imports: imports.slice(0, 120) };
}

export function extract(buf, path) {
  const src = buf.toString("utf8");
  if (ROUTE_CFG.test(path)) return { schema: 1, path, routes: extractRoutes(src) };
  if (ROUTE_CMP.test(path)) return { schema: 1, path, components: extractComponents(src, path) };
  if (LABELS.test(path)) { try { return { schema: 1, path, labels: flatten(JSON.parse(src)) }; } catch { return { schema: 1, path, labels: {} }; } }
  return { schema: 1, path, ui: extractUi(src) };
}

const ENT = { amp: "&", apos: "'", quot: '"', nbsp: " ", lt: "<", gt: ">", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decodeEntities = (t) => String(t).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : (ENT[e.toLowerCase()] ?? m));
const humanKey = (k) => k.split(".").pop().replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
// "/orders/:id" matches "/orders/123" and also "/orders" (a template literal whose id part was dropped): trailing params may be absent
const routeMatches = (pattern, p) => { const a = pattern.split("/"), b = p.split("/"); if (b.length > a.length || b.length < 2) return false; return a.every((seg, i) => i >= b.length ? seg.startsWith(":") : seg.startsWith(":") || seg === b[i]); };

/**
 * Per commit: screens from the route table; every UI file is assigned to the screen whose view folder
 * contains it; its buttons/steps/tabs become UI_ACTION nodes under that screen; its API call sites (from
 * fe-http, same commit) hang off the screen; its navigations become NAVIGATES_TO edges between screens.
 */
export function resolve(facts, file, ctx) {
  const entities = [], edges = [];
  const all = ctx.factsFor?.(NAME) || new Map();               // path -> facts of this extractor, this commit
  let routesFacts = null, components = {}, labels = {};
  for (const [p, f] of all) { if (f.routes) routesFacts = f; if (f.components) components = f.components; if (f.labels) labels = f.labels; }
  const routes = routesFacts?.routes || [];
  const viewDirOf = (r) => { const imp = r.component && components[r.component]; if (!imp) return null; const segs = imp.split("/"); const last = segs[segs.length - 1]; return (segs.length > 1 && segs[segs.length - 2] === last) || /^[A-Z]/.test(last) === false && segs.length >= 3 && segs[segs.length - 2] !== "views" ? segs.slice(0, -1).join("/") : imp; };
  const screenFqn = (r) => `screen:${r.path}`;
  const ex = `${NAME}@${VERSION}`;

  if (facts.routes) {
    for (const r of facts.routes) {
      entities.push({ fqn: screenFqn(r), kind: "UI_ROUTE", name: r.name, path: file.path, blobSha: file.blobSha, startLine: null, endLine: null,
                      attrs: { route_path: r.path, permission: r.permission, parents: r.parents, keywords: r.keywords, component: r.component, view_dir: viewDirOf(r) },
                      status: "OBSERVED", extractor: ex, confidence: 0.95, resolution: "EXACT" });
    }
    return { entities, edges };
  }
  if (!facts.ui) return { entities, edges };

  // which screen owns this file: the route whose view folder is the longest prefix of the path; a shared component
  // (src/components/...) belongs to the screens whose files import it (two hops at most)
  const canon = (r) => (/\b(new|create|edit|quick-create|detail\/new)\b/.test(r.path) ? 0 : 1) * 2 + (r.path.includes(":") ? 1 : 0);   // "/orders/:id" beats "/orders/detail/new"
  const directOwner = (p) => { let o = null, len = -1; for (const r of routes) { const d = viewDirOf(r); if (d && (p === d || p.startsWith(d + "/") || p.startsWith(d + ".")) && (d.length > len || (d.length === len && canon(r) > canon(o)))) { o = r; len = d.length; } } return o; };
  if (!ctx._feScreens) {
    const importers = new Map();            // imported module path (no extension) -> [importer file paths]
    const strip = (p) => p.replace(/\.(jsx?|tsx?)$/, "").replace(/\/index$/, "");
    for (const [p, f] of all) for (const imp of f.ui?.imports || []) {
      const srcRoot = p.slice(0, p.indexOf("src/") + 3);                                 // "src" or "<pkg>/src"
      const segs = imp.startsWith(".") ? p.split("/").slice(0, -1) : srcRoot.split("/");   // absolute imports resolve from the src root
      for (const seg of imp.split("/")) { if (seg === "..") segs.pop(); else if (seg !== ".") segs.push(seg); }
      const key = strip(segs.join("/"));
      if (!importers.has(key)) importers.set(key, []);
      importers.get(key).push(p);
    }
    ctx._feScreens = { importers, strip, ownerCache: new Map() };
  }
  const ownerOf = (p, depth = 0) => {
    const c = ctx._feScreens.ownerCache; if (c.has(p)) return c.get(p);
    let o = directOwner(p);
    if (!o && depth < 2) {
      const key = ctx._feScreens.strip(p);
      const candidates = [...(ctx._feScreens.importers.get(key) || []), ...(ctx._feScreens.importers.get(key.split("/").slice(0, -1).join("/")) || [])];
      for (const imp of candidates) { o = ownerOf(imp, depth + 1); if (o) break; }
    }
    c.set(p, o); return o;
  };
  const owner = ownerOf(file.path);
  const viaImport = owner && !directOwner(file.path);
  const label = (t) => labels[t.key] || null;
  const seen = new Set();
  const actions = [];
  const placed = [];                                        // [{ line, fqn }] actions emitted from this file, for trigger lookup
  for (const t of facts.ui.tKeys) { if (!t.role || t.role === "placeholder" || t.role === "label") continue; const text = label(t); if (!text) continue; actions.push({ text, role: t.role, line: t.line, key: t.key }); }
  for (const s of facts.ui.strings) actions.push({ text: s.text, role: s.role, line: s.line, key: null });
  for (const a of actions) {
    const norm = decodeEntities(a.text).trim().replace(/\s+/g, " ");
    if (norm.length < 2 || NOISE.has(norm.toLowerCase()) || /\{\{|\}\}/.test(norm)) continue;
    const dedupe = `${a.role}:${norm.toLowerCase()}`;
    if (seen.has(dedupe)) continue; seen.add(dedupe);
    const fqn = `action:${file.path}#L${a.line}:${a.role}`;
    placed.push({ line: a.line, fqn, role: a.role });
    entities.push({ fqn, kind: "UI_ACTION", name: norm, path: file.path, blobSha: file.blobSha, startLine: a.line, endLine: a.line,
                    attrs: { role: a.role, i18n_key: a.key, screen: owner?.name || null, screen_path: owner?.path || null },
                    status: "OBSERVED", extractor: ex, confidence: a.key ? 0.9 : 0.75, resolution: a.key ? "EXACT" : "HEURISTIC" });
    if (owner) edges.push({ kind: "DECLARES", srcFqn: screenFqn(owner), dstFqn: fqn, siteHash: ctx.siteHash(`${file.path}:${a.line}:${a.role}:DECLARES`), startLine: a.line, confidence: viaImport ? 0.6 : 0.8, resolution: "HEURISTIC" });
  }
  // the screen's API calls: every call site fe-http found in a file this screen owns
  if (owner) {
    const http = ctx.factsFor?.("fe-http")?.get(file.path);
    for (const cs of (http?.callSites || []).slice(0, 40))
      edges.push({ kind: "ISSUES_HTTP", srcFqn: screenFqn(owner), dstFqn: `fe:${file.path}#L${cs.line}`, siteHash: ctx.siteHash(`${file.path}:${cs.line}:ISSUES_HTTP`), startLine: cs.line, confidence: 0.7, resolution: "HEURISTIC" });
    for (const n of facts.ui.navigations) {
      const target = n.route_key ? routes.find((r) => r.route_key === n.route_key) : routes.find((r) => routeMatches(r.path, n.path));
      if (target && target.path !== owner.path) {
        edges.push({ kind: "NAVIGATES_TO", srcFqn: screenFqn(owner), dstFqn: screenFqn(target), siteHash: ctx.siteHash(`${file.path}:${n.line}:NAV`), startLine: n.line, confidence: 0.8, resolution: "HEURISTIC" });
        // the button/menu item nearest above the navigation in the same file is the click that takes you there
        const trigger = placed.filter((a) => (a.role === "button" || a.role === "menu") && a.line <= n.line && n.line - a.line <= 80).sort((x, y) => y.line - x.line)[0];
        if (trigger) edges.push({ kind: "NAVIGATES_TO", srcFqn: trigger.fqn, dstFqn: screenFqn(target), siteHash: ctx.siteHash(`${file.path}:${n.line}:${trigger.line}:NAVA`), startLine: n.line, confidence: 0.6, resolution: "HEURISTIC" });
      }
    }
  }
  return { entities, edges };
}
