#!/usr/bin/env node
// Live mirror poller. Pulls ONLY the allowlisted columns of the allowlisted tables (config/live_tables.json)
// from the platform database into schema `live` of our own Postgres, incrementally by updated_at, with a
// periodic id reconciliation so deletes are seen. Postgres 14 on the platform side has no column-filtered
// logical replication, so this is the design that keeps sensitive columns from ever leaving UAT.
//
//   node --env-file=.env src/sync-live.mjs --once          # one pass (first run = full load)
//   node --env-file=.env src/sync-live.mjs                 # loop every LIVE_SYNC_INTERVAL_S (default 60)
import pg from "pg";
import { readFileSync } from "node:fs";
import { q, pool } from "./db.mjs";

const cfg = JSON.parse(readFileSync(new URL("../config/live_tables.json", import.meta.url), "utf8")).tables;
const LIVE_URL = process.env.LIVE_DATABASE_URL;
if (!LIVE_URL) { console.error("LIVE_DATABASE_URL is not set"); process.exit(2); }
// READ-ONLY BY CONSTRUCTION. Two independent guards on the platform connection:
//  1. every session starts with default_transaction_read_only=on, so Postgres itself refuses INSERT/UPDATE/
//     DELETE/DDL on this connection even though the login may hold write privileges;
//  2. this process only ever sends SELECT statements -- anything else is rejected before it leaves.
// The AI never gets this connection; it reads the mirror in our own database through a bounded tool.
// UAT presents a self-signed certificate: keep TLS on but do not verify the chain (sslmode=no-verify).
const src = new pg.Pool({ connectionString: LIVE_URL.replace(/[?&]sslmode=[^&]*/, ""), max: 2, statement_timeout: 60000, query_timeout: 60000,
                          options: "-c default_transaction_read_only=on -c statement_timeout=60000",
                          application_name: "procol-ckg-live-sync (read-only)",
                          ssl: /sslmode=(require|no-verify|prefer)/.test(LIVE_URL) ? { rejectUnauthorized: false } : undefined });
export const assertSelectOnly = (sql) => {
  const head = String(sql).replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, "").trimStart().slice(0, 12).toLowerCase();
  if (!/^(select|with)\b/.test(head)) throw new Error(`refused: only SELECT may be sent to the platform database (got: ${String(sql).slice(0, 40)})`);
  if (/;\s*\S/.test(String(sql))) throw new Error("refused: one statement at a time");
  return sql;
};
const sq = async (sql, p = []) => (await src.query(assertSelectOnly(sql), p)).rows;
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };
const argv = process.argv.slice(2);
const once = argv.includes("--once");
const INTERVAL = Number(process.env.LIVE_SYNC_INTERVAL_S || 60) * 1000;
const OVERLAP_MS = 120000;           // re-read the last two minutes so late-committed rows are not missed
const BATCH = 5000;
const FULL_EVERY_MS = 30 * 60000;    // id reconciliation (deletes) every 30 minutes; large tables every 2 h

// map the source's column types onto ours; the allowlist decides WHICH columns, the source decides types
async function ensureTable(name, spec) {
  const cols = await sq(`select column_name, data_type, udt_name from information_schema.columns where table_schema='public' and table_name=$1`, [name]);
  const byName = new Map(cols.map(c => [c.column_name, c]));
  const missing = spec.columns.filter(c => !byName.has(c));
  if (missing.length) throw new Error(`${name}: columns not on source: ${missing.join(", ")}`);
  const typeOf = (c) => { const t = byName.get(c); if (t.data_type === "ARRAY") return `${t.udt_name.replace(/^_/, "")}[]`; if (t.data_type === "USER-DEFINED") return "text"; return t.data_type; };
  const defs = spec.columns.map(c => `${ident(c)} ${typeOf(c)}`).join(", ");
  await q(`create table if not exists live.${ident(name)} (${defs}, synced_at timestamptz not null default now(), primary key (${ident(spec.key)}))`);
  await q(`create index if not exists ${ident(name + "_cursor")} on live.${ident(name)} (${ident(spec.cursor)})`);
  for (const c of ["company_id", "config_key", "tenant_id", "template_id", "fx_datasource_id", "approval_flow_id", "key"])
    if (spec.columns.includes(c)) await q(`create index if not exists ${ident(name + "_" + c)} on live.${ident(name)} (${ident(c)})`);
  await q(`grant select on live.${ident(name)} to ckg_reader`).catch(() => {});
  return new Map(spec.columns.map(c => [c, typeOf(c)]));
}

