import { useCallback, useEffect, useRef, useState } from "react";
import { askStream, createChat, deleteChat as apiDeleteChat, getAuthConfig, getChat, getHealth, getMe, getRefs, listChats, login, logout, renameChat as apiRenameChat, sendFeedback } from "./api.js";

const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

const newTurn = (question, refs, extra = {}) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  question, refs, startedAt: Date.now(), status: "", steps: [], text: "", claims: [], evidence: {},
  unresolved: [], truncated: null, error: null, summary: null, intent: null, tables: [], templates: [], flow: null, triage: null,
  understoodAs: null, stored: false, pruned: false, ...extra,
});

/** One event folded into a turn. Shared by the live stream and by replaying a saved chat. */
export function applyEvent(t, ev) {
  switch (ev.type) {
    case "intent": return { ...t, intent: ev.intent };
    case "status": return { ...t, status: ev.text, steps: [...t.steps, ev.text] };
    case "token": return { ...t, text: t.text + ev.text };
    case "claim": return { ...t, claims: [...t.claims, ev] };
    case "table": return { ...t, tables: [...(t.tables || []), ev] };
    case "template": return { ...t, templates: [...(t.templates || []), ev] };
    case "flow": return { ...t, flow: ev };
    case "triage": return { ...t, triage: ev };
    case "rewrite": return { ...t, understoodAs: ev.standalone };
    case "evidence": return { ...t, evidence: { ...t.evidence, [ev.id]: ev } };
    case "unresolved": return { ...t, unresolved: [...t.unresolved, ev] };
    case "truncated": return { ...t, truncated: ev };
    case "error": return { ...t, error: ev, status: "" };
    case "done": return { ...t, status: "", summary: ev };
    default: return t;
  }
}

/** A saved turn becomes a turn object by replaying its events; a pruned one keeps only its text. */
const fromStored = (st) => {
  let t = newTurn(st.question, st.refs || ["main"], { stored: true, pruned: !!st.pruned, startedAt: new Date(st.created_at).getTime(), understoodAs: st.standalone_question || null });
  if (Array.isArray(st.events)) for (const ev of st.events) t = applyEvent(t, ev);
  else t = { ...t, text: st.answer_text || "" };
  if (!t.summary) t = { ...t, summary: { type: "done", ms: st.ms, model: st.model, cached: st.cached } };
  return t;
};

const pathChatId = () => { const m = /^\/c\/([0-9a-f-]{36})$/.exec(window.location.pathname); return m ? m[1] : null; };
const setPath = (id) => { const want = id ? `/c/${id}` : "/"; if (window.location.pathname !== want) window.history.pushState({}, "", want); };

/**
 * All state. `me` is undefined while the session is being checked, null when signed out, else the user.
 * A chat is a thread of turns saved on the server; the active chat id is mirrored in the URL (/c/<id>).
 */
