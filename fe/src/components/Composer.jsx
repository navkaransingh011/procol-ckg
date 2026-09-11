import React, { useEffect, useRef, useState } from "react";

/**
 * The question pill. Glass over the constellation, a rotating gradient hairline while focused or
 * busy, and a soft spotlight that follows the pointer. `/` focuses it from anywhere; Esc stops.
 */
export default function Composer({ onSend, onStop, asking, disabled, autoFocus, inputRef }) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const localRef = useRef(null);
  const ref = inputRef || localRef;
  const shell = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) { el.style.height = ""; return; } // one row; never let a wrapped placeholder ratchet it up
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, ref]);

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus, ref]);

  const send = () => {
    if (!value.trim() || asking || disabled) return;
    onSend(value);
    setValue("");
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape" && asking) { e.preventDefault(); onStop(); }
  };

  const onMove = (e) => {
    const r = shell.current.getBoundingClientRect();
    shell.current.style.setProperty("--mx", `${e.clientX - r.left}px`);
    shell.current.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  const cls = ["composer", asking && "composer--busy", focused && "composer--focus", disabled && "composer--off"].filter(Boolean).join(" ");
  return (
    <div ref={shell} className={cls} onPointerMove={onMove}>
      <span className="composer-ring" aria-hidden="true" />
      <span className="composer-spot" aria-hidden="true" />
      <div className="composer-body">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={asking ? "Reading the graph…" : "Ask about a file, an endpoint or a flow"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Question"
        />
        {!value && !focused && !asking && !disabled && <kbd className="composer-kbd" aria-hidden="true">/</kbd>}
        {asking ? (
          <button type="button" className="composer-btn composer-stop" onClick={onStop} aria-label="Stop (Esc)" title="Stop · Esc">
            <span className="stop-square" />
          </button>
        ) : (
          <button type="button" className="composer-btn" onClick={send} disabled={!value.trim() || disabled} aria-label="Ask" title="Ask · Enter">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <span className="composer-progress" aria-hidden="true" />
    </div>
  );
}
