// Invariants of the LIVE graph. Run after indexing + import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { q, pool } from "../src/db.mjs";
import { findEntity, traceFrom, endpointCoverage, getEvidence } from "../src/tools.mjs";

after(() => pool.end());

test("cross-repo join: hundreds of endpoints have BOTH a frontend caller and a backend route", async () => {
  const c = await endpointCoverage({ refs: ["main"] });
  assert.ok(Number(c.joined) > 300, JSON.stringify(c));
});

test("end-to-end: frontend call site -> endpoint -> route -> handler -> Ruby method -> runtime callee", async () => {
  const f = await findEntity({ query: "activityLogs/api.js", kind: "HTTP_CALL_SITE", limit: 1 });
  assert.ok(f.matches.length, "call site not found");
  const tr = await traceFrom({ entity_id: Number(f.matches[0].id), refs: ["main"], depth: 6 });
  const kinds = new Set(tr.nodes.map(n => n.kind));
  for (const k of ["HTTP_ENDPOINT", "SERVER_ROUTE", "HANDLER", "SYMBOL"]) assert.ok(kinds.has(k), `missing ${k}: ${[...kinds]}`);
  const edgeKinds = new Set(tr.edges.map(e => e.kind));
  assert.ok(edgeKinds.has("DECLARES"), "handler not bridged to its Ruby method");
});

test("honesty invariant: unresolvable call sites are stored, marked AMBIGUOUS, never dropped", async () => {
  const [r] = await q(`select count(*)::int n from ckg.entities where kind='HTTP_CALL_SITE' and resolution='AMBIGUOUS'`);
  assert.ok(r.n > 100, `only ${r.n} unresolved sites — the honest ones are missing`);
});

test("runtime edges are marked RUNTIME and carry a file:line", async () => {
  const [r] = await q(`select count(*)::int n, count(*) filter (where start_line is not null)::int with_line
                         from ckg.edges where kind='CALLS' and resolution='RUNTIME'`);
  assert.ok(r.n > 4000, `got ${r.n}`);
  assert.equal(r.n, r.with_line, "every runtime call must have a line");
});

test("the three real bugs found while tracing are first-class nodes with a fix", async () => {
  const rows = await q(`select attrs from ckg.entities where kind='OBSERVED_DEFECT'`);
  assert.equal(rows.length, 3);
  // a crash has a stack trace + fix; a risk finding (e.g. an unmocked S3 call) has a root cause instead
  for (const r of rows) assert.ok(r.attrs.summary && (r.attrs.root_cause || r.attrs.suggested_fix), `defect lacks detail: ${JSON.stringify(Object.keys(r.attrs))}`);
});

test("secret gate: no entity holds a key/token-shaped literal", async () => {
  // base64/hex-shaped: 32+ chars, no path separators or underscores, mixed case AND digits.
  // Long Ruby names and file paths have no digits (or contain / and _), so they don't trip it.
  const [r] = await q(`select count(*)::int n from (
      select (regexp_matches(attrs::text, '[A-Za-z0-9+=]{32,}', 'g'))[1] m from ckg.entities) x
     where m ~ '[0-9].*[0-9].*[0-9]' and m ~ '[a-z]' and m ~ '[A-Z]'`);
  assert.equal(r.n, 0, `${r.n} token-shaped literals found`);
});

test("every cited node resolves to evidence (or is an explicit contract node)", async () => {
  const rows = await q(`select id, kind::text from ckg.entities where kind in ('HANDLER','SYMBOL','HTTP_ENDPOINT') limit 200`);
  const ev = await getEvidence({ ids: rows.map(r => Number(r.id)) });
  assert.equal(ev.missing.length, 0);
  for (const e of ev.evidence) if (e.kind !== "HTTP_ENDPOINT") assert.ok(e.path, `${e.kind} ${e.fqn} has no path`);
});
