-- 011: documents become first-class graph nodes. One DOCUMENT entity per doc file per commit (history and
-- branch scoping for free), MENTIONS edges to the code it names, and content-addressed chunks with
-- embeddings for semantic retrieval. Same database as the code graph: a doc is only useful joined to the
-- code it describes, and pgvector is already here.
set search_path = ckg, public;
alter type entity_kind_t add value if not exists 'DOCUMENT';
alter type edge_kind_t   add value if not exists 'MENTIONS';

create table if not exists doc_chunks (
  blob_sha     bytea not null references blobs(blob_sha),   -- content-addressed: unchanged docs are never re-chunked
  ordinal      int   not null,
  heading_path text  not null default '',                   -- "Rule Engine > 2. Design Philosophy > How it differs"
  text         text  not null,
  words        int   not null,
  model        text,                                        -- embedding model tag, null until embedded
  embedding    vector,
  primary key (blob_sha, ordinal));
create index if not exists doc_chunks_model on doc_chunks (model) where embedding is null;
grant select on doc_chunks to ckg_reader;
