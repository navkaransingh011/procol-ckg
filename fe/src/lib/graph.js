// Shared shape-building for every trace view (flow, graph, list, evidence panel).
// Claims arrive in depth order with the edge kind that led to them but no parent id, so the
// tree is reconstructed honestly: a connector is only drawn from a specific parent when there is
// exactly one candidate (or the service names one via `parent`/`from`); otherwise the layouts
// show a merge rail between the two depth columns instead of inventing a source.

export const KIND_LABEL = {
  HTTP_CALL_SITE: "call site", HTTP_ENDPOINT: "endpoint", SERVER_ROUTE: "route", HANDLER: "handler",
  DB_TABLE: "table", EXTERNAL_SERVICE: "external", SYMBOL: "symbol", FEATURE: "feature",
  OBSERVED_DEFECT: "defect", CI_JOB: "ci job", PERSON: "person", FILE: "file", MODULE: "module",
};
export const kindLabel = (k) => KIND_LABEL[k] || String(k || "").toLowerCase().replace(/_/g, " ");
export const edgeLabel = (e) => String(e || "").toLowerCase().replace(/_/g, " ");

/** Which side of the wire a hop lives on. The endpoint IS the wire, so it gets its own look. */
export const sideOf = (claim, ev) => {
  if (claim.kind === "HTTP_ENDPOINT") return "contract";
  if (claim.kind === "DOCUMENT") return "doc"; // business document passage: intent, not proof
  if (ev?.repo === "procol-backend") return "backend";
  return "frontend";
};

export const evidenceOf = (claim, evidence) => evidence?.[(claim.evidence_ids || [])[0]] || null;

export const shortName = (claim, ev) => {
  const path = ev?.path || claim.path;
  if (path) {
    const file = path.split("/").pop();
    const line = ev?.line || claim.line;
    return line ? `${file}:${line}` : file;
  }
  return claim.name || claim.text || "";
};

export const whereOf = (claim, ev) => {
  const path = ev?.path || claim.path;
  if (!path) return claim.kind === "DOCUMENT" ? "uploaded document" : "HTTP endpoint contract, no source file";
  const line = ev?.line || claim.line;
  return line ? `${path}:${line}` : path;
};

/**
 * Build the view model: nodes (one per claim, in order) grouped into depth columns, and links.
 * Links carry `certain: true` when the source is known; ambiguous hops become a `rails` entry
 * describing which two columns are joined by a merge rail.
 */
export function buildGraph(claims = [], evidence = {}) {
  const nodes = claims.map((claim, i) => {
    const ev = evidenceOf(claim, evidence);
    return {
      id: claim.id, index: i, claim, ev,
      depth: Math.max(0, Number(claim.depth) || 0),
      side: sideOf(claim, ev),
      kind: kindLabel(claim.kind),
      label: shortName(claim, ev),
      title: claim.name || claim.text || "",
      entityId: (claim.evidence_ids || [])[0],
    };
  });

  const byEntity = new Map(nodes.filter((n) => n.entityId != null).map((n) => [String(n.entityId), n]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const columns = [];
  for (const n of nodes) (columns[n.depth] ||= []).push(n);
  for (let d = 0; d < columns.length; d++) columns[d] ||= [];

  const links = [];
  const rails = [];
  for (let d = 1; d < columns.length; d++) {
    const parents = columns[d - 1];
    let ambiguous = false;
    for (const n of columns[d]) {
      const named = n.claim.parent ?? n.claim.from ?? n.claim.parent_id;
      const explicit = named != null ? (byId.get(String(named)) || byEntity.get(String(named))) : null;
      if (explicit) links.push({ source: explicit, target: n, edge: n.claim.edge, certain: true });
      else if (parents.length === 1) links.push({ source: parents[0], target: n, edge: n.claim.edge, certain: true });
      else if (parents.length > 1) ambiguous = true;
    }
    if (ambiguous) rails.push({ depth: d, edges: [...new Set(columns[d].map((n) => n.claim.edge).filter(Boolean))] });
  }
  return { nodes, columns, links, rails };
}
