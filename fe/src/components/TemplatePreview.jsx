import React, { useState } from "react";

/**
 * A template as the dashboard shows it, read from the platform mirror. Three shapes:
 *   sheet  -- trade/auction templates: line-item columns (the grid the buyer builds) plus event-level price components
 *   form   -- RFI / vendor onboarding / intake: pages of questions the supplier answers
 *   fields -- module/document templates: a flat set of named fields
 * Column and question labels, order, units, choices and required marks are the real ones. Sample values are not.
 */
const sample = (w) => {
  const unit = [w.prefix, w.suffix].filter(Boolean);
  switch (w.input_type) {
    case "number": case "amount": case "quantity": case "percentage": case "percent_and_amount":
      return <span className="pf-num">{w.prefix ? <i>{w.prefix}</i> : null}<b>{w.precision ? (0).toFixed(Math.min(w.precision, 4)) : "0"}</b>{w.suffix ? <i>{w.suffix}</i> : null}</span>;
    case "formula": return <span className="pf-calc">= {unit.join(" ")}</span>;
    case "product": return <span className="pf-ph">Search product</span>;
    case "dropdown": case "multi_select": return <span className="pf-select">{(w.options && w.options[0]) || "Select"} <i>▾</i></span>;
    case "delivery_location": return <span className="pf-select">Select location <i>▾</i></span>;
    case "attachment": return <span className="pf-ph">＋ Attach</span>;
    case "date": case "date_time": return <span className="pf-select">Select date <i>📅</i></span>;
    default: return <span className="pf-ph">{w.side === "participant" ? "Supplier enters" : "Enter"}</span>;
  }
};
const Side = ({ w }) => <i className={`tpl-dot tpl-dot--${w.side === "participant" ? "participant" : (w.side === "formula" || w.input_type === "formula") ? "formula" : "creator"}`} aria-hidden="true" />;

