import React, { useMemo } from "react";

/**
 * The procurement world, drawn as thin line icons, drifting in alternating columns above the
 * question bar and dissolving as they reach it. Pure CSS motion on duplicated columns so the loop is
 * seamless; one animation per column, no per-frame JS. Paused under prefers-reduced-motion and faded
 * out once a conversation is live so it never competes with an answer.
 */
const ICONS = {
  gavel:     <><path d="M12.5 5.5l6 6-2.5 2.5-6-6z" /><path d="M11 11l-7 7 2 2 7-7" /><path d="M13 21h8" /></>,
  po:        <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /><path d="M10 13h6M10 17h6" /></>,
  receipt:   <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  truck:     <><path d="M3 7h11v9H3z" /><path d="M14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  box:       <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  factory:   <><path d="M3 21V10l5 3v-3l5 3v-3l5 3v8z" /><path d="M6 10V4" /></>,
  stamp:     <><path d="M9 10V6a3 3 0 016 0v4" /><path d="M5 14a2 2 0 012-2h10a2 2 0 012 2v3H5z" /><path d="M7 21h10" /></>,
  approved:  <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>,
  rupee:     <><path d="M7 4h10M7 9h10" /><path d="M9 4c4 0 6 2 6 4.5S13 13 9 13l7 8" /></>,
  tag:       <><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.5" /></>,
  scale:     <><path d="M12 3v18M6 21h12" /><path d="M12 6l-6 3M12 6l6 3" /><path d="M3 15l3-6 3 6a3 3 0 01-6 0zM15 15l3-6 3 6a3 3 0 01-6 0z" /></>,
  clipboard: <><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 3h6v4H9z" /><path d="M9 13h6M9 17h4" /></>,
  chart:     <><path d="M4 4v16h16" /><path d="M8 15l4-5 3 3 5-7" /></>,
  bell:      <><path d="M6 17v-6a6 6 0 0112 0v6l2 2H4z" /><path d="M10 21h4" /></>,
  globe:     <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c3.5 3.5 3.5 14.5 0 18M12 3c-3.5 3.5-3.5 14.5 0 18" /></>,
  shield:    <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></>,
  calendar:  <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  building:  <><path d="M4 21V5l8-2v18M12 9l8 2v10M3 21h18" /><path d="M7 9h2M7 13h2M7 17h2M15 14h2M15 18h2" /></>,
  timer:     <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M9 2h6" /></>,
  layers:    <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  sliders:   <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" className="knob" /><circle cx="15" cy="12" r="2" className="knob" /><circle cx="8" cy="17" r="2" className="knob" /></>,
  flow:      <><rect x="3" y="4" width="6" height="5" rx="1" /><rect x="15" y="4" width="6" height="5" rx="1" /><rect x="9" y="15" width="6" height="5" rx="1" /><path d="M6 9v3h12V9M12 12v3" /></>,
  contract:  <><path d="M6 3h9l4 4v6" /><path d="M15 3v4h4" /><path d="M4 20c2-4 4-5 5-2s2 2 4-1 3-1 6 1" /></>,
  handoff:   <><path d="M3 12h7M14 12h7" /><path d="M8 9l3 3-3 3M16 9l-3 3 3 3" /></>,
};
const NAMES = Object.keys(ICONS);

/** Deterministic per-column shuffle so the field looks the same on every load. */
function orderFor(col) {
  const out = [...NAMES];
  let s = 1103 + col * 977;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const COLS = 9;

export default function IconField({ dim }) {
  const cols = useMemo(() => Array.from({ length: COLS }, (_, c) => ({
    names: orderFor(c),
    down: c % 2 === 1,
    dur: `${64 + ((c * 7) % 5) * 9}s`,        // 64–100s: slow enough to be ambient
    size: `${26 + ((c * 3) % 4) * 4}px`,       // 26–38px, varied per column for depth
    delay: `-${(c * 13) % 40}s`,               // start mid-loop so columns are out of phase
  })), []);

  return (
    <div className={`field${dim ? " field--dim" : ""}`} aria-hidden="true">
      {cols.map((c, i) => (
        <div key={i} className={`col${c.down ? " col--down" : ""}`} style={{ "--dur": c.dur, "--size": c.size, "--delay": c.delay }}>
          {[0, 1].map((half) => (
            <div className="half" key={half}>
              {c.names.map((n) => (
                <svg key={n} viewBox="0 0 24 24" className="ico" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  {ICONS[n]}
                </svg>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
