-- An HTTP_ENDPOINT is a contract on the wire. It belongs to NO repo -- that is the
-- entire point of the shared-node design, and pinning it to one broke the join:
-- the frontend and the backend were each creating their own private copy.
set search_path = ckg, public;

alter table entities alter column repo_id drop not null;

drop index if exists entities_identity;
create unique index entities_identity on entities
  (coalesce(repo_id, 0), coalesce(commit_sha, '\x00'::bytea), kind, fqn);
