import React, { useState } from "react";

/**
 * A complete result set from the live platform mirror, rendered exactly. The model only summarises these;
 * the rows here are the source of truth for "list all X" questions, stamped with when they were synced.
 */
export default function DataTable({ table }) {
  const [q, setQ] = useState("");
  const rows = q ? table.rows.filter(r => r.some(c => String(c).toLowerCase().includes(q.toLowerCase()))) : table.rows;
  const asOf = table.as_of ? new Date(table.as_of) : null;
  const copy = async () => {
    const tsv = [table.columns.join("\t"), ...table.rows.map(r => r.join("\t"))].join("\n");
    try { await navigator.clipboard.writeText(tsv); } catch { /* blocked */ }
  };
  return (
    <div className="dtable">
      <div className="dtable-head">
        <span className="dtable-title">{table.title}</span>
        <span className="dtable-meta">
          {rows.length === table.rows.length ? `${table.rows.length} rows` : `${rows.length} of ${table.rows.length} rows`}
          {!table.complete ? ` · showing ${table.rows.length} of ${table.total}` : ""}
          {asOf ? ` · as of ${asOf.toLocaleString()}` : ""}
        </span>
        {table.rows.length > 8 && <input className="dtable-filter" placeholder="filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter rows" />}
        <button type="button" className="ghost ghost--sm" onClick={copy}>copy</button>
      </div>
      <div className="dtable-scroll">
        <table>
          <thead><tr>{table.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} title={String(c)}>{String(c)}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
