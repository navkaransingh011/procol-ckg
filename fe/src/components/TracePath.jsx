import React from "react";
import { edgeLabel, whereOf } from "../lib/graph.js";

/**
 * The compact list form of the path: nodes joined by labelled connectors. Indigo is frontend,
 * amber is the Rails side, dashed grey is the wire between them: the colour change is the repo boundary.
 */
export default function TracePath({ graph, selected, onSelect }) {
  if (!graph?.nodes?.length) return null;
  return (
    <div className="path">
      {graph.nodes.map((n, i) => (
        <span key={n.id} className="hop" style={{ animationDelay: `${i * 50}ms` }}>
          {i > 0 && (
            <span className="edge">
              <span className="edge-label">{edgeLabel(n.claim.edge)}</span>
              <span className="edge-line" />
            </span>
          )}
          <button type="button" className={`node node--${n.side}${selected === n.id ? " node--on" : ""}`}
            title={whereOf(n.claim, n.ev)} onClick={() => onSelect(selected === n.id ? null : n.id)}>
            <span className="node-kind">{n.kind}</span>
            <span className="node-name">{n.label}</span>
          </button>
        </span>
      ))}
    </div>
  );
}
