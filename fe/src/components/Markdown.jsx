import React from "react";

/**
 * A deliberately tiny renderer for the service's markdown-ish prose: `#` headings, the technical
 * answer's numbered section titles ("2. Evidence path"), bullets, numbered items, `code`, **bold**,
 * and the "Read from …" refs footer. No HTML passthrough, no dependency.
 */
const SECTION = /^(\d)\.\s+([A-Z][^.`]{1,48})$/;

function inline(text, key) {
  const parts = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<code key={`${key}-${i++}`}>{m[1].slice(1, -1)}</code>);
    else parts.push(<strong key={`${key}-${i++}`}>{m[2].slice(2, -2)}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function Markdown({ text }) {
  if (!text) return null;
  const lines = text.replace(/\r/g, "").split("\n");
  const out = [];
  let para = [], list = null, k = 0;
  const flushPara = () => { if (para.length) { out.push(<p key={k++}>{inline(para.join(" "), k)}</p>); para = []; } };
  const flushList = () => { if (list) { out.push(React.createElement(list.tag, { key: k++ }, list.items.map((it, i) => <li key={i}>{inline(it, `${k}-${i}`)}</li>))); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) { flushPara(); flushList(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(t))) { flushPara(); flushList(); out.push(React.createElement(`h${m[1].length + 2}`, { key: k++ }, inline(m[2], k))); continue; }
    if ((m = SECTION.exec(t)) && !list) { flushPara(); out.push(<h3 key={k++}><span className="sec-n">{m[1]}</span>{inline(m[2], k)}</h3>); continue; }
    if ((m = /^[-*•]\s+(.*)$/.exec(t))) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
    if (/^Read from /.test(t)) { flushPara(); flushList(); out.push(<p key={k++} className="refs-footer">{inline(t, k)}</p>); continue; }
    if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ` ${t}`; continue; }
    flushList();
    para.push(t);
  }
  flushPara(); flushList();
  return <div className="prose">{out}</div>;
}
