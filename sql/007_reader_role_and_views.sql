set search_path = ckg, public;

do $$ begin
  create role ckg_reader login password 'ckg_reader_local';   -- local dev only; rotate when hosted
exception when duplicate_object then null; end $$;
grant usage on schema ckg to ckg_reader;
grant select on all tables in schema ckg to ckg_reader;
alter default privileges in schema ckg grant select on tables to ckg_reader;
alter role ckg_reader set statement_timeout = '5s';
alter role ckg_reader set default_transaction_read_only = on;
alter role ckg_reader set search_path = ckg, public;
alter role ckg_reader set work_mem = '32MB';

-- Views that bake the guards in, so a model-written query cannot forget them.
-- v_refs: the latest commit each ref points at, per repo.
create or replace view v_refs as
  select distinct on (r.repo_id, r.ref_name)
         r.repo_id, rp.name as repo, r.ref_name as ref, r.tenant, r.env,
         r.commit_sha, encode(r.commit_sha,'hex') as commit
    from ref_history r join repos rp on rp.id = r.repo_id
   order by r.repo_id, r.ref_name, r.last_seen desc;

-- v_nodes: one row per entity, with repo name and the ref(s) it is visible under.
-- Contract nodes (HTTP_ENDPOINT) belong to no repo/commit: ref is NULL for them.
create or replace view v_nodes as
  select e.id, rp.name as repo, v.ref, v.tenant, e.kind::text as kind, e.fqn, e.name, e.path,
         e.start_line, e.end_line, e.attrs->>'subkind' as subkind, e.attrs,
         e.resolution::text as resolution, e.confidence, e.extractor
    from entities e
    left join repos rp on rp.id = e.repo_id
    left join v_refs v on v.repo_id = e.repo_id and v.commit_sha = e.commit_sha;

-- v_edges: one row per edge with both endpoints named. The edge's own resolution is here:
-- RUNTIME means the call was observed in a real test run.
create or replace view v_edges as
  select g.id, v.repo, v.ref, g.kind::text as kind,
         g.src_entity_id, s.kind::text as src_kind, s.name as src_name, s.fqn as src_fqn, s.path as src_path, s.start_line as src_line,
         g.dst_entity_id, d.kind::text as dst_kind, d.name as dst_name, d.fqn as dst_fqn, d.path as dst_path, d.start_line as dst_line,
         g.resolution::text as resolution, g.confidence, g.start_line as line, g.guard_expr, g.attrs
    from edges g
    join entities s on s.id = g.src_entity_id
    join entities d on d.id = g.dst_entity_id
    left join v_refs v on v.repo_id = g.repo_id and v.commit_sha = g.commit_sha;

grant select on v_refs, v_nodes, v_edges to ckg_reader;
