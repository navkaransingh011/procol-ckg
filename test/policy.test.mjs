// Role policy is the guard, not the prompt: a restricted role's facts and events must carry no code it may not see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { policyFor, redactFacts, filterEvent, allowedRefs, styleFor, isOpen } from "../src/service/policy.mjs";

const facts = {
  question: "why does app/models/bid.rb reject?",
  refs: ["main"],
  lookups: [{ anchor: { kind: "SYMBOL", name: "Bid#validate", path: "app/models/bid.rb", line: 12 }, downstream: [] },
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
});

test("cs gets documents, live data and configs, but no code, paths or source", () => {
  const p = policyFor("cs");
  const f = redactFacts(facts, p);
  assert.equal(f.source, undefined);
  assert.equal(f.greps, undefined);
  assert.equal(f.endpoint_families, undefined);
  assert.equal(f.lookups.length, 1, "the SYMBOL lookup is dropped, the FEATURE stays");
  assert.equal(f.lookups[0].anchor.kind, "FEATURE");
  assert.equal(f.documents[0].text, "A bid below reserve is rejected.");
  assert.equal(f.live[0].rows[0].config_key, "flexi_po_lock");
  assert.equal(f.config_candidates[0].name, "Flexi PO lock");
  assert.equal(f.owners.scope, undefined, "path-like scope removed");
  assert.equal(f.owners.people[0].name, "Priya");
  assert.doesNotMatch(JSON.stringify(f), /app\/models/);
  assert.equal(styleFor(p), "simple");
});

test("cs event stream: no context paths, no code evidence, prose paths scrubbed, tables kept", () => {
  const p = policyFor("cs");
  assert.equal(filterEvent({ type: "context_paths", paths: ["a/b.rb"] }, p), null);
  assert.equal(filterEvent({ type: "evidence", id: 1, kind: "SYMBOL", path: "app/x.rb", line: 3, extractor: "be-ast" }, p), null);
  const doc = filterEvent({ type: "evidence", id: "d1", path: "uploads/rules.md", extractor: "docs" }, p);
  assert.equal(doc.id, "d1"); assert.equal(doc.path, undefined);
  assert.equal(filterEvent({ type: "claim", kind: "HTTP_CALL_SITE", text: "x" }, p), null);
  const tok = filterEvent({ type: "token", text: "See `app/services/bid_service.rb:40` for the check." }, p);
  assert.equal(tok.text, "See a file for the check.");
  const table = { type: "table", table: "master_configurations", rows: [{ a: 1 }] };
  assert.equal(filterEvent(table, p), table);
});

test("qa keeps names and endpoints but never paths or source", () => {
  const p = policyFor("qa");
  const f = redactFacts(facts, p);
  assert.equal(f.source, undefined);
  assert.equal(f.lookups.length, 2);
  assert.equal(f.lookups[0].anchor.name, "Bid#validate");
  assert.equal(f.lookups[0].anchor.path, undefined);
  assert.ok(f.endpoint_families);
  const ev = filterEvent({ type: "evidence", id: 1, kind: "SYMBOL", path: "app/x.rb", line: 3, extractor: "be-ast" }, p);
  assert.equal(ev.id, 1); assert.equal(ev.path, undefined); assert.equal(ev.line, undefined);
});

test("branch access follows the role; unknown roles fall back to the default", () => {
  assert.deepEqual(allowedRefs(policyFor("cs"), ["ril-qa-final", "main"]), ["main"]);
  assert.deepEqual(allowedRefs(policyFor("cs"), ["ril-qa-final"]), ["main"]);
  assert.deepEqual(allowedRefs(policyFor("engineer"), ["ril-qa-final"]), ["ril-qa-final"]);
  assert.equal(policyFor("nope").role, "cs");
});
