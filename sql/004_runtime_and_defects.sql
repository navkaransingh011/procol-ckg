-- Teammate's pipeline adds two things ours lacked: RUNTIME-verified call edges
-- (TracePoint over real rspec runs) and real bugs found while running them.
set search_path = ckg, public;
alter type entity_kind_t add value if not exists 'CI_JOB';
alter type entity_kind_t add value if not exists 'OBSERVED_DEFECT';
alter type edge_kind_t   add value if not exists 'TRIGGERS_DEFECT';
-- RUNTIME: observed during real execution. Static analysis over-approximates,
-- runtime tracing is sound but incomplete -- where both agree, confidence is certain.
alter type resolution_t  add value if not exists 'RUNTIME';
