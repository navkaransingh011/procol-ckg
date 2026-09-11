import { useCallback, useEffect, useRef, useState } from "react";
import { askStream, getHealth, getRefs } from "./api.js";

const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

const newTurn = (question, refs) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  question, refs, startedAt: Date.now(), status: "", steps: [], text: "", claims: [], evidence: {},
  unresolved: [], truncated: null, error: null, summary: null, intent: null, tables: [],
});

export function useAgent() {
  const [health, setHealth] = useState(null);
  const [refs, setRefs] = useState([]);
  const [selectedRef, setSelectedRefState] = useState(() => read("ckg_ref", "main"));
  const [style, setStyleState] = useState(() => read("ckg_style", "auto"));
  const [turns, setTurns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [asking, setAsking] = useState(false);
  const abortRef = useRef(null);

  const setSelectedRef = useCallback((v) => { setSelectedRefState(v); write("ckg_ref", v); }, []);
  const setStyle = useCallback((v) => { setStyleState(v); write("ckg_style", v); }, []);

  useEffect(() => {
    let alive = true;
    getHealth().then((h) => alive && setHealth(h)).catch(() => alive && setHealth({ ok: false }));
    getRefs().then((r) => {
      if (!alive) return;
      const list = r.refs || [];
      setRefs(list);
      // a remembered branch that no longer exists falls back to main
      if (list.length && !list.some((x) => x.ref === selectedRef)) setSelectedRef("main");
    }).catch(() => {});
    return () => { alive = false; abortRef.current?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        case "status": return { ...t, status: ev.text, steps: [...t.steps, ev.text] };
        case "token": return { ...t, text: t.text + ev.text };
        case "claim": return { ...t, claims: [...t.claims, ev] };
        case "table": return { ...t, tables: [...(t.tables || []), ev] };
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
    patchLast((t) => ({ ...t, status: "", steps: [...t.steps, "stopped"] }));
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
