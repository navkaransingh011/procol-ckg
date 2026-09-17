-- Full-text columns for hybrid retrieval: the question's WORDS are matched alongside its MEANING (vectors) and the
-- two rankings are fused (src/tools.mjs searchDocs / searchConfigs / searchLive). Generated columns keep themselves
-- current; GIN indexes make the word match cheap even over the 27k live rows. Everything is additive and optional:
-- without these columns the word lists come back empty and the vector order stands.
set search_path = ckg, public;

alter table ckg.doc_chunks
  add column if not exists tsv tsvector generated always as (to_tsvector('english', coalesce(heading_path, '') || ' ' || text)) stored;
create index if not exists doc_chunks_tsv on ckg.doc_chunks using gin (tsv);

-- live.config_index and live.search_index are created by src/sync-live.mjs (create table if not exists); the
-- columns are added here so a database that has never synced still migrates cleanly.
create schema if not exists live;
create table if not exists live.config_index (
  config_key text primary key, text text not null, hash text not null, model text, embedding vector, refreshed_at timestamptz default now());
alter table live.config_index
  add column if not exists tsv tsvector generated always as (to_tsvector('english', text)) stored;
create index if not exists config_index_tsv on live.config_index using gin (tsv);

create table if not exists live.search_index (
  kind text not null, ref_id bigint not null, company_id bigint, text text not null, hash text not null, model text, embedding vector,
  refreshed_at timestamptz default now(), primary key (kind, ref_id));
alter table live.search_index
  add column if not exists tsv tsvector generated always as (to_tsvector('english', text)) stored;
create index if not exists search_index_tsv on live.search_index using gin (tsv);

grant select on live.config_index, live.search_index to ckg_reader;
