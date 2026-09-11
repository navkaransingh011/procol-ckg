-- 010: answer cache. The same question against the same commits gets the same facts, so the whole
-- event stream is replayed instead of calling the model again. Keyed by commits, so a new index
-- misses naturally; nothing to invalidate by hand. `fresh: true` on /api/ask bypasses it.
set search_path = ckg, public;
create table if not exists answer_cache (
  key        text primary key,                -- sha1(normalised question | style | sorted commits)
  question   text not null,
  style      text not null,
  commits    text[] not null,
  events     jsonb not null,                  -- the full typed event stream, minus transient status lines
  hits       int  not null default 0,
  ms         int,
  created_at timestamptz not null default now(),
  last_hit   timestamptz);
grant select on answer_cache to ckg_reader;
