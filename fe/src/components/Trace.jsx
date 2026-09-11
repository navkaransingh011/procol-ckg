import React, { useEffect, useMemo, useState } from "react";
import { buildGraph } from "../lib/graph.js";
import FlowView from "./FlowView.jsx";
import GraphView from "./GraphView.jsx";
import TracePath from "./TracePath.jsx";
import EvidencePanel from "./EvidencePanel.jsx";

const MODES = [["flow", "Flow"], ["graph", "Graph"], ["list", "List"]];
const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };

/** The execution path with three renderings and one evidence panel shared by all of them. */
export default function Trace({ claims, evidence, defaultMode = "flow" }) {
  const [mode, setMode] = useState(() => read("ckg_trace_mode", defaultMode));
  const [selected, setSelected] = useState(null);
  const graph = useMemo(() => buildGraph(claims, evidence), [claims, evidence]);
  useEffect(() => { try { localStorage.setItem("ckg_trace_mode", mode); } catch { /* ignore */ } }, [mode]);
  useEffect(() => { setSelected(null); }, [claims.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!graph.nodes.length) return null;
  const node = graph.nodes.find((n) => n.id === selected) || null;
  const wide = mode !== "list";

  return (
    <div className={`trace${node ? " trace--with-panel" : ""}${wide ? "" : " trace--list"}`}>
      <div className="trace-head">
        <span className="label">Execution path · {graph.nodes.length} hop{graph.nodes.length === 1 ? "" : "s"}</span>
        <div className="seg seg--sm" role="tablist" aria-label="Path view">
          {MODES.map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={mode === v}
              className={`seg-btn${mode === v ? " seg-btn--on" : ""}`} onClick={() => setMode(v)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="trace-body">
        <div className="trace-view">
          {mode === "flow" && <FlowView graph={graph} selected={selected} onSelect={setSelected} />}
          {mode === "graph" && <GraphView graph={graph} selected={selected} onSelect={setSelected} />}
          {mode === "list" && <TracePath graph={graph} selected={selected} onSelect={setSelected} />}
        </div>
        <EvidencePanel node={node} onClose={() => setSelected(null)} />
      </div>
      {wide && (
        <div className="legend">
          <span><i className="sw sw--frontend" />frontend</span>
          <span><i className="sw sw--backend" />backend</span>
          <span><i className="sw sw--contract" />HTTP contract</span>
          {graph.rails.length > 0 && <span className="muted">merge rail = source hop not named by the service</span>}
        </div>
      )}
    </div>
  );
}
