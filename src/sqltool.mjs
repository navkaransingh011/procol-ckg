// Let the model write its own SQL -- against a read-only role, through a timeout, under a row
// cap, with evidence auto-attached to any entity id it returns. The database enforces safety;
// the checks here only produce clearer error messages than Postgres would.
import { LIVE_DOC } from "./tools.mjs";
import pg from "pg";
import { getEvidence } from "./tools.mjs";

const reader = new pg.Pool({ connectionString: process.env.CKG_READER_URL || "postgres://ckg_reader:ckg_reader_local@localhost/ckg", max: 4 });

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|vacuum|analyze|listen|notify|lock|refresh|into|pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|set\s+role|set\s+session)\b/i;
const ROW_CAP = 200;

export async function runSql({ sql, note = null }) {
  if (typeof sql !== "string") return { error: "sql must be a string" };
  let s = sql.trim().replace(/;\s*$/, "");
  if (!/^\s*(with|select)\b/i.test(s)) return { error: "only a single SELECT (or WITH ... SELECT) is allowed" };
  if (s.includes(";")) return { error: "one statement only" };
  if (FORBIDDEN.test(s)) return { error: `forbidden keyword: ${s.match(FORBIDDEN)[0]}` };
  const wrapped = `select * from (${s}) _q limit ${ROW_CAP + 1}`;
  const t0 = Date.now();
  let rows;
  try { rows = (await reader.query(wrapped)).rows; }
  catch (e) { return { error: `${e.message}`, hint: e.position ? `near character ${e.position}` : undefined, sql: s }; }
  const capped = rows.length > ROW_CAP;
  if (capped) rows = rows.slice(0, ROW_CAP);

  // Provenance: any column that looks like an entity id gets evidence attached, so the model
  // can cite path:line without a second round trip -- and cannot cite what it did not fetch.
  const idCols = rows.length ? Object.keys(rows[0]).filter(c => /^(id|entity_id|src_entity_id|dst_entity_id|subject_id)$/.test(c)) : [];
  const ids = [...new Set(rows.flatMap(r => idCols.map(c => r[c])).filter(v => v != null && Number.isFinite(Number(v))).map(Number))].slice(0, 80);
  const ev = ids.length ? await getEvidence({ ids }) : { evidence: [] };
  return { note, sql: s, ms: Date.now() - t0, row_count: rows.length, capped,
           columns: rows.length ? Object.keys(rows[0]) : [], rows,
           evidence: ev.evidence.map(e => ({ id: e.id, repo: e.repo, path: e.path, line: e.start_line, kind: e.kind, extractor: e.extractor })) };
}

export const SCHEMA_DOC = `
LIVE PLATFORM DATA (read-only mirror of UAT, schema live.*; allowlisted columns only; jsonb columns filter with @>):
${LIVE_DOC}
Example: select config_key, name, defaults from live.master_configurations where defaults @> '{"value": true}' order by config_key;
You query a PostgreSQL code-knowledge graph (schema "ckg") through three read-only views.
Every query MUST be a single SELECT. Results are capped at 200 rows -- use WHERE, LIMIT, GROUP BY.

v_nodes(id, repo, ref, tenant, kind, fqn, name, path, start_line, end_line, subkind, attrs jsonb, resolution, confidence, extractor)
  kind values: FEATURE, PERSON, SYMBOL, HANDLER, SERVER_ROUTE, HTTP_ENDPOINT, HTTP_CALL_SITE, DB_TABLE,
               EXTERNAL_SERVICE, CI_JOB, FILE, OBSERVED_DEFECT, JOB, CONFIG_KEY, UI_ROUTE, UI_COMPONENT, STATE_ACTION
  repo values: 'procol-backend' | 'procol-client-dashboard' | 'web-bidding'
  ALWAYS filter ref = 'main' (or another deployed ref). HTTP_ENDPOINT rows have ref IS NULL and repo IS NULL
  (they are shared contract nodes) -- include them with (ref = 'main' OR ref IS NULL) when you need them.
  SYMBOL.name is 'Class#method' or 'Class.method'; subkind in (method, class_method, class, module).
  HANDLER.name is 'api/v1/trade#quote_details'. HTTP_ENDPOINT.name is '/v1/trade/*/quote_details/*' (params are *).
  DB_TABLE.attrs->'columns' is a JSON array of {name,type}. FEATURE.attrs has bullets, dirs, sources, activity.
  OBSERVED_DEFECT.attrs has summary, root_cause, suggested_fix, trigger_condition, real_stack_trace.
  EXTERNAL_SERVICE: runtime integrations have path LIKE 'lib/external_api/%'; CI actions have subkind='github_action'.

v_edges(id, repo, ref, kind, src_entity_id, src_kind, src_name, src_fqn, src_path, src_line,
        dst_entity_id, dst_kind, dst_name, dst_fqn, dst_path, dst_line, resolution, confidence, line, attrs)
  kind values and direction:
    TARGETS      HTTP_CALL_SITE -> HTTP_ENDPOINT      (frontend call hits an endpoint)
    SERVES       SERVER_ROUTE   -> HTTP_ENDPOINT      (a Rails route serves it)   NOTE: both point INTO the endpoint
    HANDLED_BY   SERVER_ROUTE   -> HANDLER
    DECLARES     HANDLER -> SYMBOL(method)  |  SYMBOL(class) -> SYMBOL(method)
    CALLS        SYMBOL -> SYMBOL           resolution='RUNTIME' means observed in a real test run (strongest)
    TRIGGERS_DEFECT  SYMBOL -> OBSERVED_DEFECT
    IMPLEMENTS   FEATURE -> code            OWNS  PERSON -> code (attrs->>'commits_touching', attrs->>'last_commit')
    USES_SERVICE CI_JOB -> EXTERNAL_SERVICE
  resolution values: RUNTIME (observed), EXACT / FRAMEWORK_DUMP (read from source structure), DOCUMENTED (a human wrote it),
                     VCS (git history), HEURISTIC (inferred from a name), AMBIGUOUS (could not resolve).
  Absence of a CALLS edge is NOT evidence a call never happens: RUNTIME edges exist only where tests ran.

v_refs(repo, ref, tenant, env, commit)

Cross-repo path, frontend to Rails handler (note the direction flip at the endpoint):
  select cs.src_path, cs.src_line, ep.name as endpoint, h.dst_name as handler
    from v_edges cs                                  -- TARGETS: call site -> endpoint
    join v_nodes ep on ep.id = cs.dst_entity_id and ep.kind='HTTP_ENDPOINT'
    join v_edges sv on sv.dst_entity_id = ep.id and sv.kind='SERVES'      -- route -> endpoint
    join v_edges h  on h.src_entity_id = sv.src_entity_id and h.kind='HANDLED_BY'
   where cs.kind='TARGETS' and cs.ref='main' and sv.ref='main' and ep.name like '/approval_workflow/%';

Runtime callees of a method:
  select dst_name, dst_path, dst_line from v_edges
   where kind='CALLS' and resolution='RUNTIME' and ref='main' and src_name='Api::V1::TradeController#quote_details';

Every column of a table:
  select c->>'name' as col, c->>'type' as type from v_nodes, jsonb_array_elements(attrs->'columns') c
   where kind='DB_TABLE' and ref='main' and name='custom_configurations';`;
