#!/usr/bin/env node
// Live mirror poller. Pulls ONLY the allowlisted columns of the allowlisted tables (config/live_tables.json)
// from the platform database into schema `live` of our own Postgres, incrementally by updated_at, with a
// periodic id reconciliation so deletes are seen. Postgres 14 on the platform side has no column-filtered
// logical replication, so this is the design that keeps sensitive columns from ever leaving UAT.
//
//   node --env-file=.env src/sync-live.mjs --once          # one pass (first run = full load)
//   node --env-file=.env src/sync-live.mjs                 # loop every LIVE_SYNC_INTERVAL_S (default 60)
import { widgetNames } from "./template-layout.mjs";
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
  // a column newly allowlisted for a table that already exists: add it and re-pull every row once
  const have = new Set((await q(`select column_name from information_schema.columns where table_schema='live' and table_name=$1`, [name])).map(c => c.column_name));
  const added = spec.columns.filter(c => !have.has(c));
  for (const c of added) await q(`alter table live.${ident(name)} add column if not exists ${ident(c)} ${typeOf(c)}`);
  if (added.length) { await q(`delete from live.sync_state where table_name=$1`, [name]); console.log(`  ${name}: added column(s) ${added.join(", ")}; full re-pull`); }
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
  try { const ci = await refreshConfigIndex(); if (ci.embedded || ci.removed) out.push({ name: "config_index", changed: ci.embedded, removed: ci.removed, total: ci.indexed }); }
  catch (e) { out.push({ name: "config_index", error: String(e.message).slice(0, 120) }); }
  try { const li = await refreshLiveIndex(); if (li.embedded) out.push({ name: "search_index", changed: li.embedded, total: li.indexed }); }
  catch (e) { out.push({ name: "search_index", error: String(e.message).slice(0, 120) }); }
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

// ---------------------------------------------------------------------------------------------------
// CONFIG SEMANTIC INDEX. The catalogue of switches (master_configurations) is searched by MEANING: a
// question like "the lock so two flexi PO transactions cannot run together" must find
// fx_response_sequence_advisory_lock_enabled ("Enable FxResponse Sequence Lock per Datasource") without
// anyone guessing the key. Content-addressed by a hash of key+name+description, so only changed rows re-embed.
// ---------------------------------------------------------------------------------------------------
export async function refreshConfigIndex() {
  const { embed, embedModelId, toPgVector } = await import("./service/embed.mjs");
  const model = embedModelId();
  await q(`create table if not exists live.config_index (
             config_key text primary key, text text not null, hash text not null, model text, embedding vector, refreshed_at timestamptz default now())`);
  await q(`grant select on live.config_index to ckg_reader`).catch(() => {});
  const rows = await q(`select config_key, min(name) name, min(description) description, min(defaults::text) defaults
                          from live.master_configurations where config_key is not null group by config_key`);
  const want = rows.map(r => ({ key: r.config_key, text: `${r.config_key} — ${r.name || ""}. ${r.description || ""} Default: ${r.defaults || ""}`.replace(/\s+/g, " ").trim() }));
  const have = new Map((await q(`select config_key, hash, model from live.config_index`)).map(r => [r.config_key, r]));
  const { createHash } = await import("node:crypto");
  const todo = want.filter(w => { const h = createHash("sha1").update(w.text).digest("hex"); w.hash = h; const e = have.get(w.key); return !e || e.hash !== h || e.model !== model; });
  for (let i = 0; i < todo.length; i += 64) {
    const b = todo.slice(i, i + 64);
    const vecs = await embed(b.map(w => w.text));
    for (let j = 0; j < b.length; j++)
      await q(`insert into live.config_index (config_key, text, hash, model, embedding) values ($1,$2,$3,$4,$5::vector)
               on conflict (config_key) do update set text=excluded.text, hash=excluded.hash, model=excluded.model, embedding=excluded.embedding, refreshed_at=now()`,
              [b[j].key, b[j].text, b[j].hash, model, toPgVector(vecs[j])]);
  }
  const gone = [...have.keys()].filter(k => !want.some(w => w.key === k));
  if (gone.length) await q(`delete from live.config_index where config_key = any($1::text[])`, [gone]);
  return { indexed: want.length, embedded: todo.length, removed: gone.length };
}