export function useAgent() {
  const [me, setMe] = useState(undefined);
  const [authCfg, setAuthCfg] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const [refs, setRefs] = useState([]);
  const [selectedRef, setSelectedRefState] = useState(() => read("ckg_ref", "main"));
  const [chats, setChats] = useState([]);
  const [chatId, setChatId] = useState(() => pathChatId());
  const [turns, setTurns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [asking, setAsking] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const abortRef = useRef(null);

  const setSelectedRef = useCallback((v) => { setSelectedRefState(v); write("ckg_ref", v); }, []);

  useEffect(() => {
    let alive = true;
    getAuthConfig().then((c) => alive && setAuthCfg(c)).catch(() => alive && setAuthCfg({ mode: "unknown" }));
    getMe().then((r) => alive && setMe(r.user)).catch(() => alive && setMe(null));
    return () => { alive = false; };
  }, []);

  const refreshChats = useCallback(() => listChats().then((r) => setChats(r.chats || [])).catch(() => {}), []);

  // graph facts, branches and the chat list, once signed in
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
    refreshChats();
    return () => { alive = false; abortRef.current?.(); };
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  // the chat in the URL, or one picked from the list, is loaded from the server and replayed
  const openChat = useCallback(async (id) => {
    abortRef.current?.(); setAsking(false);
    setChatId(id); setPath(id);
    if (!id) { setTurns([]); setActiveId(null); return; }
    setLoadingChat(true);
    try {
      const r = await getChat(id);
      const ts = (r.chat?.turns || []).map(fromStored);
      setTurns(ts); setActiveId(ts.length ? ts[ts.length - 1].id : null);
    } catch (e) {
      if (e.status === 401) { setMe(null); return; }
      setChatId(null); setPath(null); setTurns([]); setActiveId(null);
    } finally { setLoadingChat(false); }
  }, []);
  useEffect(() => { if (me && chatId && turns.length === 0) openChat(chatId); }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onPop = () => { const id = pathChatId(); if (id !== chatId) openChat(id); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [chatId, openChat]);

  const finishSignIn = useCallback(async (promise) => {
    setAuthBusy(true); setAuthError(null);
    try { const r = await promise; setMe(r.user); }
    catch (e) { setAuthError(e.message); }
    finally { setAuthBusy(false); }
  }, []);
  const signIn = useCallback((email, password) => finishSignIn(login(email, password)), [finishSignIn]);
  const signOut = useCallback(async () => {
    abortRef.current?.();
    setAsking(false); setTurns([]); setActiveId(null); setChats([]); setChatId(null); setPath(null);
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
    if (ev.type === "chat") {           // the server tells us which chat this turn landed in (new ones are created on the fly)
      setChatId((cur) => { if (cur !== ev.id) setPath(ev.id); return ev.id; });
      if (ev.is_new) refreshChats();
      return;
    }
    patchLast((t) => applyEvent(t, ev));
    if (ev.type === "done") { setAsking(false); refreshChats(); }
  }, [patchLast, refreshChats]);

  const ask = useCallback((question, { fresh = false } = {}) => {
    const q = (question || "").trim();
    if (!q || asking) return;
    abortRef.current?.();
    const turn = newTurn(q, [selectedRef]);
    setTurns((prev) => [...prev, turn]);
    setActiveId(turn.id);
    setAsking(true);
    abortRef.current = askStream({
      question: q, refs: [selectedRef], chatId, fresh, onEvent: handleEvent,
      onError: (err) => {
        if (err.status === 401) { setMe(null); return; }
        patchLast((t) => ({ ...t, status: "", error: { code: "network", message: err.message } }));
        setAsking(false);
      },
    });
  }, [asking, selectedRef, chatId, handleEvent, patchLast]);

  const stop = useCallback(() => {
    abortRef.current?.();
    setAsking(false);
    patchLast((t) => ({ ...t, status: "", steps: [...t.steps, "stopped"] }));
  }, [patchLast]);

  const newChat = useCallback(() => { abortRef.current?.(); setAsking(false); setTurns([]); setActiveId(null); setChatId(null); setPath(null); }, []);
  const removeChat = useCallback(async (id) => {
    try { await apiDeleteChat(id); } catch { /* already gone */ }
    setChats((cs) => cs.filter((c) => c.id !== id));
    if (id === chatId) newChat();
  }, [chatId, newChat]);
  const renameChat = useCallback(async (id, title) => {
    try { const r = await apiRenameChat(id, title); setChats((cs) => cs.map((c) => (c.id === id ? { ...c, title: r.chat.title } : c))); } catch { /* keep old title */ }
  }, []);

  const feedback = useCallback((turn, correct) => {
    const seq = turns.indexOf(turn) + 1;
    sendFeedback({ chat_id: chatId, seq, verdict: turn.triage?.verdict || null, correct }).catch(() => {});
  }, [chatId, turns]);

  const active = turns.find((t) => t.id === activeId) || turns[turns.length - 1] || null;
  return { me, authCfg, authError, authBusy, signIn, signOut, feedback,
           health, refs, selectedRef, setSelectedRef,
           chats, chatId, openChat, newChat, removeChat, renameChat, loadingChat,
           turns, active, select: setActiveId, asking, ask, stop, reset: newChat };
}