async function syncTable(name, spec) {
  const t0 = Date.now();
  const types = await ensureTable(name, spec);
  const isJson = (c) => /^jsonb?$/.test(types.get(c));
  const [st] = await q(`select * from live.sync_state where table_name=$1`, [name]);
  const since = st?.last_cursor ? new Date(new Date(st.last_cursor).getTime() - OVERLAP_MS) : null;
  const colList = spec.columns.map(ident).join(", ");
  let changed = 0, maxCursor = st?.last_cursor ? new Date(st.last_cursor) : null, offset = 0;
  for (;;) {
    const rows = await sq(`select ${colList} from public.${ident(name)} ${since ? `where ${ident(spec.cursor)} > $1` : ""} order by ${ident(spec.cursor)} asc, ${ident(spec.key)} asc limit ${BATCH} offset ${offset}`, since ? [since] : []);
    if (!rows.length) break;
    const cast = (c) => isJson(c) ? "::jsonb" : "";
    const vals = rows.map((_, i) => `(${spec.columns.map((c, j) => `$${i * spec.columns.length + j + 1}${cast(c)}`).join(",")})`).join(",");
    const flat = rows.flatMap(r => spec.columns.map(c => r[c] === null || r[c] === undefined ? null : isJson(c) ? JSON.stringify(r[c]) : r[c]));
    const upd = spec.columns.filter(c => c !== spec.key).map(c => `${ident(c)} = excluded.${ident(c)}`).join(", ");
    await q(`insert into live.${ident(name)} (${colList}) values ${vals} on conflict (${ident(spec.key)}) do update set ${upd}, synced_at = now()`, flat);
    changed += rows.length;
    for (const r of rows) { const d = r[spec.cursor] ? new Date(r[spec.cursor]) : null; if (d && (!maxCursor || d > maxCursor)) maxCursor = d; }
    if (rows.length < BATCH) break;
    offset += BATCH;
  }
  // deletes: reconcile ids periodically (large tables less often)
  let removed = 0;
  const fullEvery = spec.large ? FULL_EVERY_MS * 4 : FULL_EVERY_MS;
  const needFull = !st?.last_full || Date.now() - new Date(st.last_full).getTime() > fullEvery;
  if (needFull) {
    const ids = (await sq(`select ${ident(spec.key)} k from public.${ident(name)}`)).map(r => r.k);
    const r = await q(`delete from live.${ident(name)} where ${ident(spec.key)} <> all($1::bigint[])`, [ids]);
    removed = r.length ?? 0;
  }
  const [{ n }] = await q(`select count(*)::bigint n from live.${ident(name)}`);
  await q(`insert into live.sync_state (table_name, last_cursor, last_run, last_full, rows_total, rows_changed, last_error)
           values ($1, $2::timestamp, now(), $3::timestamptz, $4::bigint, $5::bigint, null)
           on conflict (table_name) do update set last_cursor=excluded.last_cursor, last_run=now(), last_full=excluded.last_full,
             rows_total=excluded.rows_total, rows_changed=excluded.rows_changed, last_error=null`,
          [name, maxCursor, needFull ? new Date() : (st?.last_full ?? null), Number(n), changed]);
  return { name, changed, removed, total: Number(n), ms: Date.now() - t0, full: needFull };
}

async function pass() {
  const t0 = Date.now(); const out = [];
  for (const [name, spec] of Object.entries(cfg)) {
    try { out.push(await syncTable(name, spec)); }
    catch (e) { out.push({ name, error: String(e.message).slice(0, 200) }); await q(`insert into live.sync_state (table_name, last_run, last_error) values ($1, now(), $2) on conflict (table_name) do update set last_run=now(), last_error=excluded.last_error`, [name, String(e.message).slice(0, 500)]).catch(() => {}); }
  }
  const line = out.map(r => r.error ? `${r.name}: ERROR ${r.error}` : `${r.name}: ${r.changed} changed${r.removed ? `, ${r.removed} removed` : ""}, ${r.total} rows${r.full ? " (full)" : ""}`).join(" | ");
  console.log(`${new Date().toISOString()} live sync ${Date.now() - t0}ms  ${line}`);
  return out;
}

// Run only when executed directly (tests import this module for its guards without starting a sync).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await pass();
    if (!once) { for (;;) { await new Promise(r => setTimeout(r, INTERVAL)); await pass(); } }
  } finally { await src.end(); await pool.end(); }
}
