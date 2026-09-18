import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pan and zoom for a diagram viewport, done the way people expect from a map:
 *   drag           pans (mouse, pen or one finger)
 *   pinch          zooms about the fingers (two pointers)
 *   ctrl/cmd+wheel zooms about the cursor -- a trackpad pinch sends exactly this, so the PAGE no longer zooms
 *   shift+wheel    pans sideways
 *   plain wheel    scrolls the page as usual (mode "modifier"), or pans the diagram (mode "always", for a full-screen view)
 *
 * The wheel listener is attached natively with { passive: false }: React registers onWheel as passive, so calling
 * preventDefault there does nothing and the browser zooms the whole page -- the bug this hook exists to fix.
 */
export function usePanZoom({ min = 0.3, max = 4, wheel = "modifier" } = {}) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const hostRef = useRef(null);
  const drag = useRef(null);
  const pointers = useRef(new Map());     // pointerId -> { x, y } for pinch
  const pinch = useRef(null);             // { dist, cx, cy, k, x, y } at pinch start

  const clampK = useCallback((k) => Math.min(max, Math.max(min, k)), [min, max]);

  /** Zoom by a factor about a point in viewport pixels (defaults to the centre of the host). */
  const zoomBy = useCallback((factor, at = null) => {
    const el = hostRef.current;
    const px = at?.x ?? (el ? el.clientWidth / 2 : 0), py = at?.y ?? (el ? el.clientHeight / 2 : 0);
    setView((v) => { const k = clampK(v.k * factor), s = k / v.k; return { k, x: px - (px - v.x) * s, y: py - (py - v.y) * s }; });
  }, [clampK]);

  const onPointerDown = useCallback((e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 - rect.left, cy: (a.y + b.y) / 2 - rect.top, k: view.k, x: view.x, y: view.y };
      drag.current = null;
      return;
    }
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
  }, [view]);

  const onPointerMove = useCallback((e) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const p = pinch.current, dist = Math.hypot(a.x - b.x, a.y - b.y);
      const k = clampK(p.k * (dist / Math.max(1, p.dist))), s = k / p.k;
      setView({ k, x: p.cx - (p.cx - p.x) * s, y: p.cy - (p.cy - p.y) * s });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  }, [clampK]);

  const onPointerUp = useCallback((e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  }, []);

  // native, non-passive wheel: zoom with a modifier (or always, in a full-screen view), pan sideways with shift
  useEffect(() => {
    const el = hostRef.current; if (!el) return undefined;
    const handler = (e) => {
      const modifier = e.ctrlKey || e.metaKey;
      const zooming = wheel === "always" ? !e.shiftKey : modifier;
      if (zooming) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomBy(Math.exp(-e.deltaY * (modifier ? 0.01 : 0.0015)), { x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else if (e.shiftKey) {
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x - (e.deltaX || e.deltaY) }));
      }
      // plain wheel in "modifier" mode: leave it to the page
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [wheel, zoomBy]);

  const wasDrag = () => Boolean(drag.current?.moved) || Boolean(pinch.current);
  return { view, setView, zoomBy, hostRef, onPointerDown, onPointerMove, onPointerUp, wasDrag };
}
