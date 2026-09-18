import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePanZoom } from "../lib/usePanZoom.js";

/**
 * The workflow beside the answer: steps in product language laid out left to right, decisions as diamonds,
 * actors as colours, labelled edges for outcomes. The service validated every step against the facts it
 * gave the model; a step whose reference could not be verified is drawn with a dashed border.
 * Hand-written SVG: layered layout (longest path), one barycenter pass, cubic connectors.
 */
const W = 176, H = 52, GX = 72, GY = 22, PAD = 26, GXV = 28, GYV = 58;
export const ACTOR_LABEL = { buyer: "buyer", supplier: "supplier", approver: "approver", system: "system", admin: "admin" };

export function layoutFlow(flow) {
  const steps = flow.steps, ids = new Set(steps.map((s) => s.id));
  const out = new Map(steps.map((s) => [s.id, []])), inn = new Map(steps.map((s) => [s.id, []]));
  for (const e of flow.edges) if (ids.has(e.from) && ids.has(e.to)) { out.get(e.from).push(e.to); inn.get(e.to).push(e.from); }
  // layers by longest path from the sources, ignoring back edges found by DFS
  const layer = new Map(), state = new Map(), back = new Set();
  const dfs = (id) => {
    state.set(id, 1);
    for (const t of out.get(id)) { if (state.get(t) === 1) back.add(`${id}>${t}`); else if (!state.has(t)) dfs(t); }
    state.set(id, 2);
  };
  for (const s of steps) if (!state.has(s.id)) dfs(s.id);
  const fwdIn = (id) => inn.get(id).filter((f) => !back.has(`${f}>${id}`));
  const depth = (id, seen = new Set()) => {
    if (layer.has(id)) return layer.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = fwdIn(id).length ? 1 + Math.max(...fwdIn(id).map((f) => depth(f, seen))) : 0;
    layer.set(id, d); return d;
  };
  for (const s of steps) depth(s.id);
  const cols = [];
  for (const s of steps) { const d = layer.get(s.id); (cols[d] ||= []).push(s.id); }
  // one barycenter pass: order each column by the mean position of its predecessors
  const posIn = new Map();
  cols.forEach((col, d) => {
    if (d > 0) col.sort((a, b) => {
      const m = (id) => { const ps = fwdIn(id).map((f) => posIn.get(f) ?? 0); return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : 0; };
      return m(a) - m(b);
    });
    col.forEach((id, i) => posIn.set(id, i));
  });
  const vertical = cols.length >= 4;
  const pos = new Map();
  let totalW, totalH;
  if (!vertical) {
    const colH = cols.map((c) => c.length * H + (c.length - 1) * GY);
    totalH = Math.max(...colH, H) + PAD * 2;
    cols.forEach((col, d) => { const top = (totalH - colH[d]) / 2; col.forEach((id, i) => pos.set(id, { x: PAD + d * (W + GX), y: top + i * (H + GY) })); });
    totalW = PAD * 2 + cols.length * W + (cols.length - 1) * GX;
  } else {
    const rowW = cols.map((c) => c.length * W + (c.length - 1) * GXV);
    totalW = Math.max(...rowW, W) + PAD * 2;
    cols.forEach((row, d) => { const left = (totalW - rowW[d]) / 2; row.forEach((id, i) => pos.set(id, { x: left + i * (W + GXV), y: PAD + 14 + d * (H + GYV) })); });
    totalH = PAD * 2 + 14 + cols.length * H + (cols.length - 1) * GYV;
  }
  return { pos, W: totalW, H: totalH, back, cols, vertical };
}

