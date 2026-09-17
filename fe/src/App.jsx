import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import Background from "./components/Background.jsx";
import IconField from "./components/IconField.jsx";
import Login from "./components/Login.jsx";
import Composer from "./components/Composer.jsx";
import Answer from "./components/Answer.jsx";
import { useAgent } from "./useAgent.js";

// Starters follow the role: engineers get code-shaped questions, everyone else gets product-shaped ones.
const SUGGESTIONS = {
  code: [
    "What happens when GET /activity_logs is called?",
    "Which dashboard screens fetch pending approvals?",
    "What happens if I add a third Session token_type?",
  ],
  plain: [
    "How do approval workflows decide who approves a PO?",
    "Which master configs are on by default?",
    "What does the flexi PO lock setting change for a buyer?",
  ],
};

/** Saved chats, newest first, grouped by day. Strictly the signed-in person's own. */
function ChatList({ chats, activeId, onOpen, onNew, onDelete, onRename }) {
  const dayOf = (iso) => {
    const d = new Date(iso), now = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, now)) return "Today";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (same(d, y)) return "Yesterday";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  const groups = [];
  for (const c of chats) { const k = dayOf(c.updated_at); const g = groups[groups.length - 1]; if (g && g.day === k) g.items.push(c); else groups.push({ day: k, items: [c] }); }
  const rename = (c) => { const t = window.prompt("Rename chat", c.title || ""); if (t != null && t.trim()) onRename(c.id, t.trim()); };
  return (
    <nav className="chats" aria-label="Your chats">
      <button type="button" className="chats-new" onClick={onNew}><span aria-hidden="true">＋</span> New chat</button>
      {groups.length === 0 && <p className="chats-empty">Your questions will be saved here.</p>}
      {groups.map((g) => (
        <div key={g.day} className="chats-group">
          <div className="chats-day">{g.day}</div>
          {g.items.map((c) => (
            <div key={c.id} className={`chat-row${c.id === activeId ? " chat-row--on" : ""}`}>
              <button type="button" className="chat-open" onClick={() => onOpen(c.id)} title={c.title || "Untitled"}>{c.title || "Untitled"}</button>
              <span className="chat-tools">
                <button type="button" className="tool tool--xs" onClick={() => rename(c)} title="Rename" aria-label="Rename chat">✎</button>
                <button type="button" className="tool tool--xs" onClick={() => { if (window.confirm("Delete this chat?")) onDelete(c.id); }} title="Delete" aria-label="Delete chat">×</button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Suggestion chip that tilts a few degrees toward the pointer. */
function Suggestion({ text, onClick }) {
  const ref = useRef(null);
  const move = (e) => {
    const r = ref.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    ref.current.style.transform = `perspective(500px) rotateX(${-y * 8}deg) rotateY(${x * 10}deg) translateY(-1px)`;
  };
  const leave = () => { ref.current.style.transform = ""; };
  return <button ref={ref} type="button" className="suggestion" onPointerMove={move} onPointerLeave={leave} onClick={onClick}>{text}</button>;
}

export default function App() {
  const g = useAgent();
  const input = useRef(null);
  const bar = useRef(null);
  const live = g.turns.length > 0 || g.loadingChat;
  const offline = g.health && g.health.ok === false;
  const [ticketMode, setTicketMode] = useState(false);
  const askMaybeTicket = (text, opts) => g.ask(ticketMode && !/^(triage|ticket)\s*[:#-]/i.test(text) ? `triage: ${text}` : text, opts);
  const [sidebar, setSidebar] = useState(() => { try { return localStorage.getItem("ckg_sidebar") !== "0"; } catch { return true; } });
  const toggleSidebar = () => setSidebar((v) => { try { localStorage.setItem("ckg_sidebar", v ? "0" : "1"); } catch { /* ignore */ } return !v; });
  const suggestions = g.me?.can?.code_source ? SUGGESTIONS.code : SUGGESTIONS.plain;
  // one option per branch name, labelled with the tenant and environment the refs endpoint reports for it
  const refNames = [...new Set(g.refs.map((r) => r.ref))].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
  const refLabel = (name) => {
    const rows = g.refs.filter((r) => r.ref === name);
    const tenant = [...new Set(rows.map((r) => r.tenant).filter(Boolean))].join("/");
    const env = [...new Set(rows.map((r) => r.env).filter(Boolean))].join("/");
    return tenant || env ? `${name} · ${[tenant, env].filter(Boolean).join(" ")}` : name;
  };

  // `/` focuses the composer from anywhere; Esc stops a running question.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.current?.focus(); }
      if (e.key === "Escape" && g.asking && !typing) g.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [g.asking, g.stop]);

  // The icon field dissolves exactly where the question bar sits, so tell CSS where that is.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      document.documentElement.style.setProperty("--bar-y", `${Math.round(r.top + r.height / 2)}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el); ro.observe(document.body);
    window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, [live]);

  if (g.me === undefined) return <div className="app"><Background /><IconField /></div>;   // checking the session
  if (!g.me) return (
    <div className="app app--login">
      <Background />
      <IconField />
      <Login cfg={g.authCfg} onSignIn={g.signIn} error={g.authError} busy={g.authBusy} />
    </div>
  );

  return (
    <div className={`app${live ? " app--live" : ""}${sidebar ? " app--sidebar" : ""}`}>
      <Background dim={live} />
      <IconField dim={live} />
      <div className="chats-slot" aria-hidden={!sidebar} inert={sidebar ? undefined : ""}>
        <ChatList chats={g.chats} activeId={g.chatId} onOpen={g.openChat} onNew={g.newChat} onDelete={g.removeChat} onRename={g.renameChat} />
      </div>
      <header className="top">
        <div className="top-left">
          <button type="button" className="tool tool--menu" onClick={toggleSidebar} aria-label={sidebar ? "Hide chats" : "Show chats"} title={sidebar ? "Hide chats" : "Show chats"} aria-expanded={sidebar}>☰</button>
          <button type="button" className="brand" onClick={g.newChat} title="New chat">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>Code Graph
          </button>
        </div>
        <div className="top-right">
          {refNames.length > 1 && (
            <label className="refpick" title="Branch to read">
              <span className="ref-dot" aria-hidden="true" />
              <select value={g.selectedRef} onChange={(e) => g.setSelectedRef(e.target.value)} disabled={g.asking} aria-label="Branch">
                {refNames.map((r) => <option key={r} value={r}>{refLabel(r)}</option>)}
              </select>
            </label>
          )}
          {live && <button type="button" className="ghost" onClick={g.newChat}>New chat</button>}
          <div className="who" title={g.me.email}>
            {g.me.picture ? <img className="avatar" src={g.me.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar avatar--txt" aria-hidden="true">{(g.me.name || g.me.email)[0].toUpperCase()}</span>}
            <span className="who-name">{g.me.name || g.me.email}</span>
            <span className={`role role--${g.me.role}`}>{g.me.label || g.me.role}</span>
            <button type="button" className="ghost ghost--sm" onClick={g.signOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="stage">
        {!live && (
          <div className="hero">
            <p className="eyebrow">Procol · Code Graph</p>
            <h1>Ask the <em>knowledge base</em>.</h1>
            <p>{g.me.can?.paths
              ? "Every answer names the file and line that proves it, and says so when it cannot tell."
              : "Every answer is grounded in the code, the documents and live platform data, and says so when it cannot tell."}</p>
          </div>
        )}

        {offline && (
          <div className="offline"><span className="offline-dot" aria-hidden="true" />The code graph service is not reachable. Start it with <code>npm run serve</code> in procol-ckg.</div>
        )}

        <div className="bar" ref={bar}>
          <Composer inputRef={input} onSend={askMaybeTicket} onStop={g.stop} asking={g.asking} disabled={offline} autoFocus
                    placeholder={ticketMode ? "Paste the ticket: what the customer says, which company, any error text" : g.me.can?.code_names ? "Ask about a file, an endpoint or a flow" : "Ask how something works on the platform"}
                    mode={ticketMode ? "ticket" : "ask"} onModeToggle={() => setTicketMode((v) => !v)} />
        </div>

        {!live && !offline && (
          <div className="suggestions">
            {suggestions.map((s) => <Suggestion key={s} text={s} onClick={() => g.ask(s)} />)}
          </div>
        )}

        {live && g.turns.length > 1 && (
          <div className="history" role="tablist">
            {g.turns.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={g.active?.id === t.id}
                className={`chip${g.active?.id === t.id ? " chip--on" : ""}`} onClick={() => g.select(t.id)} title={t.question}>
                {t.question}
              </button>
            ))}
          </div>
        )}

        {g.loadingChat && <p className="note">Opening the chat…</p>}
        {live && g.active && (
          <section className={`turn${g.active.flow ? " turn--wide" : ""}`} key={g.active.id}>
            <div className="asked">
              <span className="asked-q">{g.active.question}</span>
              {g.active.intent && <span className={`tag tag--${g.active.intent}`}>{g.active.intent === "simple" ? "plain answer" : "technical answer"}</span>}
              <span className="tag tag--ref">{g.active.refs.join(", ")}</span>
              {g.active.stored && !g.asking && (
                <button type="button" className="ghost ghost--sm" onClick={() => g.ask(g.active.question, { fresh: true })} title="Run this question again against today's graph and platform data">ask again</button>
              )}
            </div>
            {g.active.understoodAs && <p className="understood">understood as: <em>{g.active.understoodAs}</em></p>}
            {g.active.pruned && <p className="note">This answer is older than the retention window, so only its text was kept. Use "ask again" for the full view.</p>}
            <Answer turn={g.active} asking={g.asking && g.active.id === g.turns[g.turns.length - 1].id} onFeedback={g.feedback} />
          </section>
        )}
      </main>

      <footer className="meta">
        {g.health?.ok && <span>{Number(g.health.entities).toLocaleString()} facts · {Number(g.health.edges).toLocaleString()} edges · {g.health.refs} branches</span>}
        <span className="hint"><kbd>/</kbd> focus · <kbd>Esc</kbd> stop</span>
      </footer>
    </div>
  );
}
