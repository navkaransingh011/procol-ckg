import React from "react";
import Composer from "./components/Composer.jsx";
import Answer from "./components/Answer.jsx";
import { useAgent } from "./useAgent.js";

const SUGGESTIONS = [
  "What happens when GET /activity_logs is called?",
  "Which dashboard screens fetch pending approvals?",
  "What happens if I add a third Session token_type?",
];

export default function App() {
  const g = useAgent();
  const live = g.turns.length > 0;
  const offline = g.health && g.health.ok === false;
  const refNames = [...new Set(g.refs.map((r) => r.ref))].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));

  return (
    <div className={`app${live ? " app--live" : ""}`}>
      <header className="top">
        <span className="brand"><span className="brand-mark" aria-hidden="true" />Code Graph</span>
        <div className="top-right">
          {refNames.length > 1 && (
            <label className="refpick">
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
          <div className="offline">The code graph service is not reachable. Start it with <code>npm run serve</code> in procol-ckg.</div>
        )}

        <Composer onSend={g.ask} onStop={g.stop} asking={g.asking} disabled={offline} autoFocus />

        {!live && !offline && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="suggestion" onClick={() => g.ask(s)}>{s}</button>
            ))}
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
          <section className="turn">
            <div className="asked">{g.active.question}</div>
            <Answer turn={g.active} />
          </section>
        )}
      </main>

      <footer className="meta">
        {g.health?.ok && <span>{Number(g.health.entities).toLocaleString()} facts · {g.health.refs} branches</span>}
        {g.health?.ok && g.health.auth_mode === "dev" && <span className="warn">dev auth</span>}
      </footer>
    </div>
  );
}
