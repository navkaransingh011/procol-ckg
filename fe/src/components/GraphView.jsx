import React, { useEffect, useRef, useState } from "react";

/**
 * Obsidian-style local graph on a canvas: a small force simulation (repulsion, link springs,
 * depth-ring gravity so the anchor sits in the middle), hover dims everything but the
 * neighbourhood, drag moves a node, wheel zooms, drag empty space pans, click selects.
 */
export default function GraphView({ graph, selected, onSelect, height = 380 }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const [gen, setGen] = useState(0); // bumps to re-settle and re-centre
  const sim = useRef(null);

  // (Re)build the simulation whenever the claim set changes. Positions of surviving nodes persist.
  useEffect(() => {
    const prev = sim.current?.nodes || [];
    const keep = new Map(prev.map((n) => [n.id, n]));
    const byDepth = graph.columns;
    const nodes = graph.nodes.map((n) => {
      const old = keep.get(n.id);
      const ring = byDepth[n.depth] || [];
      const i = ring.indexOf(n), a = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2 + n.depth * 0.6;
      const r = n.depth * 88;
      return old ? Object.assign(old, { data: n }) : { id: n.id, data: n, x: Math.cos(a) * r + (Math.random() - 0.5) * 6, y: (Math.sin(a) * r) / 2.5 + (Math.random() - 0.5) * 6, vx: 0, vy: 0, r: n.depth === 0 ? 9 : 6.5 };
    });
    const idx = new Map(nodes.map((n) => [n.id, n]));
    const links = graph.links.map((l) => ({ a: idx.get(l.source.id), b: idx.get(l.target.id), edge: l.edge, certain: true }));
    // Ambiguous hops: faint candidate links, capped so a wide fan-in does not become a hairball.
    for (const r of graph.rails) {
      const parents = graph.columns[r.depth - 1];
      if (parents.length > 4) continue;
      for (const n of graph.columns[r.depth]) {
        const named = graph.links.some((l) => l.target.id === n.id);
        if (!named) for (const p of parents) links.push({ a: idx.get(p.id), b: idx.get(n.id), edge: n.claim.edge, certain: false });
      }
    }
    sim.current = { nodes, links, alpha: 1, view: sim.current?.view || { x: 0, y: 0, k: 1 }, ring: sim.current?.ring || 88, maxDepth: Math.max(1, graph.columns.length - 1) };
  }, [graph]);

  useEffect(() => {
    const canvas = ref.current, ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, w = 0, h = 0, dpr = 1, alive = true;
    const drag = { node: null, pan: null, moved: false };

    const resize = () => {
      const r = canvas.parentElement.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1); w = r.width; h = r.height;
      canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // depth rings sized so the deepest hop still lands inside the canvas
      // rings are ellipses that follow the canvas shape: wide canvas, wide graph, nothing clipped top or bottom
      if (sim.current) { sim.current.ratio = Math.max(1, (w - 40) / (h - 40)); sim.current.ring = Math.max(72, Math.min(120, (w / 2 - 70) / sim.current.maxDepth)); sim.current.alpha = Math.max(sim.current.alpha, 0.5); }
    };

    const tick = () => {
      const s = sim.current; if (!s) return;
      const { nodes, links } = s;
      if (s.alpha < 0.005) return;
      const a = s.alpha;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        // ring gravity keeps depth legible; anchor pinned near the centre
        const ratio = s.ratio || 1, ex = n.x, ey = n.y * ratio;
        const target = n.data.depth * s.ring, d = Math.hypot(ex, ey) || 1;
        const g = (target - d) * 0.02 * a;
        n.vx += (ex / d) * g; n.vy += ((ey / d) * g) / ratio;
        n.vx -= n.x * 0.002 * a; n.vy -= n.y * 0.002 * a;
        for (let j = i + 1; j < nodes.length; j++) {
          const m = nodes[j];
          let dx = n.x - m.x, dy = n.y - m.y, d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = Math.min(6, (s.ring * s.ring * 0.5) / d2) * a;
          const inv = 1 / Math.sqrt(d2);
          n.vx += dx * inv * f; n.vy += dy * inv * f; m.vx -= dx * inv * f; m.vy -= dy * inv * f;
        }
      }
      for (const l of links) {
        if (!l.a || !l.b) continue;
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
        const k = (l.certain ? 0.05 : 0.012) * a, f = (d - s.ring * 0.9) * k;
        l.a.vx += (dx / d) * f; l.a.vy += (dy / d) * f; l.b.vx -= (dx / d) * f; l.b.vy -= (dy / d) * f;
      }
      for (const n of nodes) {
        if (n === drag.node) { n.vx = n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
      }
      s.alpha *= 0.985;
    };

    // centre the settled graph and zoom out only if it would not fit, leaving room for labels
    const fitView = () => {
      const s = sim.current; if (!s?.nodes.length) return;
      const xs = s.nodes.map((n) => n.x), ys = s.nodes.map((n) => n.y);
      const bw = Math.max(...xs) - Math.min(...xs) + 160, bh = Math.max(...ys) - Math.min(...ys) + 90;
      const k = Math.max(0.5, Math.min(1, w / bw, h / bh));
      s.view = { k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k };
    };
    const toScreen = (n) => { const v = sim.current.view; return [w / 2 + v.x + n.x * v.k, h / 2 + v.y + n.y * v.k]; };
    const pick = (px, py) => {
      const s = sim.current; if (!s) return null;
      let best = null, bd = 14 * 14;
      for (const n of s.nodes) { const [x, y] = toScreen(n); const d = (x - px) ** 2 + (y - py) ** 2; if (d < bd) { bd = d; best = n; } }
      return best;
    };

    const css = (name) => getComputedStyle(canvas).getPropertyValue(name).trim();
    const draw = () => {
      const s = sim.current; if (!s) return;
      ctx.clearRect(0, 0, w, h);
      const colours = { frontend: css("--accent"), backend: css("--amber"), contract: css("--ink-3"), doc: css("--teal") };
      const ink = css("--ink"), ink3 = css("--ink-3"), line = css("--line-2");
      const focus = hover || selected;
      const near = new Set();
      if (focus) { near.add(focus); for (const l of s.links) { if (l.a?.id === focus) near.add(l.b.id); if (l.b?.id === focus) near.add(l.a.id); } }

      // grid
      ctx.fillStyle = css("--line");
      const step = 22 * s.view.k, ox = ((w / 2 + s.view.x) % step + step) % step, oy = ((h / 2 + s.view.y) % step + step) % step;
      if (step > 10) for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) ctx.fillRect(x, y, 1, 1);

      for (const l of s.links) {
        if (!l.a || !l.b) continue;
        const [x1, y1] = toScreen(l.a), [x2, y2] = toScreen(l.b);
        const dim = focus && !(near.has(l.a.id) && near.has(l.b.id));
        ctx.globalAlpha = dim ? 0.12 : l.certain ? 0.9 : 0.5;
        ctx.strokeStyle = line; ctx.lineWidth = l.certain ? 1.2 : 1; ctx.setLineDash(l.certain ? [] : [3, 4]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.setLineDash([]);
        if (l.edge && !dim && (s.view.k > 1.15 || near.has(l.a.id) && near.has(l.b.id) && focus)) {
          ctx.globalAlpha = 0.85; ctx.fillStyle = ink3; ctx.font = `10px ${css("--sans")}`; ctx.textAlign = "center";
          ctx.fillText(String(l.edge).toLowerCase().replace(/_/g, " "), (x1 + x2) / 2, (y1 + y2) / 2 - 4);
        }
      }
      for (const n of s.nodes) {
        const [x, y] = toScreen(n);
        const dim = focus && !near.has(n.id);
        const c = colours[n.data.side];
        ctx.globalAlpha = dim ? 0.18 : 1;
        if (n.id === selected || n.id === hover) { ctx.fillStyle = c; ctx.globalAlpha = dim ? 0.1 : 0.18; ctx.beginPath(); ctx.arc(x, y, n.r * s.view.k + 9, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = dim ? 0.18 : 1; }
        ctx.beginPath(); ctx.arc(x, y, n.r * s.view.k, 0, Math.PI * 2);
        if (n.data.side === "contract") { ctx.fillStyle = css("--bg"); ctx.fill(); ctx.setLineDash([2, 2]); ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]); }
        else { ctx.fillStyle = c; ctx.fill(); }
        if (s.view.k > 0.55 || near.has(n.id) || n.data.depth === 0) {
          ctx.fillStyle = dim ? ink3 : ink; ctx.font = `${n.data.depth === 0 ? 600 : 400} 11px ${css("--mono")}`; ctx.textAlign = "center";
          // alternate above/below by column position so neighbours in one ring do not stack their labels
          const below = n.data.depth === 0 || n.data.index % 2 === 0;
          ctx.fillText(n.data.label, x, below ? y + n.r * s.view.k + 13 : y - n.r * s.view.k - 6);
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = () => { if (!alive) return; tick(); draw(); raf = requestAnimationFrame(loop); };

    const onDown = (e) => {
      const r = canvas.getBoundingClientRect(); const n = pick(e.clientX - r.left, e.clientY - r.top);
      drag.moved = false;
      if (n) { drag.node = n; sim.current.alpha = Math.max(sim.current.alpha, 0.3); }
      else drag.pan = { sx: e.clientX, sy: e.clientY, ox: sim.current.view.x, oy: sim.current.view.y };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      if (drag.node) { drag.moved = true; const v = sim.current.view; drag.node.x = (px - w / 2 - v.x) / v.k; drag.node.y = (py - h / 2 - v.y) / v.k; sim.current.alpha = Math.max(sim.current.alpha, 0.2); return; }
      if (drag.pan) { const dx = e.clientX - drag.pan.sx, dy = e.clientY - drag.pan.sy; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; sim.current.view.x = drag.pan.ox + dx; sim.current.view.y = drag.pan.oy + dy; return; }
      const n = pick(px, py); setHover(n?.id || null); canvas.style.cursor = n ? "pointer" : "grab";
    };
    const onUp = () => {
      if (drag.node && !drag.moved) onSelect(drag.node.id === selected ? null : drag.node.id);
      else if (drag.pan && !drag.moved) onSelect(null);
      drag.node = null; drag.pan = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const v = sim.current.view, r = canvas.getBoundingClientRect(), px = e.clientX - r.left - w / 2, py = e.clientY - r.top - h / 2;
      const k = Math.min(3, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.0015))), sc = k / v.k;
      v.x = px - (px - v.x) * sc; v.y = py - (py - v.y) * sc; v.k = k;
    };

    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp); canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Settle the layout synchronously so the first frame is already legible; the live loop then only
    // does a gentle final relaxation (or nothing under reduced motion).
    if (sim.current && !sim.current.settled) {
      for (let i = 0; i < 240; i++) tick();
      sim.current.settled = true;
      sim.current.alpha = reduce ? 0 : 0.2;
      fitView();
    }
    draw();
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false; cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [graph, selected, hover, onSelect, gen]);

  const reset = () => { if (sim.current) { sim.current.settled = false; sim.current.alpha = 1; } setGen((g) => g + 1); };
  return (
    <div className="canvas" style={{ height }}>
      <canvas ref={ref} role="img" aria-label="Execution path as a local graph" />
      <div className="canvas-tools">
        <button type="button" className="tool" onClick={() => { const v = sim.current.view; v.k = Math.min(3, v.k * 1.25); }} aria-label="Zoom in">+</button>
        <button type="button" className="tool" onClick={() => { const v = sim.current.view; v.k = Math.max(0.3, v.k / 1.25); }} aria-label="Zoom out">−</button>
        <button type="button" className="tool" onClick={reset} aria-label="Reset view" title="Reset">⤢</button>
      </div>
    </div>
  );
}
