import React, { useState } from "react";
import Markdown from "./Markdown.jsx";
import Timeline from "./Timeline.jsx";
import Trace from "./Trace.jsx";

export default function Answer({ turn, asking }) {
  const [copied, setCopied] = useState(false);
  const simple = turn.intent === "simple";
  const hasTrace = turn.claims.length > 0;

  const copy = async () => {
    try { await navigator.clipboard.writeText(turn.text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ }
  };

  const trace = hasTrace && <Trace claims={turn.claims} evidence={turn.evidence} defaultMode={simple ? "list" : "flow"} />;

  return (
    <div className="answer">
      <Timeline steps={turn.steps} asking={asking} startedAt={turn.startedAt} ms={turn.summary?.ms} />

      {turn.text && (
        <div className="prose-wrap">
          <Markdown text={turn.text} />
          <button type="button" className="ghost ghost--sm copy" onClick={copy}>{copied ? "copied" : "copy"}</button>
        </div>
      )}
      {!turn.text && !asking && hasTrace && <p className="note">No prose came back, but the path below is read straight from the graph and stands on its own.</p>}

      {simple && hasTrace ? (
        <details className="details" open={!turn.text}>
          <summary>Show the evidence path</summary>
          {trace}
        </details>
      ) : trace}

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
