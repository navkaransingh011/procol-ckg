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
import { findEntity, traceFrom, getEvidence, endpointCoverage, NARRATIVE_EDGES } from "./tools.mjs";

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
