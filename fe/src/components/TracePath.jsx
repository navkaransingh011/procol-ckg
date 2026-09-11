import React from "react";

const KIND_LABEL = {
  HTTP_CALL_SITE: "call site", HTTP_ENDPOINT: "endpoint", SERVER_ROUTE: "route", HANDLER: "handler",
  DB_TABLE: "table", EXTERNAL_SERVICE: "external", SYMBOL: "symbol", FEATURE: "feature",
  OBSERVED_DEFECT: "defect", CI_JOB: "ci job", PERSON: "person",
};
const kindLabel = (k) => KIND_LABEL[k] || String(k || "").toLowerCase().replace(/_/g, " ");

// Which side of the wire a hop lives on. The endpoint IS the wire, so it gets its own look.
const sideOf = (claim, ev) => {
  if (claim.kind === "HTTP_ENDPOINT") return "contract";
  if (ev?.repo === "procol-backend") return "backend";
  return "frontend";
};

const shortName = (claim, ev) => {
  if (ev?.path) {
    const file = ev.path.split("/").pop();
    return ev.line ? `${file}:${ev.line}` : file;
  }
  return claim.name || claim.text;
};

const where = (ev) => (ev?.path ? `${ev.path}${ev.line ? `:${ev.line}` : ""}` : "HTTP endpoint contract, no source file");

/**
 * The execution path as nodes joined by labelled connectors. Indigo is frontend, amber is
 * the Rails side, dashed grey is the wire between them: the colour change is the repo boundary.
 */
export default function TracePath({ claims, evidence }) {
  if (!claims?.length) return null;
  return (
    <div className="path">
      {claims.map((claim, i) => {
        const ev = evidence[(claim.evidence_ids || [])[0]];
        const side = sideOf(claim, ev);
        return (
          <span key={claim.id} className="hop" style={{ animationDelay: `${i * 60}ms` }}>
            {i > 0 && (
              <span className="edge">
                <span className="edge-label">{String(claim.edge || "").toLowerCase().replace(/_/g, " ")}</span>
                <span className="edge-line" />
              </span>
            )}
            <span className={`node node--${side}`} title={`${where(ev)}\n${ev?.repo || "shared"} · ${ev?.ref || ""}${ev?.commit ? ` · ${ev.commit}` : ""}${ev?.extractor ? `\n${ev.extractor}` : ""}`}>
              <span className="node-kind">{kindLabel(claim.kind)}</span>
              <span className="node-name">{shortName(claim, ev)}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}
