import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsFlow, extractFlow } from "../src/service/flow.mjs";

test("only how/what-happens questions get a diagram", () => {
  assert.equal(wantsFlow("How does the approval workflow decide who approves a PO?"), true);
  assert.equal(wantsFlow("What happens when a supplier submits a bid after the deadline?"), true);
  assert.equal(wantsFlow("Which master configs are on by default?"), false);
  assert.equal(wantsFlow("Show me the Material Template"), false);
  assert.equal(wantsFlow("Walk me through the full journey from creating a purchase request to generating the PO: which screens, buttons and choices, step by step"), true);
  assert.equal(wantsFlow("Which screens call the approvals endpoint?"), false);
});

test("a valid block becomes a flow; refs are checked against the facts; markers for real steps survive", () => {
  const text = `The buyer raises a PR [s1]. The system picks the approval flow [s2]. Approvers act [s3]. Done [s9].

\`\`\`flow
{"steps":[{"id":"s1","label":"Buyer raises a PR","actor":"buyer","kind":"start","ref":"PurchaseRequest"},
          {"id":"s2","label":"System picks the approval flow","actor":"system","kind":"system","ref":"ApprovalFlow#pick","source":"code"},
          {"id":"s3","label":"Approver approves or rejects","actor":"approver","kind":"decision","ref":"NotInFacts"},
          {"id":"s4","label":"PO is created in app/models/po.rb","actor":"system","kind":"end"}],
 "edges":[{"from":"s1","to":"s2"},{"from":"s2","to":"s3"},{"from":"s3","to":"s4","label":"approved"},{"from":"s3","to":"s1","label":"rejected"},{"from":"s9","to":"s1"}]}
\`\`\``;
  const { text: prose, flow } = extractFlow(text, JSON.stringify({ lookups: [{ name: "PurchaseRequest" }, { fqn: "ApprovalFlow#pick" }] }));
  assert.ok(flow);
  assert.deepEqual(flow.steps.map((s) => s.id), ["s1", "s2", "s3"], "the step whose label carries a file path is dropped");
  assert.equal(flow.steps[0].ref, "PurchaseRequest");
  assert.equal(flow.steps[2].ref, null); assert.equal(flow.steps[2].unverified_ref, true);
  assert.equal(flow.partial, true);
  assert.deepEqual(flow.edges.map((e) => `${e.from}>${e.to}`), ["s1>s2", "s2>s3", "s3>s1"], "edges to dropped or unknown steps go");
  assert.doesNotMatch(prose, /```/);
  assert.match(prose, /\[s1\]/); assert.doesNotMatch(prose, /\[s9\]/, "marker for a non-existent step is removed");
});

test("no block or too few steps: prose only, markers removed", () => {
  const r = extractFlow("Just prose [s1].", "{}");
  assert.equal(r.flow, null); assert.equal(r.text, "Just prose.");
  const r2 = extractFlow("x\n```flow\n{\"steps\":[{\"id\":\"s1\",\"label\":\"a\"},{\"id\":\"s2\",\"label\":\"b\"}]}\n```", "{}");
  assert.equal(r2.flow, null); assert.equal(r2.text, "x");
});
