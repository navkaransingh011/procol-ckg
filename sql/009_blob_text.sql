-- 009: the database becomes self-contained. The indexer already opens every source file it parses;
-- now it keeps the text, keyed by the same content hash. READ and GREP are row lookups, pinned to the
-- commit through commit_files, and the answering service needs no git clones at all.
set search_path = ckg, public;

create table if not exists blob_text (
  blob_sha  bytea primary key references blobs(blob_sha),
  text      text not null,
  lines     int  not null,
  stored_at timestamptz not null default now());

grant select on blob_text to ckg_reader;
