-- 012: live mirror of a few platform (UAT) tables, allowlisted columns only (config/live_tables.json).
-- The poller (src/sync-live.mjs) creates live.<table> with the source's column types and keeps it fresh by
-- updated_at; a periodic id reconciliation removes deleted rows. The AI queries this schema through a
-- bounded tool -- it never connects to UAT.
set search_path = ckg, public;
create schema if not exists live;
create table if not exists live.sync_state (
  table_name   text primary key,
  last_cursor  timestamp,              -- max updated_at seen
  last_run     timestamptz,
  last_full    timestamptz,            -- last id reconciliation
  rows_total   bigint not null default 0,
  rows_changed bigint not null default 0,
  last_error   text);
grant usage on schema live to ckg_reader;
grant select on all tables in schema live to ckg_reader;
alter default privileges in schema live grant select on tables to ckg_reader;
