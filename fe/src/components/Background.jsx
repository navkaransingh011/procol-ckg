import React, { useEffect, useRef } from "react";

/**
 * A slow constellation of graph nodes with depth parallax, drawn on one canvas. It is a code graph,
 * so the background is the product's own subject rather than decoration. Reacts to the cursor
 * (gentle repulsion + parallax), pauses when the tab is hidden, and renders a single still frame
 * under prefers-reduced-motion. Zero dependencies, no assets, safe on an offline VM.
 */
export default function Background({ dim }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

    let w = 0, h = 0, dpr = 1, nodes = [], raf = 0, running = true, last = performance.now();
    const mouse = { x: -1e4, y: -1e4, tx: 0, ty: 0, px: 0, py: 0 };

    const seed = () => {
      const count = Math.round(Math.min(170, Math.max(60, (w * h) / 9000)));
      nodes = Array.from({ length: count }, () => {
        const z = 0.25 + Math.random() ** 1.6 * 0.75; // more far nodes than near
        return {
          x: Math.random() * w, y: Math.random() * h, z,
          vx: (Math.random() - 0.5) * 0.08 * z, vy: (Math.random() - 0.5) * 0.08 * z,
          r: 0.8 + z * 1.9, warm: Math.random() < 0.18, phase: Math.random() * Math.PI * 2,
        };
      });
    };

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      if (reduce) draw(0);
    };

    const draw = (dt) => {
      const isDark = dark();
      const ink = isDark ? "139,139,240" : "91,91,214";
      const warm = isDark ? "240,176,98" : "180,83,9";
      const linkBase = isDark ? 0.16 : 0.13;
      ctx.clearRect(0, 0, w, h);

      // parallax offset eases toward the pointer
      mouse.px += (mouse.tx - mouse.px) * 0.04;
      mouse.py += (mouse.ty - mouse.py) * 0.04;

      const step = Math.min(2, dt / 16.7);
      for (const n of nodes) {
        if (!reduce) {
          const dx = n.x - mouse.x, dy = n.y - mouse.y, d2 = dx * dx + dy * dy, rad = 150 * n.z;
          if (d2 < rad * rad && d2 > 0.01) {
            const d = Math.sqrt(d2), f = ((rad - d) / rad) * 0.06 * n.z;
            n.vx += (dx / d) * f; n.vy += (dy / d) * f;
          }
          n.vx *= 0.985; n.vy *= 0.985;
          n.x += n.vx * step; n.y += n.vy * step;
          if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20;
          if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20;
        }
        n.sx = n.x + mouse.px * 26 * (n.z - 0.6);
        n.sy = n.y + mouse.py * 26 * (n.z - 0.6);
      }

      // links between near neighbours; the threshold scales with depth so far nodes knit more finely
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.sx - b.sx, dy = a.sy - b.sy, d2 = dx * dx + dy * dy;
          const max = 70 + 70 * Math.min(a.z, b.z);
          if (d2 > max * max) continue;
          const t = 1 - Math.sqrt(d2) / max;
          ctx.strokeStyle = `rgba(${a.warm && b.warm ? warm : ink},${(t * linkBase * Math.min(a.z, b.z)).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
        }
      }
      const now = performance.now() / 1000;
      for (const n of nodes) {
        const tw = reduce ? 1 : 0.75 + 0.25 * Math.sin(now * 0.8 + n.phase);
        const a = (isDark ? 0.55 : 0.5) * n.z * tw;
        ctx.fillStyle = `rgba(${n.warm ? warm : ink},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, n.r, 0, Math.PI * 2); ctx.fill();
        if (n.z > 0.85) {
          ctx.fillStyle = `rgba(${n.warm ? warm : ink},${(a * 0.18).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(n.sx, n.sy, n.r * 3.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    };

    const loop = (t) => {
      if (!running) return;
      const dt = t - last; last = t;
      draw(dt);
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e) => {
      mouse.x = e.clientX; mouse.y = e.clientY;
      mouse.tx = (e.clientX / w - 0.5); mouse.ty = (e.clientY / h - 0.5);
    };
    const onLeave = () => { mouse.x = -1e4; mouse.y = -1e4; };
    const onVis = () => {
      running = !document.hidden && !reduce;
      if (running) { last = performance.now(); raf = requestAnimationFrame(loop); } else cancelAnimationFrame(raf);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVis);
    if (!reduce) raf = requestAnimationFrame(loop);
    return () => {
      running = false; cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} className={`bg${dim ? " bg--dim" : ""}`} aria-hidden="true" />;
}
