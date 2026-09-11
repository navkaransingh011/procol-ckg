import React, { useEffect, useState } from "react";
import { edgeLabel, whereOf } from "../lib/graph.js";

/** Slide-in card for one hop: kind, name, repo, path:line, ref, commit, extractor, confidence. */
export default function EvidencePanel({ node, onClose }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [node]);
  useEffect(() => {
    if (!node) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [node, onClose]);
  if (!node) return null;

  const { claim, ev } = node;
  const where = whereOf(claim, ev);
  const copy = async () => {
    try { await navigator.clipboard.writeText(where); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked */ }
  };
  const rows = [
    ["repo", ev?.repo || (claim.kind === "HTTP_ENDPOINT" ? "shared contract" : claim.kind === "DOCUMENT" ? "uploaded document (DOCUMENTED: intent, not proof)" : "—")],
    ["ref", ev?.ref || "—"],
    ["commit", ev?.commit || "—"],
    ["extractor", ev?.extractor || "—"],
    ["reached via", claim.edge ? edgeLabel(claim.edge) : "anchor"],
    ["depth", String(claim.depth ?? 0)],
    ["confidence", claim.confidence != null ? `${Math.round(Number(claim.confidence) * 100)}%` : "—"],
  ];

  return (
    <aside className={`evidence evidence--${node.side}`} aria-label="Evidence">
      <div className="evidence-head">
        <span className="evidence-kind">{node.kind}</span>
        <button type="button" className="ghost ghost--sm" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="evidence-name">{claim.name || claim.text}</div>
      <div className="evidence-where">
        <code>{where}</code>
        {ev?.path && <button type="button" className="ghost ghost--sm" onClick={copy}>{copied ? "copied" : "copy"}</button>}
      </div>
      <dl className="evidence-rows">
        {rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}
      </dl>
      {claim.text && claim.text !== claim.name && <p className="evidence-text">{claim.text}</p>}
    </aside>
  );
}
