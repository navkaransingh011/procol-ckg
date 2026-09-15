import React, { useLayoutEffect, useRef, useState } from "react";

/**
 * The door. One card at the centre: the brand, a serif line, email and password. Accounts are created by
 * an engineer (npm run users -- add), so there is no sign-up here. The icon field behind it dissolves as it
 * reaches the card, the same way it does at the question bar.
 */
export default function Login({ cfg, onSignIn, error, busy }) {
  const card = useRef(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      document.documentElement.style.setProperty("--bar-y", `${Math.round(r.top + 40)}px`);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);

  const submit = (e) => { e.preventDefault(); if (!busy && email && password) onSignIn(email.trim(), password); };

  return (
    <main className="login">
      <section className="login-card" ref={card} aria-labelledby="login-title">
        <span className="brand-mark brand-mark--lg" aria-hidden="true"><i /><i /><i /></span>
        <p className="eyebrow">Procol · Code Graph</p>
        <h1 id="login-title">Ask the codebase <em>what it does</em>.</h1>
        <p className="login-sub">Sign in with your Procol account. Your role decides how much of the code an answer shows.</p>

        <form className="devform" onSubmit={submit}>
          <label className="field-l">
            <span>Email</span>
            <input type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`you@${cfg?.domain || "procol.in"}`}
                   autoComplete="username" autoFocus spellCheck={false} required />
          </label>
          <label className="field-l">
            <span>Password</span>
            <span className="pw">
              <input type={show ? "text" : "password"} name="password" value={password} onChange={(e) => setPassword(e.target.value)}
                     autoComplete="current-password" required minLength={8} />
              <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>{show ? "Hide" : "Show"}</button>
            </span>
          </label>
          <button type="submit" className="primary" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>

        {error && <p className="login-err" role="alert">{error}</p>}
        <p className="devnote">No account yet? Ask an engineer on the Code Graph to add you.</p>
      </section>
      <p className="login-foot">Only {cfg?.domain || "procol.in"} accounts. Nothing here changes platform data.</p>
    </main>
  );
}
