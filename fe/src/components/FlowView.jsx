import React, { useEffect, useMemo, useRef } from "react";
import { edgeLabel } from "../lib/graph.js";
import { usePanZoom } from "../lib/usePanZoom.js";

const NODE_W = 184, NODE_H = 54, GAP_X = 104, GAP_Y = 16, PAD = 28;

/**
 * n8n-style workflow canvas: one column per hop depth, rounded node cards, labelled bezier
 * connectors, dotted grid, drag to pan, wheel to zoom. Hand-written SVG, no library.
 */
export default function FlowView({ graph, selected, onSelect, height = 380 }) {
  const { view, setView, onPointerDown, onPointerMove, onPointerUp, onWheel, wasDrag } = usePanZoom();
  const host = useRef(null);

  const layout = useMemo(() => {
    const { columns, links, rails } = graph;
    const colH = columns.map((c) => c.length * NODE_H + Math.max(0, c.length - 1) * GAP_Y);
    const H = Math.max(...colH, NODE_H) + PAD * 2;
    const pos = new Map();
    columns.forEach((col, d) => {
      const top = (H - colH[d]) / 2;
      col.forEach((n, i) => pos.set(n.id, { x: PAD + d * (NODE_W + GAP_X), y: top + i * (NODE_H + GAP_Y) }));
    });
    const W = PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * GAP_X;
    return { pos, W, H, links, rails, columns };
  }, [graph]);

  const fit = () => {
    const el = host.current;
    if (!el) return;
    const { width, height: h } = el.getBoundingClientRect();
    // Fit the height, and the width only while nodes stay readable; otherwise start at the anchor and let the user pan.
    const k = Math.max(0.62, Math.min(1, (width - 24) / layout.W, (h - 24) / layout.H));
    const fitsX = layout.W * k <= width - 24;
    setView({ k, x: fitsX ? (width - layout.W * k) / 2 : 12, y: (h - layout.H * k) / 2 });
  };
  useEffect(fit, [layout.W, layout.H]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // refit when the evidence panel opens or the column resizes
    const el = host.current; if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => { if (first) { first = false; return; } fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.W, layout.H]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the selected node in view when the evidence panel narrows the canvas
  useEffect(() => {
    if (!selected || !host.current) return;
    const p = layout.pos.get(selected); if (!p) return;
    const { width } = host.current.getBoundingClientRect();
    setView((v) => {
      const sx = v.x + (p.x + NODE_W / 2) * v.k;
      if (sx > 40 && sx < width - 40) return v;
      return { ...v, x: width / 2 - (p.x + NODE_W / 2) * v.k };
    });
  }, [selected, layout.pos, setView]);

  const curve = (a, b) => {
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    const c = Math.max(40, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
  };

  const neighbours = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const l of layout.links) if (l.source.id === selected || l.target.id === selected) { s.add(l.source.id); s.add(l.target.id); }
    return s;
  }, [selected, layout.links]);

  return (
    <div ref={host} className="canvas" style={{ height }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}>
      <svg className="flow" width="100%" height="100%" role="img" aria-label="Execution path as a flow diagram">
        <defs>
          <pattern id="grid" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <circle cx="1" cy="1" r="1" className="grid-dot" />
          </pattern>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1,1 L9,5 L1,9" className="arrow-head" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.links.map((l, i) => {
            const a = layout.pos.get(l.source.id), b = layout.pos.get(l.target.id);
            const faded = neighbours && !(neighbours.has(l.source.id) && neighbours.has(l.target.id));
            const mx = (a.x + NODE_W + b.x) / 2, my = (a.y + b.y) / 2 + NODE_H / 2;
            return (
              <g key={`l${i}`} className={`link${faded ? " link--faded" : ""}`}>
                <path d={curve(a, b)} className="link-path" markerEnd="url(#arrow)" />
                {l.edge && (
                  <g className="link-label" transform={`translate(${mx} ${my - 9})`}>
                    <rect x={-(l.edge.length * 3.4 + 8)} y="-8" width={l.edge.length * 6.8 + 16} height="16" rx="8" />
                    <text textAnchor="middle" dy="3.5">{edgeLabel(l.edge)}</text>
                  </g>
                )}
              </g>
            );
          })}
          {layout.rails.map((r) => {
            const from = layout.columns[r.depth - 1], to = layout.columns[r.depth];
            const x = PAD + r.depth * (NODE_W + GAP_X) - GAP_X / 2;
            const ys = [...from, ...to].map((n) => layout.pos.get(n.id).y + NODE_H / 2);
            const y0 = Math.min(...ys), y1 = Math.max(...ys);
            return (
              <g key={`r${r.depth}`} className="rail">
                <line x1={x} y1={y0} x2={x} y2={y1} />
                {from.map((n) => { const p = layout.pos.get(n.id); return <path key={n.id} d={`M${p.x + NODE_W},${p.y + NODE_H / 2} C${p.x + NODE_W + 30},${p.y + NODE_H / 2} ${x - 30},${p.y + NODE_H / 2} ${x},${p.y + NODE_H / 2}`} />; })}
                {to.map((n) => { const p = layout.pos.get(n.id); return <path key={n.id} d={`M${x},${p.y + NODE_H / 2} C${x + 30},${p.y + NODE_H / 2} ${p.x - 30},${p.y + NODE_H / 2} ${p.x},${p.y + NODE_H / 2}`} markerEnd="url(#arrow)" />; })}
                <g className="link-label link-label--rail" transform={`translate(${x} ${y0 - 14})`}>
                  <text textAnchor="middle" dy="3.5">{r.edges.map(edgeLabel).join(" · ") || "one of"}</text>
                </g>
              </g>
            );
          })}
          {graph.nodes.map((n, i) => {
            const p = layout.pos.get(n.id);
            const faded = neighbours && !neighbours.has(n.id);
            const cls = ["fnode", `fnode--${n.side}`, selected === n.id && "fnode--on", faded && "fnode--faded"].filter(Boolean).join(" ");
            return (
              <g key={n.id} transform={`translate(${p.x} ${p.y})`}>
                {/* the animated group is separate: a CSS transform animation would override the SVG transform attribute */}
                <g className={cls} style={{ animationDelay: `${i * 45}ms` }}
                  onClick={(e) => { if (!wasDrag()) { e.stopPropagation(); onSelect(n.id === selected ? null : n.id); } }}
                  tabIndex={0} role="button" aria-label={`${n.kind} ${n.label}`}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.id); } }}>
                  <rect width={NODE_W} height={NODE_H} rx="12" className="fnode-box" />
                  <rect x="0" y="0" width="4" height={NODE_H} rx="2" className="fnode-bar" />
                  <text x="16" y="20" className="fnode-kind">{n.kind}</text>
                  <text x="16" y="40" className="fnode-name"><title>{n.title}</title>{n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}</text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="canvas-tools">
        <button type="button" className="tool" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.25) }))} aria-label="Zoom in">+</button>
        <button type="button" className="tool" onClick={() => setView((v) => ({ ...v, k: Math.max(0.35, v.k / 1.25) }))} aria-label="Zoom out">−</button>
        <button type="button" className="tool" onClick={fit} aria-label="Fit to view" title="Fit">⤢</button>
      </div>
    </div>
  );
}
