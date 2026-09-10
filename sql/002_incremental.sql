-- The incremental machinery. This is what makes a merge cost 8 files instead of 1,735.
set search_path = ckg, public;

-- One row per distinct file CONTENT ever seen, across every repo and every ref.
create table if not exists blobs (
  blob_sha   bytea primary key check (length(blob_sha) = 20),
  size_bytes int  not null,
  lang       text,
  first_seen timestamptz not null default now());

-- THE CACHE. Per-blob extraction output, keyed by content + extractor version.
-- A cache hit here is the difference between parsing a file and not parsing it.
-- Bumping extractor_version invalidates exactly that extractor, nothing else.
create table if not exists blob_facts (
  blob_sha          bytea not null references blobs(blob_sha),
  extractor         text  not null,
  extractor_version text  not null,
  facts             jsonb not null,
  parse_ok          boolean not null default true,
  parse_error       text,
  extracted_at      timestamptz not null default now(),
  duration_ms       int,
  primary key (blob_sha, extractor, extractor_version));

-- The file tree of one commit. Also answers "which deployed refs contain this blob?",
-- which is how you later say "this PR touches a file live in RIL prod and Jindal sandbox".
create table if not exists commit_files (
  repo_id    int   not null references repos(id),
  commit_sha bytea not null,
  path       text  not null,
  blob_sha   bytea not null references blobs(blob_sha),
  primary key (repo_id, commit_sha, path),
  foreign key (repo_id, commit_sha) references commits(repo_id, sha));

create index if not exists commit_files_blob on commit_files (blob_sha);

-- Which commit a ref pointed at, and WHEN. Append-only.
-- This is what makes "what did the agent believe on Sept 1?" a query instead of a guess.
create table if not exists ref_history (
  id         bigint primary key generated always as identity,
  repo_id    int   not null references repos(id),
  ref_name   text  not null,
  commit_sha bytea not null,
  tenant     text,
  env        text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  foreign key (repo_id, commit_sha) references commits(repo_id, sha));

create unique index if not exists ref_history_current on ref_history (repo_id, ref_name, commit_sha);
create index if not exists ref_history_lookup on ref_history (repo_id, ref_name, first_seen desc);

-- Audit trail: what each indexing run actually did. Proves the cache is working.
create table if not exists index_runs (
  id             bigint primary key generated always as identity,
  repo_id        int   not null references repos(id),
  commit_sha     bytea not null,
  ref_name       text,
  trigger        text  not null,            -- 'push' | 'manual' | 'backfill'
  files_in_tree  int   not null default 0,
  blobs_total    int   not null default 0,
  blobs_cached   int   not null default 0,  -- reused, not parsed
  blobs_parsed   int   not null default 0,  -- actually read + parsed
  entities_added int   not null default 0,
  edges_added    int   not null default 0,
  duration_ms    int,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  ok             boolean,
  error          text);

create index if not exists index_runs_recent on index_runs (repo_id, started_at desc);

-- What changed between two commits, matched on (kind, fqn) identity.
create or replace function entity_diff(p_repo int, p_from bytea, p_to bytea)
returns table (change text, kind entity_kind_t, fqn text, path text) as $$
  select 'added', b.kind, b.fqn, b.path
    from entities b
   where b.repo_id = p_repo and b.commit_sha = p_to
     and not exists (select 1 from entities a
                      where a.repo_id = p_repo and a.commit_sha = p_from
                        and a.kind = b.kind and a.fqn = b.fqn)
  union all
  select 'removed', a.kind, a.fqn, a.path
    from entities a
   where a.repo_id = p_repo and a.commit_sha = p_from
     and not exists (select 1 from entities b
                      where b.repo_id = p_repo and b.commit_sha = p_to
                        and b.kind = a.kind and b.fqn = a.fqn)
  union all
  select 'moved', a.kind, a.fqn, b.path
    from entities a
    join entities b on b.kind = a.kind and b.fqn = a.fqn
                   and b.repo_id = p_repo and b.commit_sha = p_to
   where a.repo_id = p_repo and a.commit_sha = p_from
     and coalesce(a.path,'') <> coalesce(b.path,'');
$$ language sql stable;
