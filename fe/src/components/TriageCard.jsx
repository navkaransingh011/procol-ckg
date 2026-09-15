import React, { useState } from "react";

/**
 * The triage card: who can resolve the ticket and why, every line pointing at a fact the service collected.
 * The verdict was chosen by the model only from what the facts allow; a downgraded verdict says so.
 */
const VERDICT = {
  knowledge:   { label: "CS can resolve",        hint: "a guide or the product screens cover this" },
  config:      { label: "Needs a config change", hint: "a switch governs it; an admin changes it, the agent never does" },
  engineering: { label: "Needs engineering",     hint: "a code path, a defect, or the behaviour does not exist" },
  more_info:   { label: "Need more information", hint: "the facts cannot tell yet" },
};

export default function TriageCard({ t, onFeedback }) {
  const [copied, setCopied] = useState("");
  const [voted, setVoted] = useState(null);
  const v = VERDICT[t.verdict] || VERDICT.more_info;
  const copy = async (what, text) => { try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1400); } catch { /* blocked */ } };
  const vote = (correct) => { setVoted(correct); onFeedback?.(correct); };
  const companies = t.customer?.companies || [];
  const handoffText = t.handoff ? [t.handoff.summary, ...(t.handoff.repro?.length ? ["Reproduce:", ...t.handoff.repro.map((r, i) => `${i + 1}. ${r}`)] : []), ...(t.handoff.facts?.length ? ["Facts:", ...t.handoff.facts.map((f) => `- ${f}`)] : [])].join("\n") : "";

  return (
    <div className={`triage triage--${t.verdict}`}>
      <div className="triage-head">
        <div>
          <span className={`verdict verdict--${t.verdict}`}>{v.label}</span>
          <span className="triage-conf">{t.confidence} confidence · {v.hint}</span>
          {t.verdict_requested && <span className="triage-down">the model proposed "{VERDICT[t.verdict_requested]?.label || t.verdict_requested}" but the facts did not support it</span>}
        </div>
        <div className="triage-vote" aria-label="Was this triage right?">
          <span>Right?</span>
          <button type="button" className={`tool tool--xs${voted === true ? " tool--on" : ""}`} onClick={() => vote(true)} title="Yes, this triage was right">👍</button>
          <button type="button" className={`tool tool--xs${voted === false ? " tool--on" : ""}`} onClick={() => vote(false)} title="No, this triage was wrong">👎</button>
        </div>
      </div>

      <div className="triage-grid">
        <section>
          <div className="label">Customer</div>
          {companies.length ? <ul className="triage-list">{companies.slice(0, 4).map((c) => <li key={c.id}>{c.name} <span className="muted">#{c.id}</span></li>)}{companies.length > 4 && <li className="muted">+{companies.length - 4} more</li>}</ul>
            : <p className="muted">Not named. Settings below are defaults; check the customer's own values.</p>}
        </section>
        <section>
          <div className="label">Trying to do</div>
          <p>{t.doing || "—"}</p>
          <div className="label">Likely cause</div>
          <p>{t.cause || "—"}</p>
        </section>
        <section>
          <div className="label">Likely feature</div>
          {(t.features_found || []).length ? <ul className="triage-list">{t.features_found.map((f) => <li key={f.name}><b>{f.name}</b> <span className="muted">{Math.round((f.share || 0) * 100)}% of evidence</span>{f.why?.[0] && <div className="muted small">{f.why[0]}</div>}</li>)}</ul> : <p className="muted">No feature stood out.</p>}
        </section>
      </div>

      {(t.switches || []).length > 0 && (
        <section className="triage-sec">
          <div className="label">Settings that govern it</div>
          <div className="tpl-scroll">
            <table className="triage-table">
              <thead><tr><th>Switch</th><th>Value for this customer</th><th>Source</th><th>Read by the feature's code</th></tr></thead>
              <tbody>
                {t.switches.slice(0, 6).map((s) => (
                  <tr key={s.config_key} className={(t.switches_to_check || []).includes(s.config_key) ? "triage-row--hot" : ""}>
                    <td><b>{s.name || s.config_key}</b><div className="muted small mono">{s.config_key}</div></td>
                    <td>{(s.for_customer || []).length ? s.for_customer.map((c) => <div key={c.company_id}>{JSON.stringify(c.effective)} <span className="muted small">{c.company} #{c.company_id}</span></div>) : <span>{JSON.stringify(s.effective)}</span>}</td>
                    <td className="muted">{(s.for_customer || [])[0]?.source || s.source}</td>
                    <td className="muted">{s.read_in_feature === null || s.read_in_feature === undefined ? "—" : s.read_in_feature ? "yes" : "not found"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="triage-grid">
        {(t.guides || []).length > 0 && <section><div className="label">Guides</div><ul className="triage-list">{t.guides.slice(0, 4).map((g, i) => <li key={i}>{g.title}{g.heading ? <span className="muted"> § {g.heading}</span> : null}</li>)}</ul></section>}
        {(t.screens || []).length > 0 && <section><div className="label">Where in the product</div><ul className="triage-list">{t.screens.map((s) => <li key={s.route_path}><b>{s.screen}</b>{s.key_actions?.length ? <div className="muted small">{s.key_actions.slice(0, 6).join(" · ")}</div> : null}</li>)}</ul></section>}
        {((t.owners || []).length > 0 || (t.process_owners || []).length > 0) && (
          <section><div className="label">Who to ask</div>
            <ul className="triage-list">
              {(t.owners || []).map((o) => <li key={o.email || o.name}><b>{o.name}</b>{o.email ? <span className="muted"> · {o.email}</span> : null}<div className="muted small">{o.commits} commits in this area{o.last_commit ? `, last ${new Date(o.last_commit).toLocaleDateString()}` : ""}</div></li>)}
              {(t.process_owners || []).map((o, i) => <li key={`p${i}`}><b>{o.owner}</b><span className="muted"> · owns “{o.document}”</span></li>)}
            </ul>
          </section>
        )}
      </div>

      {(t.checks || []).length > 0 && <section className="triage-sec"><div className="label">Check first</div><ol className="triage-ol">{t.checks.map((c, i) => <li key={i}>{c}</li>)}</ol></section>}

      {t.verdict === "more_info" && (t.questions || []).length > 0 && <section className="triage-sec"><div className="label">Ask the customer</div><ol className="triage-ol">{t.questions.map((c, i) => <li key={i}>{c}</li>)}</ol></section>}

      {t.reply_draft && t.verdict !== "engineering" && (
        <section className="triage-sec triage-reply">
          <div className="triage-sec-head"><div className="label">Suggested reply</div><button type="button" className="ghost ghost--sm" onClick={() => copy("reply", t.reply_draft)}>{copied === "reply" ? "copied" : "copy"}</button></div>
          <p className="triage-draft">{t.reply_draft}</p>
        </section>
      )}
      {t.verdict === "engineering" && (t.handoff || t.reply_draft) && (
        <section className="triage-sec triage-reply">
          <div className="triage-sec-head"><div className="label">Note for engineering</div><button type="button" className="ghost ghost--sm" onClick={() => copy("handoff", handoffText || t.reply_draft)}>{copied === "handoff" ? "copied" : "copy"}</button></div>
          <p className="triage-draft">{t.handoff?.summary || t.reply_draft}</p>
          {t.handoff?.repro?.length > 0 && <ol className="triage-ol">{t.handoff.repro.map((r, i) => <li key={i}>{r}</li>)}</ol>}
          {t.handoff?.facts?.length > 0 && <ul className="triage-list small">{t.handoff.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </section>
      )}
      <div className="triage-foot">Grounded in the code graph, the guides, the dashboard screens and the customer's live configuration. The agent reads settings; it never changes them.</div>
    </div>
  );
}
