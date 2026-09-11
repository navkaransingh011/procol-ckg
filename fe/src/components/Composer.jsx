import React, { useEffect, useRef, useState } from "react";

export default function Composer({ onSend, onStop, asking, disabled, autoFocus }) {
  const [value, setValue] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const send = () => {
    if (!value.trim() || asking || disabled) return;
    onSend(value);
    setValue("");
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className={`composer${asking ? " composer--busy" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder="Ask about a file, an endpoint, a table, or a flow"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Question"
      />
      {asking ? (
        <button type="button" className="composer-btn composer-stop" onClick={onStop} aria-label="Stop">
          <span className="stop-square" />
        </button>
      ) : (
        <button type="button" className="composer-btn" onClick={send} disabled={!value.trim() || disabled} aria-label="Ask">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className="composer-progress" aria-hidden="true" />
    </div>
  );
}
