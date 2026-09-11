import { useCallback, useRef, useState } from "react";

/** Pointer-drag pan and wheel zoom for a canvas or SVG viewport. Returns transform + handlers. */
export function usePanZoom({ min = 0.35, max = 2.5 } = {}) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [view]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  }, []);

  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(max, Math.max(min, v.k * Math.exp(-e.deltaY * 0.0015)));
      const s = k / v.k;
      return { k, x: px - (px - v.x) * s, y: py - (py - v.y) * s };
    });
  }, [min, max]);

  const wasDrag = () => Boolean(drag.current?.moved);
  return { view, setView, onPointerDown, onPointerMove, onPointerUp, onWheel, wasDrag };
}
