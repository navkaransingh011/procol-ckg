import { useCallback, useEffect, useRef, useState } from "react";
import { askStream, getAuthConfig, getHealth, getMe, getRefs, login, logout } from "./api.js";

const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

const newTurn = (question, refs) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  question, refs, startedAt: Date.now(), status: "", steps: [], text: "", claims: [], evidence: {},
  unresolved: [], truncated: null, error: null, summary: null, intent: null, tables: [],
});

/**
 * All state. `me` is undefined while the session is being checked, null when signed out, else the
 * user {email, name, picture, role, label, can}. The role lives on the server; the UI only displays it.
 */
export function useAgent() {
  const [me, setMe] = useState(undefined);
  const [authCfg, setAuthCfg] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const [refs, setRefs] = useState([]);
  const [selectedRef, setSelectedRefState] = useState(() => read("ckg_ref", "main"));
  const [turns, setTurns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [asking, setAsking] = useState(false);
  const abortRef = useRef(null);

  const setSelectedRef = useCallback((v) => { setSelectedRefState(v); write("ckg_ref", v); }, []);

  // who am I, and how does this deployment sign people in
  useEffect(() => {
    let alive = true;
    getAuthConfig().then((c) => alive && setAuthCfg(c)).catch(() => alive && setAuthCfg({ mode: "unknown" }));
    getMe().then((r) => alive && setMe(r.user)).catch(() => alive && setMe(null));
    return () => { alive = false; };
  }, []);

  // graph facts and branches, once signed in (refs are already filtered to the role)
  useEffect(() => {
    if (!me) return;
    let alive = true;
    getHealth().then((h) => alive && setHealth(h)).catch(() => alive && setHealth({ ok: false }));
    getRefs().then((r) => {
      if (!alive) return;
      const list = r.refs || [];
      setRefs(list);
      if (list.length && !list.some((x) => x.ref === selectedRef)) setSelectedRef("main");
    }).catch(() => {});
    return () => { alive = false; abortRef.current?.(); };
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishSignIn = useCallback(async (promise) => {
    setAuthBusy(true); setAuthError(null);
    try { const r = await promise; setMe(r.user); }
    catch (e) { setAuthError(e.message); }
    finally { setAuthBusy(false); }
  }, []);
  const signIn = useCallback((email, password) => finishSignIn(login(email, password)), [finishSignIn]);
  const signOut = useCallback(async () => {
    abortRef.current?.();
    setAsking(false); setTurns([]); setActiveId(null);
    try { await logout(); } catch { /* cookie may already be gone */ }
    setMe(null);
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
      question: q, refs: [selectedRef], onEvent: handleEvent,
      onError: (err) => {
        if (err.status === 401) { setMe(null); return; }          // session expired: back to the login page
        patchLast((t) => ({ ...t, status: "", error: { code: "network", message: err.message } }));
        setAsking(false);
      },
    });
  }, [asking, selectedRef, handleEvent, patchLast]);

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
  return { me, authCfg, authError, authBusy, signIn, signOut,
           health, refs, selectedRef, setSelectedRef, turns, active, select: setActiveId, asking, ask, stop, reset };
}
