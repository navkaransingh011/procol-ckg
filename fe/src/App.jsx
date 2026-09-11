import React, { useEffect, useRef } from "react";
import Background from "./components/Background.jsx";
import Composer from "./components/Composer.jsx";
import Answer from "./components/Answer.jsx";
import { useAgent } from "./useAgent.js";

const SUGGESTIONS = [
  "What happens when GET /activity_logs is called?",
  "Which dashboard screens fetch pending approvals?",
  "What happens if I add a third Session token_type?",
];

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
  const live = g.turns.length > 0;
  const offline = g.health && g.health.ok === false;
  const refNames = [...new Set(g.refs.map((r) => r.ref))].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));

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

  return (
    <div className={`app${live ? " app--live" : ""}`}>
      <Background dim={live} />
      <header className="top">
        <button type="button" className="brand" onClick={g.reset} title="Start over">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>Code Graph
        </button>
        <div className="top-right">
          <div className="seg" role="tablist" aria-label="Answer style">
            {[["auto", "Auto"], ["simple", "Simple"], ["code", "Code"]].map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={g.style === v}
                className={`seg-btn${g.style === v ? " seg-btn--on" : ""}`}
                onClick={() => g.setStyle(v)} disabled={g.asking}>{label}</button>
            ))}
          </div>
          {refNames.length > 1 && (
            <label className="refpick" title="Branch to read">
              <span className="ref-dot" aria-hidden="true" />
              <select value={g.selectedRef} onChange={(e) => g.setSelectedRef(e.target.value)} disabled={g.asking} aria-label="Branch">
                {refNames.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}
          {live && <button type="button" className="ghost" onClick={g.reset}>New question</button>}
        </div>
      </header>

      <main className="stage">
        {!live && (
          <div className="hero">
            <h1>Ask the codebase.</h1>
            <p>Every answer names the file and line that proves it, and says so when it cannot tell.</p>
          </div>
        )}

        {offline && (
          <div className="offline"><span className="offline-dot" aria-hidden="true" />The code graph service is not reachable. Start it with <code>npm run serve</code> in procol-ckg.</div>
        )}

        <Composer inputRef={input} onSend={g.ask} onStop={g.stop} asking={g.asking} disabled={offline} autoFocus />

        {!live && !offline && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => <Suggestion key={s} text={s} onClick={() => g.ask(s)} />)}
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

        {live && g.active && (
          <section className="turn" key={g.active.id}>
            <div className="asked">
              <span className="asked-q">{g.active.question}</span>
              {g.active.intent && <span className={`tag tag--${g.active.intent}`}>{g.active.intent === "simple" ? "plain answer" : "technical answer"}</span>}
              <span className="tag tag--ref">{g.active.refs.join(", ")}</span>
            </div>
            <Answer turn={g.active} asking={g.asking && g.active.id === g.turns[g.turns.length - 1].id} />
          </section>
        )}
      </main>

      <footer className="meta">
        {g.health?.ok && <span>{Number(g.health.entities).toLocaleString()} facts · {Number(g.health.edges).toLocaleString()} edges · {g.health.refs} branches</span>}
        {g.health?.ok && g.health.auth_mode === "dev" && <span className="warn">dev auth</span>}
        <span className="hint"><kbd>/</kbd> focus · <kbd>Esc</kbd> stop</span>
      </footer>
    </div>
  );
}
