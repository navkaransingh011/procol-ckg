-- Three layers the graph lacked. All derived from data already in the repos.
--   FEATURE  product capability  ("eRFx", "Approval Workflows")  <- mcp_tools, CODEBASE_INDEX, dirs
--   PERSON   a contributor                                        <- git log
--   summaries  cached prose at several altitudes                  <- written once, read many times
set search_path = ckg, public;

alter type entity_kind_t add value if not exists 'FEATURE';
alter type entity_kind_t add value if not exists 'PERSON';
alter type edge_kind_t   add value if not exists 'IMPLEMENTS';   -- FEATURE -> code
alter type edge_kind_t   add value if not exists 'OWNS';         -- PERSON  -> code/feature
alter type resolution_t  add value if not exists 'DOCUMENTED';   -- a human wrote this down
alter type resolution_t  add value if not exists 'VCS';          -- derived from git history
