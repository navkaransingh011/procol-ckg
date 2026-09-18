// Role policy decides what a reader SEES, never what the writer understands. The facts keep the code for every role;
// the role's view is applied to the facts' tags and paths, to every event, and to the prose by scrubbing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { policyFor, redactFacts, filterEvent, allowedRefs, styleFor, isOpen, codeNamesIn, scrubCodeNames } from "../src/service/policy.mjs";

const facts = {
  question: "why does app/models/bid.rb reject?",
  refs: ["main"],
  lookups: [{ anchor: { kind: "SYMBOL", name: "Bid#validate", fqn: "Bid#validate", path: "app/models/bid.rb", line: 12 },
              downstream: [{ kind: "SYMBOL", name: "BidMultiplePoHelper#with_multiple_po_lock" }, { kind: "DB_TABLE", name: "trade_requests" }] },
            { anchor: { kind: "FEATURE", name: "Bidding" } }],
  source: [{ path: "app/models/bid.rb", text: "def validate" }],
  greps: [{ pattern: "validate", hits: [] }],
  endpoint_families: [{ endpoint: "POST /bids", family: [] }],
  documents: [{ kind: "DOCUMENT", title: "Bidding rules", text: "A bid below reserve is rejected." }],
  live: [{ table: "master_configurations", rows: [{ config_key: "flexi_po_lock", defaults: { value: true } }] }],
  config_candidates: [{ config_key: "flexi_po_lock", name: "Flexi PO lock" }],
  owners: { scope: "app/models", people: [{ kind: "PERSON", name: "Priya" }] },
};

test("engineer sees everything untouched", () => {
  const p = policyFor("engineer");
  assert.ok(isOpen(p));
  assert.equal(redactFacts(facts, p), facts);
  assert.deepEqual(filterEvent({ type: "context_paths", paths: ["a/b.rb"] }, p), { type: "context_paths", paths: ["a/b.rb"] });
  assert.equal(styleFor(p), "auto");
  assert.deepEqual(codeNamesIn(facts, p), [], "nothing to scrub for a role that may see code");
});

test("cs: the writer still READS the code -- lookups, source, greps stay -- but the facts are tagged plain and paths are gone", () => {
  const p = policyFor("cs");
  const f = redactFacts(facts, p);
  assert.equal(f.presentation, "plain");
  assert.equal(f.may_show_code, false); assert.equal(f.may_show_source, false); assert.equal(f.may_show_paths, false);
  assert.equal(f.lookups.length, 2, "the SYMBOL lookup stays: understanding comes from it");
  assert.equal(f.source.length, 1); assert.equal(f.source[0].text, "def validate");
  assert.equal(f.source[0].path, undefined, "path fields removed");
  assert.ok(f.greps && f.endpoint_families, "greps and endpoint families stay for understanding");
  assert.equal(f.documents[0].text, "A bid below reserve is rejected.");
  assert.equal(f.live[0].rows[0].config_key, "flexi_po_lock");
  assert.equal(f.owners.scope, undefined, "path-like scope removed");
  assert.doesNotMatch(JSON.stringify(f), /app\/models/, "no path string survives");
  assert.equal(styleFor(p), "simple");
});

test("cs prose scrub: code names from the facts and code shapes are replaced, product words survive, the 'In the code' line goes", () => {
  const p = policyFor("cs");
  const names = codeNamesIn(facts, p);
  assert.ok(names.some((n) => n.name === "Bid#validate"));
  assert.ok(names.some((n) => n.name === "BidMultiplePoHelper#with_multiple_po_lock"));
  assert.ok(names.some((n) => n.name === "trade_requests" && n.kind === "DB_TABLE"));
  assert.ok(names.some((n) => n.name === "POST /bids"), "endpoint strings are collected when endpoints are hidden");
  assert.ok(!names.some((n) => n.name === "Bidding"), "a feature name is not code");
  const prose = "Bid#validate checks `BidMultiplePoHelper#with_multiple_po_lock` before writing to `trade_requests`; Api::V1::TradeController#quote_details then calls POST /bids. " +
                "The custom_po_enabled switch on the New Event screen stays off for Reliance; it syncs to SAP.\n\nIn the code: app/models/bid.rb and app/services/x.rb.\n";
  const out = scrubCodeNames(prose, names);
  assert.doesNotMatch(out, /Bid#validate|BidMultiplePoHelper|trade_requests|TradeController|POST \/bids/);
  assert.doesNotMatch(out, /In the code/);
  assert.match(out, /the system checks the system before writing to the database/);
  assert.match(out, /custom_po_enabled switch on the New Event screen stays off for Reliance; it syncs to SAP/, "config keys, screens, customers and integrations stay");
});

test("cs event stream: no context paths, no code evidence, prose paths and code shapes scrubbed, tables kept", () => {
  const p = policyFor("cs");
  assert.equal(filterEvent({ type: "context_paths", paths: ["a/b.rb"] }, p), null);
  assert.equal(filterEvent({ type: "evidence", id: 1, kind: "SYMBOL", path: "app/x.rb", line: 3, extractor: "be-ast" }, p), null);
  const doc = filterEvent({ type: "evidence", id: "d1", path: "uploads/rules.md", extractor: "docs" }, p);
  assert.equal(doc.id, "d1"); assert.equal(doc.path, undefined);
  assert.equal(filterEvent({ type: "claim", kind: "HTTP_CALL_SITE", text: "x" }, p), null);
  const tok = filterEvent({ type: "token", text: "See `app/services/bid_service.rb:40` for the check." }, p);
  assert.equal(tok.text, "See a file for the check.");
  const st = filterEvent({ type: "status", text: "looking up: Api::V1::TradeController#quote_details · app/controllers/api" }, p);
  assert.doesNotMatch(st.text, /TradeController|app\/controllers/);
  const table = { type: "table", table: "master_configurations", rows: [{ a: 1 }] };
  assert.equal(filterEvent(table, p), table);
});

test("qa keeps names and endpoints but never paths; source is read, not quoted", () => {
  const p = policyFor("qa");
  const f = redactFacts(facts, p);
  assert.equal(f.presentation, "technical");
  assert.equal(f.may_show_code, true); assert.equal(f.may_show_source, false); assert.equal(f.may_show_paths, false);
  assert.equal(f.lookups.length, 2);
  assert.equal(f.lookups[0].anchor.name, "Bid#validate");
  assert.equal(f.lookups[0].anchor.path, undefined);
  assert.ok(f.endpoint_families);
  const ev = filterEvent({ type: "evidence", id: 1, kind: "SYMBOL", path: "app/x.rb", line: 3, extractor: "be-ast" }, p);
  assert.equal(ev.id, 1); assert.equal(ev.path, undefined); assert.equal(ev.line, undefined);
  assert.deepEqual(codeNamesIn(facts, p), [], "qa may see names: nothing to scrub");
});

test("branch access follows the role; unknown roles fall back to the default", () => {
  assert.deepEqual(allowedRefs(policyFor("cs"), ["ril-qa-final", "main"]), ["main"]);
  assert.deepEqual(allowedRefs(policyFor("cs"), ["ril-qa-final"]), ["main"]);
  assert.deepEqual(allowedRefs(policyFor("engineer"), ["ril-qa-final"]), ["ril-qa-final"]);
  assert.equal(policyFor("nope").role, "cs");
});
