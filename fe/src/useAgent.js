import { useCallback, useEffect, useRef, useState } from "react";
import { askStream, getHealth, getRefs } from "./api.js";

const newTurn = (question, refs) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  question, refs, status: "", steps: [], text: "", claims: [], evidence: {},
  unresolved: [], truncated: null, error: null, summary: null, intent: null,
});

export function useAgent() {
  const [health, setHealth] = useState(null);
  const [refs, setRefs] = useState([]);
  const [selectedRef, setSelectedRef] = useState("main");
  const [style, setStyle] = useState("auto");
  const [turns, setTurns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [asking, setAsking] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    let alive = true;
    getHealth().then((h) => alive && setHealth(h)).catch(() => alive && setHealth({ ok: false }));
    getRefs().then((r) => alive && setRefs(r.refs || [])).catch(() => {});
    return () => { alive = false; abortRef.current?.(); };
  }, []);

  const patchLast = useCallback((fn) => {
    setTurns((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });
  }, []);

  const handleEvent = useCallback((ev) => {
    patchLast((t) => {
      switch (ev.type) {
        case "intent": return { ...t, intent: ev.intent };
        case "status": return { ...t, status: ev.text, steps: [...t.steps, ev.text].slice(-6) };
        case "token": return { ...t, text: t.text + ev.text };
        case "claim": return { ...t, claims: [...t.claims, ev] };
        case "evidence": return { ...t, evidence: { ...t.evidence, [ev.id]: ev } };
        case "unresolved": return { ...t, unresolved: [...t.unresolved, ev] };
        case "truncated": return { ...t, truncated: ev };
        case "error": return { ...t, error: ev, status: "" };
        case "done": return { ...t, status: "", summary: ev };
        default: return t;
      }
    });
    if (ev.type === "done") setAsking(false);
  }, [patchLast]);

  const ask = useCallback((question) => {
    const q = (question || "").trim();
    if (!q || asking) return;
    abortRef.current?.();
    const turn = newTurn(q, [selectedRef]);
    setTurns((prev) => [...prev, turn]);
    setActiveId(turn.id);
    setAsking(true);
    abortRef.current = askStream({
      question: q, refs: [selectedRef], style, onEvent: handleEvent,
      onError: (err) => {
        patchLast((t) => ({ ...t, status: "", error: { code: "network", message: err.message } }));
        setAsking(false);
      },
    });
  }, [asking, selectedRef, style, handleEvent, patchLast]);

  const stop = useCallback(() => {
    abortRef.current?.();
    setAsking(false);
    patchLast((t) => ({ ...t, status: "" }));
  }, [patchLast]);

  const reset = useCallback(() => {
    abortRef.current?.();
    setAsking(false);
    setTurns([]);
    setActiveId(null);
  }, []);

  const active = turns.find((t) => t.id === activeId) || turns[turns.length - 1] || null;
  return { health, refs, selectedRef, setSelectedRef, style, setStyle, turns, active, select: setActiveId, asking, ask, stop, reset };
}