function Grid({ label, widgets, showHidden, onToggleHidden, hidden }) {
  return (
    <section className="tpl-group">
      <div className="tpl-group-head">
        <span className="label">{label}</span>
        <span className="tpl-group-meta">{widgets.length} column{widgets.length === 1 ? "" : "s"}{hidden ? ` · ${hidden} hidden from suppliers` : ""}</span>
        {hidden > 0 && <button type="button" className="ghost ghost--sm" onClick={onToggleHidden}>{showHidden ? "hide hidden" : "show hidden"}</button>}
      </div>
      <div className="tpl-scroll">
        <table className="tpl-sheet">
          <thead>
            <tr>
              <th className="tpl-rowno">#</th>
              {widgets.map((w, i) => (
                <th key={`${w.key || w.name}-${i}`} className={`tpl-col${w.hidden ? " tpl-col--hidden" : ""}`} title={[w.key, w.type, w.side === "participant" ? "supplier fills" : "buyer fills", w.custom ? "custom widget" : null, w.hidden ? "hidden" : null].filter(Boolean).join(" · ")}>
                  <span className="tpl-col-name">{w.name}{w.required && <b className="tpl-req" aria-label="required">*</b>}</span>
                  <Side w={w} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3].map((n) => (
              <tr key={n}>
                <td className="tpl-rowno">{n}</td>
                {widgets.map((w, i) => <td key={`${w.key || w.name}-${i}`} className={`tpl-cell${w.side === "participant" ? " tpl-cell--participant" : ""}`}>{n === 1 ? sample(w) : ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PriceComponents({ widgets }) {
  return (
    <section className="tpl-pf">
      <div className="tpl-pf-title">Price components</div>
      <table className="tpl-pf-table">
        <tbody>
          {widgets.map((w, i) => (
            <tr key={`${w.key || w.name}-${i}`}>
              <td className="tpl-pf-label">{w.name}{w.required && <b className="tpl-req">*</b>}</td>
              <td className="tpl-pf-input"><span className="tpl-pf-box">{sample(w)}</span></td>
              <td className="tpl-pf-side"><Side w={w} />{w.side === "participant" ? "supplier fills" : w.side === "formula" || w.input_type === "formula" ? "calculated" : "buyer fills"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Sheet({ t }) {
  const [showHidden, setShowHidden] = useState(false);
  const grids = t.groups.filter((g) => g.key !== "global_price_components");
  const price = t.groups.find((g) => g.key === "global_price_components");
  return (
    <>
      {grids.map((g) => {
        const cols = g.widgets.filter((w) => showHidden || !w.hidden);
        return <Grid key={g.key} label={g.key === "inline_components" ? "Line items" : g.label} widgets={cols} hidden={g.widgets.length - cols.length} showHidden={showHidden} onToggleHidden={() => setShowHidden((v) => !v)} />;
      })}
      {price && price.widgets.length > 0 && <PriceComponents widgets={price.widgets} />}
    </>
  );
}

function Field({ q }) {
  const t = q.input_type;
  let control;
  if (t === "radio" || (q.options && q.options.length && t !== "dropdown" && t !== "multi_select"))
    control = <div className="tpl-choices">{(q.options || ["Yes", "No"]).map((o) => <label key={o}><span className={`tpl-radio${t === "multi_select" ? " tpl-radio--box" : ""}`} />{o}</label>)}</div>;
  else if (t === "dropdown" || t === "multi_select") control = <div className="tpl-input tpl-input--select">{(q.options && q.options[0]) || "Select"} <span aria-hidden="true">▾</span></div>;
  else if (t === "multiline_text") control = <div className="tpl-input tpl-input--area" />;
  else if (t === "attachment") control = <div className="tpl-input tpl-input--file">📎 Upload file</div>;
  else if (t === "question_group" || t === "tabular") control = <div className="tpl-input tpl-input--group">{q.type}</div>;
  else control = <div className="tpl-input">{sample(q)}</div>;
  return (
    <div className={`tpl-field tpl-field--${q.side}`}>
      <div className="tpl-field-label"><Side w={q} />{q.name}{q.required && <b className="tpl-req">*</b>}<span className="tpl-field-type">{q.type}</span></div>
      {control}
    </div>
  );
}

function Form({ t }) {
  const [page, setPage] = useState(0);
  const p = t.pages[page];
  if (!p) return null;
  return (
    <div className="tpl-form">
      {t.pages.length > 1 && (
        <div className="tpl-pages" role="tablist">
          {t.pages.map((pg, i) => <button key={`${pg.name}-${i}`} type="button" role="tab" aria-selected={i === page} className={`chip${i === page ? " chip--on" : ""}`} onClick={() => setPage(i)}>{i + 1}. {pg.name}</button>)}
        </div>
      )}
      <div className="tpl-page">
        <div className="tpl-page-head">
          <span className="tpl-page-name">{p.name}</span>
          <span className="tpl-group-meta">{p.questions.length} question{p.questions.length === 1 ? "" : "s"}</span>
        </div>
        {p.description && <p className="tpl-page-desc">{p.description}</p>}
        <div className="tpl-fields">{p.questions.map((q, i) => <Field key={`${q.key || q.name}-${i}`} q={q} />)}</div>
      </div>
    </div>
  );
}

function Fields({ t }) {
  return <div className="tpl-page"><div className="tpl-fields tpl-fields--grid">{t.groups[0].widgets.map((w, i) => <Field key={`${w.key || w.name}-${i}`} q={w} />)}</div></div>;
}

export default function TemplatePreview({ t }) {
  const asOf = t.as_of ? new Date(t.as_of) : null;

  const flags = [t.template_for?.replace(/_/g, " "), t.template_type, t.order_type, t.status].filter(Boolean);
  const unit = t.layout === "form" ? "question" : "column";
  return (
    <div className="tpl">
      <div className="tpl-head">
        <div>
          <div className="tpl-name">{t.name}</div>
          <div className="tpl-meta">
            {flags.map((f) => <span key={f} className={`tag tag--tpl${f === "inactive" ? " tag--off" : ""}`}>{f}</span>)}
            {t.company && <span className="tpl-company">{t.company}</span>}
            <span>{t.widget_count} {unit}{t.widget_count === 1 ? "" : "s"}{t.layout === "form" ? ` on ${t.pages.length} page${t.pages.length === 1 ? "" : "s"}` : ""}</span>
            {asOf && <span>as of {asOf.toLocaleString()}</span>}
          </div>
        </div>
        <div className="tpl-legend"><i className="sw sw--creator" /> buyer fills <i className="sw sw--participant" /> supplier fills <i className="sw sw--formula" /> calculated</div>
      </div>

      {t.layout === "sheet" && <Sheet t={t} />}
      {t.layout === "form" && <Form t={t} />}
      {t.layout === "fields" && <Fields t={t} />}
      {t.layout === "empty" && <p className="note tpl-empty">This template has no layout stored on UAT yet, so there is nothing to draw.</p>}

      <div className="tpl-foot">
        {Object.keys(t.configurations || {}).length > 0 && (
          <span>settings: {Object.entries(t.configurations).map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v)}`).join(" · ")}</span>
        )}
        {t.layout !== "empty" && <span className="tpl-note">labels, order, units and required marks are the real ones; sample values are illustrative</span>}
      </div>
    </div>
  );
}
