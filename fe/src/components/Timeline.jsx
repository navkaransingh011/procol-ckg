import React, { useEffect, useState } from "react";

/**
 * The wait, made legible: every `status` event as a step, the current one pulsing, with elapsed
 * time. Once the answer lands it collapses to a single line that can be reopened.
 */
export default function Timeline({ steps, asking, startedAt, ms }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!asking) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [asking]);
  if (!steps?.length) return null;

  const elapsed = asking ? (now - startedAt) / 1000 : (ms || 0) / 1000;
  if (!asking && !open) {
    return (
      <button type="button" className="timeline-summary" onClick={() => setOpen(true)}>
        <span className="tick" aria-hidden="true">✓</span>
        {steps.length} step{steps.length === 1 ? "" : "s"} · {elapsed.toFixed(1)} s
        <span className="muted"> · show</span>
      </button>
    );
  }
  return (
    <ol className={`timeline${asking ? " timeline--live" : ""}`} aria-live="polite">
      {steps.map((s, i) => {
        const current = asking && i === steps.length - 1;
        return (
          <li key={i} className={`step${current ? " step--now" : ""}`} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
            <span className="step-dot" aria-hidden="true" />
            <span className="step-text">{s}</span>
            {current && <span className="step-time">{elapsed.toFixed(0)} s</span>}
          </li>
        );
      })}
      {!asking && <li className="step step--end"><button type="button" className="ghost ghost--sm" onClick={() => setOpen(false)}>hide</button></li>}
    </ol>
  );
}
