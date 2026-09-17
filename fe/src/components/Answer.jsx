import React, { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown.jsx";
import Timeline from "./Timeline.jsx";
import Trace from "./Trace.jsx";
import DataTable from "./DataTable.jsx";
import TemplatePreview from "./TemplatePreview.jsx";
import Workflow from "./Workflow.jsx";
import TriageCard from "./TriageCard.jsx";

// Where the technical answer's second section starts ("2. Evidence path", "## 2. Evidence path", "2. **Evidence path**").
const TECH_SPLIT = /^\s*(?:#{1,6}\s*)?\*{0,2}2\.\s*\*{0,2}\s*(?:Evidence|Under the hood)/m;
const splitTechnical = (text) => {
  const m = TECH_SPLIT.exec(text || "");
  return m ? { head: text.slice(0, m.index).trimEnd(), tail: text.slice(m.index) } : { head: text, tail: "" };
};

export default function Answer({ turn, asking, onFeedback, onRate }) {
  const [copied, setCopied] = useState(false);
  const [rated, setRated] = useState(null);   // "up" | "down" once the person has answered "Helpful?"
  const simple = turn.intent === "simple";
  const hasTrace = turn.claims.length > 0;
  const flow = turn.flow || null;

  // Workflow sync: the drawing walks through its steps once when it arrives, then follows the reader's hover.
  const [active, setActive] = useState(null);
  const [hover, setHover] = useState(null);
  const [visited, setVisited] = useState(() => new Set());
  const proseRef = useRef(null);
  useEffect(() => {
    if (!flow || asking) return undefined;
    let i = 0; setVisited(new Set());
    const tick = () => { if (i >= flow.steps.length) { setActive(null); return; } const id = flow.steps[i++].id; setActive(id); setVisited((v) => new Set([...v, id])); t = setTimeout(tick, 900); };
    let t = setTimeout(tick, 400);
    return () => clearTimeout(t);
  }, [flow, asking]);
  const onStepClick = (id) => {
    setActive(id);
    const el = proseRef.current?.querySelector(`.step-ref[data-step="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("step-ref--flash"); setTimeout(() => el?.classList.remove("step-ref--flash"), 1200);
  };
  const stepCtl = flow ? { active: hover || active, onHover: setHover, onClick: (id) => setActive(id) } : null;

  const copy = async () => {
    try { await navigator.clipboard.writeText(turn.text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ }
  };

  const trace = hasTrace && <Trace claims={turn.claims} evidence={turn.evidence} defaultMode={simple ? "list" : "flow"} />;

  return (
    <div className="answer">
      <Timeline steps={turn.steps} asking={asking} startedAt={turn.startedAt} ms={turn.summary?.ms} />

      {turn.triage && <TriageCard t={turn.triage} onFeedback={(ok) => onFeedback?.(turn, ok)} />}

      {turn.text && (
        <div className={flow ? "answer-split" : undefined}>
          <div className="prose-wrap" ref={proseRef}>
            {(() => {
              // A technical answer is two layers: section 1 in plain words, then evidence, data, defects, gaps and
              // confidence. The first is the page; the rest folds under "Technical detail" until someone asks for it.
              const { head, tail } = simple ? { head: turn.text, tail: "" } : splitTechnical(turn.text);
              return (
                <>
                  <Markdown text={head} step={stepCtl} />
                  {tail && (
                    <details className="details details--technical">
                      <summary>Technical detail<span className="muted"> · evidence path, data, defects, gaps, confidence</span></summary>
                      <div className="prose-tech"><Markdown text={tail} step={stepCtl} /></div>
                    </details>
                  )}
                </>
              );
            })()}
            <button type="button" className="ghost ghost--sm copy" onClick={copy}>{copied ? "copied" : "copy"}</button>
            {!asking && !turn.triage && (
              <div className="rate" role="group" aria-label="Was this answer helpful?">
                <span className="rate-q">{rated === "up" ? "Thanks, noted." : rated === "down" ? "Noted. This question goes to the review list." : "Helpful?"}</span>
                {!rated && <button type="button" className="ghost ghost--sm rate-btn" onClick={() => { setRated("up"); onRate?.(turn, true); }}>Yes</button>}
                {!rated && <button type="button" className="ghost ghost--sm rate-btn" onClick={() => { setRated("down"); onRate?.(turn, false); }}>No</button>}
              </div>
            )}
          </div>
          {flow && (
            <aside className="answer-side" aria-label="Workflow">
              <div className="wf-head">
                <span className="label">Workflow · {flow.steps.length} steps</span>
                <span className="wf-legend">
                  {[...new Set(flow.steps.map((s) => s.actor))].map((a) => <span key={a}><i className={`sw sw--actor-${a}`} />{a}</span>)}
                </span>
              </div>
              <Workflow flow={flow} active={hover || active} visited={visited} onSelect={onStepClick} />
              {flow.partial && <p className="note wf-note">Some steps could not be tied to a fact in the graph and are drawn dashed.</p>}
            </aside>
          )}
        </div>
      )}
      {!turn.text && !asking && hasTrace && <p className="note">No prose came back, but the path below is read straight from the graph and stands on its own.</p>}

      {/* A template the question is about, laid out as the dashboard shows it. */}
      {(turn.templates || []).map((t) => <TemplatePreview key={t.id} t={t} />)}

      {/* Complete result sets from the live platform mirror: exact rows, the prose only summarises them. */}
      {(turn.tables || []).map((t, i) => <DataTable key={`${t.source}-${i}`} table={t} />)}

      {/* The evidence path stays folded for every role: the answer is the page, the path is there for whoever asks.
          It opens by itself only when no prose came back, so the reader is never left with nothing. */}
      {hasTrace && (
        <details className="details details--evidence" open={!turn.text && !asking ? true : undefined}>
          <summary>
            {asking ? <><span className="live-dot" aria-hidden="true" /> Gathering evidence</> : "Show the evidence path"}
            <span className="muted"> · {turn.claims.length} fact{turn.claims.length === 1 ? "" : "s"}{asking ? " so far" : ""}</span>
          </summary>
          {trace}
        </details>
      )}

      {/* Not an error: the trail stopping here is a correct, useful outcome. */}
      {turn.unresolved.length > 0 && (
        <div className="stops">
          <div className="label">Where the trail stops</div>
          {turn.unresolved.map((u, i) => (
            <div key={`${u.fqn}-${u.line}-${i}`} className="stop-row">
              <span className="mono">{u.path}{u.line ? `:${u.line}` : ""}</span>
              <span className="muted">{u.reason}</span>
            </div>
          ))}
        </div>
      )}

      {turn.truncated && (
        <div className="note">Trace bounded: {turn.truncated.reason}{turn.truncated.at_depth ? ` at depth ${turn.truncated.at_depth}` : ""}.</div>
      )}

      {turn.error && <div className="error">{turn.error.message}{hasTrace ? " The path above is still read from the graph and stays valid." : ""}</div>}

      {turn.summary && (
        <div className="receipt">
          {turn.summary.confidence && <span className={`conf conf--${turn.summary.confidence}`}>confidence {turn.summary.confidence}</span>}
          <span>{turn.summary.claim_count} hops</span>
          <span>{turn.summary.evidence_count} sources</span>
          {turn.summary.unresolved_count ? <span>{turn.summary.unresolved_count} unresolved</span> : null}
          <span>read from {(turn.summary.refs || []).join(", ")}</span>
          <span>{(turn.summary.ms / 1000).toFixed(1)} s{turn.summary.timings ? ` · plan ${(turn.summary.timings.plan_ms / 1000).toFixed(1)} · read ${(turn.summary.timings.retrieve_ms / 1000).toFixed(1)} · write ${(turn.summary.timings.answer_ms / 1000).toFixed(1)}` : ""}</span>
          {turn.summary.mode && <span>{turn.summary.mode}</span>}
        </div>
      )}
    </div>
  );
}
