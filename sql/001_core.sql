-- Core knowledge-graph tables.
-- Rule that governs everything here: rows are keyed to (repo, commit_sha) and are
-- NEVER updated or deleted. A new merge inserts new rows; history is what remains.

create extension if not exists pg_trgm;
create schema if not exists ckg;
set search_path = ckg, public;

do $$ begin
  create type epistemic_t  as enum ('OBSERVED','DERIVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type resolution_t as enum ('EXACT','IMPORT_SCOPED','FRAMEWORK_DUMP',
                                    'DATAFLOW','HEURISTIC','AMBIGUOUS','ASSUMED','LLM');
exception when duplicate_object then null; end $$;

do $$ begin
  create type entity_kind_t as enum ('FILE','SYMBOL','UI_COMPONENT','UI_ROUTE','STATE_ACTION',
    'HTTP_CALL_SITE','HTTP_ENDPOINT','SERVER_ROUTE','HANDLER','SERVICE','DB_TABLE','JOB',
    'EXTERNAL_SERVICE','CONFIG_KEY','TEST_CASE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type edge_kind_t as enum ('DECLARES','IMPORTS','CALLS','RENDERS','MOUNTS','DISPATCHES',
    'INVOKES','ISSUES_HTTP','TARGETS','SERVES','HANDLED_BY','USES_SERVICE','READS','WRITES',
    'ENQUEUES','READS_CONFIG','COVERS');
exception when duplicate_object then null; end $$;

create table if not exists repos (
  id    int primary key generated always as identity,
  owner text not null,
  name  text not null,
  kind  text not null check (kind in ('spa','monolith','library','backend_family')),
  unique (owner, name));

create table if not exists commits (
  repo_id      int    not null references repos(id),
  sha          bytea  not null check (length(sha) = 20),
  committed_at timestamptz not null,
  subject      text,
  pkg_version  text,
  primary key (repo_id, sha));

create table if not exists entities (
  id         bigint primary key generated always as identity,
  repo_id    int    not null references repos(id),
  commit_sha bytea,                       -- NULL only for HTTP_ENDPOINT (repo-agnostic)
  kind       entity_kind_t not null,
  fqn        text not null,
  name       text,
  path       text,
  blob_sha   bytea,                       -- which file content proves this
  start_line int,
  end_line   int,
  attrs      jsonb not null default '{}',
  status     epistemic_t  not null,
  extractor  text         not null,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  resolution resolution_t not null default 'EXACT',
  role_min   text         not null default 'csm',
  foreign key (repo_id, commit_sha) references commits(repo_id, sha));

create unique index if not exists entities_identity on entities
  (repo_id, coalesce(commit_sha, '\x00'::bytea), kind, fqn);
create index if not exists entities_kind    on entities (repo_id, commit_sha, kind);
create index if not exists entities_trgm    on entities using gin (name gin_trgm_ops);
create index if not exists entities_path    on entities (repo_id, commit_sha, path);

create table if not exists edges (
  id              bigint primary key generated always as identity,
  repo_id         int    not null references repos(id),
  commit_sha      bytea  not null,
  kind            edge_kind_t not null,
  src_entity_id   bigint not null references entities(id),
  dst_entity_id   bigint not null references entities(id),
  site_hash       bytea  not null,
  start_line      int,
  end_line        int,
  guard_expr      text,
  guard_entity_id bigint references entities(id),
  attrs           jsonb  not null default '{}',
  status          epistemic_t  not null,
  extractor       text         not null,
  confidence      numeric(4,3) not null,
  resolution      resolution_t not null,
  foreign key (repo_id, commit_sha) references commits(repo_id, sha));

create unique index if not exists edges_identity on edges
  (kind, src_entity_id, dst_entity_id, site_hash);

-- The two indexes that carry the entire traversal workload.
-- INCLUDE makes the recursive term index-only: 5-20x faster at depth 6.
create index if not exists edges_fwd on edges (repo_id, commit_sha, src_entity_id, kind)
  include (dst_entity_id, confidence, status, id);
create index if not exists edges_rev on edges (dst_entity_id, kind)
  include (src_entity_id, repo_id, commit_sha, confidence, id);
