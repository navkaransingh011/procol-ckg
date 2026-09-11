-- 008: semantic anchoring pilot. One vector per entity "card" (a short factual text built from
-- the graph: name, humanized words, path, routes served, columns, summary). Vectors are used ONLY
-- to find a starting node for a question; every fact still comes from entities/edges/source.
--
-- Pilot model is local bge-small (384 dims). Production would be Slingring TEXT_EMBED_3_LARGE
-- (3072 dims), which exceeds pgvector's 2000-dim HNSW cap for `vector` -- use halfvec(3072) then.
set search_path = ckg, public;
create extension if not exists vector;

create table if not exists embeddings (
  id          bigint primary key generated always as identity,
  entity_id   bigint not null references entities(id) on delete cascade,
  model       text   not null,                 -- 'local:Xenova/bge-small-en-v1.5'
  dims        int    not null,
  text_hash   bytea  not null,                 -- sha256(card): re-embed only when the card changes
  card        text   not null,
  embedding   vector not null,           -- untyped for the pilot so two models can coexist; fix dims + add HNSW when a model is chosen
  created_at  timestamptz not null default now(),
  unique (entity_id, model));

-- create index embeddings_hnsw on embeddings using hnsw (embedding vector_cosine_ops);  -- once dims are fixed
grant select on embeddings to ckg_reader;
