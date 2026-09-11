import React from "react";
import TracePath from "./TracePath.jsx";

export default function Answer({ turn }) {
  return (
    <div className="answer">
      {turn.status && (
        <div className="status"><span className="pulse" />{turn.status}</div>
      )}

      {turn.text && <div className="prose">{turn.text}</div>}

      <TracePath claims={turn.claims} evidence={turn.evidence} />

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

      {turn.error && <div className="error">{turn.error.message}</div>}

      {turn.summary && (
        <div className="receipt">
          <span>{turn.summary.claim_count} hops</span>
          <span>{turn.summary.evidence_count} sources</span>
          {turn.summary.unresolved_count ? <span>{turn.summary.unresolved_count} unresolved</span> : null}
          <span>{(turn.summary.refs || []).join(", ")}</span>
          <span>{(turn.summary.ms / 1000).toFixed(1)} s</span>
        </div>
      )}
    </div>
  );
}
