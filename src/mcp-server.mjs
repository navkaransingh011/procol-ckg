#!/usr/bin/env node
// MCP transport over the query tools. Same functions the dashboard's HTTP endpoint
// will call, so the two surfaces can never disagree.
//
// Wire it up:
//   claude mcp add procol-ckg -- node /abs/path/procol-ckg/src/mcp-server.mjs
//   (with CKG_DATABASE_URL set in the environment)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runSql, SCHEMA_DOC } from "./sqltool.mjs";
import { findEntity, traceFrom, getEvidence, endpointCoverage, listEntities, ownersOf, getSummaries, endpointFamily, readSource, grepSource, NARRATIVE_EDGES } from "./tools.mjs";

const TOOLS = [
  {
    name: "find_entity",
    description:
      "Find a node in the code graph by name, fully-qualified name, or path fragment. " +
      "ALWAYS start here to get an id before tracing. The returned match_reason says how " +
      "weak the match was ('exact_fqn' is certain; 'path_substring' is a guess) — say so in " +
      "your answer when the match is weak.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "name, fqn, or path fragment" },
        kind: {
          type: "string",
          enum: ["FILE", "SYMBOL", "UI_COMPONENT", "UI_ROUTE", "STATE_ACTION", "HTTP_CALL_SITE",
                 "HTTP_ENDPOINT", "SERVER_ROUTE", "HANDLER", "SERVICE", "DB_TABLE", "JOB",
                 "EXTERNAL_SERVICE", "CONFIG_KEY", "TEST_CASE"],
          description: "narrow to one kind",
        },
        repo: { type: "string", enum: ["procol-client-dashboard", "procol-backend"] },
        refs: { type: "array", items: { type: "string" }, description: "scope to these deployed refs, e.g. ['main']" },
        limit: { type: "integer", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "trace_from",
    description:
      "Follow execution from a node. Crosses repo boundaries automatically via the shared " +
      "HTTP_ENDPOINT contract node, so a frontend call site reaches its Rails handler in one " +
      "call. direction='reverse' answers 'what breaks if I change this'. " +
      "READ THE RESULT'S truncated / hubs_not_expanded / unresolved FIELDS AND REPORT THEM: " +
      "an unresolved entry means the trace genuinely stops there because the value is built at " +
      "runtime — that is a correct answer, not a gap to fill from general knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "integer", description: "from find_entity" },
        direction: { type: "string", enum: ["forward", "reverse"], default: "forward" },
        depth: { type: "integer", default: 6, maximum: 6 },
        min_confidence: { type: "string", enum: ["any", "low", "medium", "high"], default: "medium" },
        refs: {
          type: "array", items: { type: "string" }, default: ["main"],
          description: "which deployed refs to read — 'main', 'reliance-main', 'jindal-sandbox', etc. " +
                       "Tenants run different code, so the ref changes the answer.",
        },
        edge_kinds: { type: "array", items: { type: "string" }, default: NARRATIVE_EDGES },
        expand_hubs: {
          type: "boolean", default: false,
          description: "expand through nodes with >100 callers (e.g. promisifiedXHR). Off by default: " +
                       "expanding them reaches most of the codebase and says nothing.",
        },
        max_nodes: { type: "integer", default: 200 },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "get_evidence",
    description:
      "Resolve node ids to file, line, commit, ref and extractor. Call this for every node you " +
      "cite. A claim with no evidence row must be dropped or explicitly marked unverified. " +
      "A null path means a repo-agnostic contract node (an HTTP endpoint), not missing evidence.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "integer" } } },
      required: ["ids"],
    },
  },
  {
    name: "list_entities",
    description:
      "Enumerate EVERY node matching a shape. Use this for 'all', 'every', 'how many', 'which ones' — " +
      "find_entity returns one anchor and cannot express a set. Returns total plus a complete flag.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["FEATURE","PERSON","SYMBOL","UI_COMPONENT","UI_ROUTE","STATE_ACTION",
          "HTTP_CALL_SITE","HTTP_ENDPOINT","SERVER_ROUTE","HANDLER","SERVICE","DB_TABLE","JOB",
          "EXTERNAL_SERVICE","CONFIG_KEY","TEST_CASE","CI_JOB","OBSERVED_DEFECT","FILE"] },
        subkind: { type: "string", description: "attrs.subkind, e.g. 'github_action' to separate CI actions from runtime integrations" },
        path_prefix: { type: "string", description: "e.g. app/services/awarding, or lib/external_api" },
        name_prefix: { type: "string" },
        name_contains: { type: "string" },
        order_by: { type: "string", enum: ["name","activity","path"], description: "'activity' = most-changed first" },
        refs: { type: "array", items: { type: "string" }, default: ["main"] },
        limit: { type: "integer", default: 200 },
      },
    },
  },
  {
    name: "owners_of",
    description:
      "Who has touched this code, from git history — commits, last commit date, nodes touched. " +
      "Derived from commit history, not a formal ownership registry; say so when citing it.",
    inputSchema: {
      type: "object",
      properties: {
        path_prefix: { type: "string" },
        entity_ids: { type: "array", items: { type: "integer" } },
        refs: { type: "array", items: { type: "string" }, default: ["main"] },
        limit: { type: "integer", default: 10 },
      },
    },
  },
  {
    name: "get_summaries",
    description:
      "Cached prose overviews at system / feature / module / symbol altitude. Start here for " +
      "'what does X do' or 'give me the big picture' before tracing anything.",
    inputSchema: {
      type: "object",
      properties: {
        altitude: { type: "string", enum: ["system","feature","module","symbol"] },
        subject_key: { type: "string" },
        audience: { type: "string", enum: ["all","business","technical"], default: "all" },
        refs: { type: "array", items: { type: "string" }, default: ["main"] },
      },
    },
  },
  {
    name: "endpoint_family",
    description: "Every endpoint under a URL prefix with ALL frontend callers (path:line) and the route/handler serving each. " +
                 "Use for 'who calls /x/*' and 'what serves /x/*'. A relationship list, which list_entities cannot express.",
    inputSchema: { type: "object", properties: {
      path_prefix: { type: "string", description: "e.g. /approval_workflow/approval_requests" },
      method: { type: "string", enum: ["GET","POST","PUT","PATCH","DELETE"] },
      refs: { type: "array", items: { type: "string" }, default: ["main"] } }, required: ["path_prefix"] },
  },
  {
    name: "read_source",
    description: "Read numbered source lines for a path the graph knows, at the INDEXED commit (never the working tree). " +
                 "Bounded to 120 lines; secret paths refused. Use after find_entity to see what a method actually does.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string", enum: ["procol-backend","procol-client-dashboard","web-bidding"] },
      path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" },
      context: { type: "integer", default: 0 },
      refs: { type: "array", items: { type: "string" }, default: ["main"] } }, required: ["repo","path"] },
  },
  {
    name: "grep_source",
    description: "Commit-pinned, fixed-string grep across a repo (app/ lib/ src/ config/), max 40 hits with context. " +
                 "Use for 'every place that references X'. Pick distinctive tokens (self.mcp?, not session).",
    inputSchema: { type: "object", properties: {
      repo: { type: "string", enum: ["procol-backend","procol-client-dashboard","web-bidding"] },
      pattern: { type: "string" }, max_hits: { type: "integer", default: 40 }, context: { type: "integer", default: 2 },
      refs: { type: "array", items: { type: "string" }, default: ["main"] } }, required: ["repo","pattern"] },
  },
  {
    name: "run_sql",
    description: "Run one read-only SELECT against the graph views (v_nodes, v_edges, v_refs) as a SELECT-only role with a 5s " +
                 "timeout and 200-row cap. Evidence (repo/path/line) is auto-attached for any entity id column. Schema: " + SCHEMA_DOC.slice(0, 1800),
    inputSchema: { type: "object", properties: { sql: { type: "string" }, note: { type: "string" } }, required: ["sql"] },
  },
  {
    name: "endpoint_coverage",
    description:
      "Counts of endpoints joined frontend↔backend, called-but-not-served (dead frontend calls " +
      "or served elsewhere), and served-but-not-called (unused by this client).",
    inputSchema: {
      type: "object",
      properties: { refs: { type: "array", items: { type: "string" }, default: ["main"] } },
    },
  },
];

const HANDLERS = {
  run_sql: runSql,
  endpoint_family: endpointFamily,
  read_source: readSource,
  grep_source: grepSource,
  list_entities: listEntities,
  owners_of: ownersOf,
  get_summaries: getSummaries,
  find_entity: findEntity,
  trace_from: traceFrom,
  get_evidence: getEvidence,
  endpoint_coverage: endpointCoverage,
};

const server = new Server(
  { name: "procol-ckg", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = HANDLERS[req.params.name];
  if (!fn) return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
  try {
    const out = await fn(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `${e.name}: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