const path = (a, b, isBack, vertical) => {
  if (vertical) {
    if (!isBack) { const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y, c = Math.max(18, (y2 - y1) / 2); return `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`; }
    // back edge: leave from the right side, loop around, arrive at the right side of the target
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x + W, y2 = b.y + H / 2, out = Math.max(a.x, b.x) + W + 44;
    return `M${x1},${y1} C${out},${y1} ${out},${y2} ${x2 + 1},${y2}`;
  }
  if (!isBack) { const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, c = Math.max(24, (x2 - x1) / 2); return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`; }
  // back edge: leave from the bottom, loop under, arrive at the bottom of the target
  const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y + H, dip = Math.max(a.y, b.y) + H + 46;
  return `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2 + 1}`;
};

export default function Workflow({ flow, active, visited, onSelect, height = 440, wheel = "modifier", expandable = true }) {
  // ctrl/cmd+wheel and pinch zoom the diagram (never the page); drag pans; in the full-screen view plain wheel pans too
  const { view, setView, zoomBy, hostRef: host, onPointerDown, onPointerMove, onPointerUp, wasDrag } = usePanZoom({ min: 0.3, max: 4, wheel });
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";   // the page stays put behind the overlay
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [expanded]);
  const L = useMemo(() => layoutFlow(flow), [flow]);
  const byId = useMemo(() => new Map(flow.steps.map((s) => [s.id, s])), [flow]);

  const fit = () => {
    const el = host.current; if (!el) return;
    const k = Math.min(1, (el.clientWidth - 8) / L.W, (height - 8) / L.H);
    setView({ k, x: (el.clientWidth - L.W * k) / 2, y: (height - L.H * k) / 2 });
  };
  useEffect(fit, [L, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the active step in view while the walkthrough runs
  useEffect(() => {
    const el = host.current, p = active && L.pos.get(active); if (!el || !p) return;
    setView((v) => {
      const cx = (p.x + W / 2) * v.k + v.x, cy = (p.y + H / 2) * v.k + v.y;
      const dx = cx < 40 ? 60 - cx : cx > el.clientWidth - 40 ? el.clientWidth - 60 - cx : 0;
      const dy = cy < 30 ? 50 - cy : cy > height - 30 ? height - 50 - cy : 0;
      return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
    });
  }, [active, L, height, setView]);

  const shape = (s, p, on) => {
    const cls = `wf-node wf-node--${s.actor} wf-node--${s.kind}${on ? " wf-node--on" : ""}${visited?.has(s.id) ? " wf-node--seen" : ""}${s.unverified_ref ? " wf-node--unverified" : ""}`;
    if (s.kind === "decision")
      return <polygon className={cls} points={`${p.x + W / 2},${p.y - 6} ${p.x + W + 6},${p.y + H / 2} ${p.x + W / 2},${p.y + H + 6} ${p.x - 6},${p.y + H / 2}`} />;
    return <rect className={cls} x={p.x} y={p.y} width={W} height={H} rx={s.kind === "start" || s.kind === "end" ? H / 2 : 10} />;
  };

  return (
    <div ref={host} className={`wf${expandable ? "" : " wf--full"}`} style={{ height }}
         onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerUp}
         onDoubleClick={(e) => { const r = host.current.getBoundingClientRect(); zoomBy(1.6, { x: e.clientX - r.left, y: e.clientY - r.top }); }}>
      <svg className="wf-svg" width="100%" height={height} role="img" aria-label={`Workflow with ${flow.steps.length} steps`}>
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" className="wf-arrowhead" /></marker>
          <pattern id="wf-grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" className="wf-grid" /></pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wf-grid)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {flow.edges.map((e, i) => {
            const a = L.pos.get(e.from), b = L.pos.get(e.to); if (!a || !b) return null;
            const isBack = L.back.has(`${e.from}>${e.to}`) || (L.vertical ? b.y <= a.y : b.x <= a.x);
            const on = active && (e.from === active || e.to === active);
            const d = path(a, b, isBack, L.vertical);
            const mid = L.vertical
              ? (isBack ? { x: Math.max(a.x, b.x) + W + 44, y: (a.y + b.y) / 2 + H / 2 } : { x: (a.x + b.x) / 2 + W / 2 + (b.x !== a.x ? 0 : 0), y: (a.y + H + b.y) / 2 })
              : (isBack ? { x: (a.x + b.x) / 2 + W / 2, y: Math.max(a.y, b.y) + H + 38 } : { x: (a.x + W + b.x) / 2, y: (a.y + b.y) / 2 + H / 2 - 8 });
            return (
              <g key={`${e.from}-${e.to}-${i}`} className={`wf-edge${on ? " wf-edge--on" : ""}`}>
                <path d={d} className="wf-link" markerEnd="url(#wf-arrow)" />
                {e.label && <g transform={`translate(${mid.x},${mid.y})`}><rect className="wf-edge-label-bg" x={-e.label.length * 3.1 - 6} y={-9} width={e.label.length * 6.2 + 12} height={18} rx={9} /><text className="wf-edge-label" textAnchor="middle" dominantBaseline="middle">{e.label}</text></g>}
              </g>
            );
          })}
          {flow.steps.map((s) => {
            const p = L.pos.get(s.id); if (!p) return null;
            const on = active === s.id;
            const words = s.label.split(" "); const l1 = [], l2 = [];
            for (const w of words) ((l1.join(" ").length + w.length < 24 && !l2.length) ? l1 : l2).push(w);
            const t2 = l2.join(" "); const two = t2.length > 0;
            return (
              <g key={s.id} className="wf-step" tabIndex={0} role="button" aria-label={s.label}
                 onClick={() => { if (!wasDrag()) onSelect?.(s.id); }} onKeyDown={(e) => e.key === "Enter" && onSelect?.(s.id)}>
                {shape(s, p, on)}
                <text className="wf-actor" x={p.x + W / 2} y={p.y - 8} textAnchor="middle">{ACTOR_LABEL[s.actor]}{s.source ? ` · ${s.source}` : ""}</text>
                <text className="wf-label" x={p.x + W / 2} y={p.y + H / 2 + (two ? -3 : 4)} textAnchor="middle">
                  {l1.join(" ")}{two && <tspan x={p.x + W / 2} dy="14">{t2.length > 26 ? t2.slice(0, 25) + "…" : t2}</tspan>}
                </text>
                <text className="wf-id" x={p.x + 10} y={p.y + 13}>{s.id.slice(1)}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="wf-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {expandable && <button type="button" className="tool" onClick={() => setExpanded(true)} title="Open full screen">⛶</button>}
        <button type="button" className="tool" onClick={fit} title="Fit to view">⤢</button>
        <button type="button" className="tool" onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
        <button type="button" className="tool" onClick={() => zoomBy(1 / 1.25)} title="Zoom out">−</button>
      </div>
      <div className="wf-hint" aria-hidden="true">{wheel === "always" ? "scroll to pan · ⌘/ctrl + scroll or pinch to zoom · double-click to zoom in · esc to close" : "drag to pan · ⌘/ctrl + scroll or pinch to zoom · double-click to zoom in"}</div>
      {byId.get(active) && <div className="wf-caption"><b>{active.slice(1)}</b> {byId.get(active).label}{byId.get(active).ref ? <span className="wf-ref"> · {byId.get(active).ref}</span> : null}</div>}
      {/* Full-screen view for a diagram too big for its box: the same drawing, the whole viewport, plain scroll pans. Portalled
          to <body> so a transformed ancestor (the sidebar glide) cannot pin it in place. */}
      {expanded && createPortal(
        <div className="wf-overlay" role="dialog" aria-modal="true" aria-label="Workflow, full screen" onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}>
          <div className="wf-overlay-panel">
            <div className="wf-overlay-head">
              <span className="label">Workflow · {flow.steps.length} steps</span>
              <button type="button" className="ghost ghost--sm" onClick={() => setExpanded(false)}>close · esc</button>
            </div>
            <Workflow flow={flow} active={active} visited={visited} onSelect={onSelect} height={Math.max(320, window.innerHeight - 132)} wheel="always" expandable={false} />
          </div>
        </div>, document.body)}
    </div>
  );
}
