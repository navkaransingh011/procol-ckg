set search_path = ckg, public;

-- Pre-written prose. This is what makes a "big picture" answer cost one row
-- instead of 3.4M tokens of source. Keyed by subject + altitude + commit.
create table if not exists summaries (
  id          bigint primary key generated always as identity,
  repo_id     int   not null references repos(id),
  commit_sha  bytea not null,
  altitude    text  not null check (altitude in ('system','feature','module','symbol')),
  subject_id  bigint references entities(id),        -- null for altitude='system'
  subject_key text  not null,                        -- 'system' | feature fqn | entity fqn
  audience    text  not null default 'all' check (audience in ('all','business','technical')),
  headline    text  not null,
  body        text  not null,
  evidence_ids bigint[] not null default '{}',
  entity_count int   not null default 0,
  generated_by text  not null,                       -- 'FAST_SMALLER@slingring' etc
  status      epistemic_t not null default 'DERIVED',
  generated_at timestamptz not null default now(),
  foreign key (repo_id, commit_sha) references commits(repo_id, sha),
  unique (repo_id, commit_sha, altitude, subject_key, audience));

create index if not exists summaries_lookup on summaries (repo_id, commit_sha, altitude);
create index if not exists summaries_subject on summaries (subject_id);
create index if not exists summaries_trgm on summaries using gin (headline gin_trgm_ops);