// ---------------------------------------------------------------------------------------------------
// LIVE SEARCH INDEX. Every mirrored thing that has a human name -- templates, approval flows, datasources,
// environment switches -- is searchable by MEANING, so "logistics auction templates" or "the approval flow for
// invoices above 5 lakh" resolves to real rows without the planner guessing substrings. Content-addressed.
// ---------------------------------------------------------------------------------------------------
function liveIndexSources() { return ({
  templates:       { sql: `select t.id, t.company_id, t.name, t.template_for, t.template_type, t.order_type, t.widgets from live.templates t where t.name is not null`,
                     text: (t) => {
                       const FOR = ["trade", "contract", "rfi", "module", "vendor", "allocation summary", "custom search"], TYPE = ["default", "custom", "dynamic"];
                       const names = widgetNames(t.widgets, 40);
                       return `${t.name} (template for ${FOR[t.template_for] || "unknown"}${TYPE[t.template_type] ? ", " + TYPE[t.template_type] : ""}, ${t.order_type === 1 ? "sell" : "buy"})${names.length ? ". Asks for: " + names.join(", ") : ""}`;
                     } },
  approval_flows:  { sql: `select id, company_id, coalesce(name,'') || ' — approval flow for ' || coalesce(approval_key,'') || coalesce('. ' || description, '') as text from live.approval_flows` },
  fx_datasources:  { sql: `select id, tenant_id as company_id, name || ' (flexi datasource)' as text from live.fx_datasources where name is not null` },
  procol_variables:{ sql: `select id, null::int as company_id, key || ' (environment variable)' as text from live.procol_variables` },
}); }
export async function refreshLiveIndex() {
  const { embed, embedModelId, toPgVector } = await import("./service/embed.mjs");
  const { createHash } = await import("node:crypto");
  const model = embedModelId();
  await q(`create table if not exists live.search_index (
             kind text not null, ref_id bigint not null, company_id bigint, text text not null, hash text not null, model text, embedding vector,
             refreshed_at timestamptz default now(), primary key (kind, ref_id))`);
  await q(`grant select on live.search_index to ckg_reader`).catch(() => {});
  let embedded = 0, total = 0;
  for (const [kind, src] of Object.entries(liveIndexSources())) {
    const rows = (await q(src.sql)).map(r => src.text ? { ...r, text: src.text(r) } : r);
    total += rows.length;
    const have = new Map((await q(`select ref_id, hash, model from live.search_index where kind=$1`, [kind])).map(r => [String(r.ref_id), r]));
    const todo = rows.map(r => ({ ...r, hash: createHash("sha1").update(r.text).digest("hex") })).filter(r => { const e = have.get(String(r.id)); return !e || e.hash !== r.hash || e.model !== model; });
    for (let i = 0; i < todo.length; i += 128) {
      const b = todo.slice(i, i + 128);
      const vecs = await embed(b.map(r => r.text.slice(0, 500)));
      const vals = b.map((_, j) => `($1, $${j * 6 + 2}, $${j * 6 + 3}, $${j * 6 + 4}, $${j * 6 + 5}, $${j * 6 + 6}, $${j * 6 + 7}::vector)`).join(",");
      await q(`insert into live.search_index (kind, ref_id, company_id, text, hash, model, embedding) values ${vals}
               on conflict (kind, ref_id) do update set text=excluded.text, hash=excluded.hash, model=excluded.model, embedding=excluded.embedding, company_id=excluded.company_id, refreshed_at=now()`,
              [kind, ...b.flatMap((r, j) => [r.id, r.company_id, r.text, r.hash, model, toPgVector(vecs[j])])]);
      embedded += b.length;
    }
    const ids = new Set(rows.map(r => String(r.id)));
    const gone = [...have.keys()].filter(k => !ids.has(k));
    if (gone.length) await q(`delete from live.search_index where kind=$1 and ref_id = any($2::bigint[])`, [kind, gone]);
  }
  return { indexed: total, embedded };
}
