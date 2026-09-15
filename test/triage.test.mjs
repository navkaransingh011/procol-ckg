import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeTicket, parseTicket, allowedVerdicts, extractTriage, maskPII } from "../src/service/triage.mjs";

test("tickets are recognised by prefix or by complaint shape; ordinary questions are not", () => {
  assert.equal(looksLikeTicket("triage: Customer says they cannot see the Create PO button"), true);
  assert.equal(looksLikeTicket("Customer: Reliance Retail\nThe buyer reported that after awarding, the PO is not generated and they see the error \"Template not found\" on the awarding screen. This has been happening since yesterday for all their events."), true);
  assert.equal(looksLikeTicket("How does the approval workflow decide who approves a PO?"), false);
  const t = parseTicket("ticket: Customer: GMMCO\nSubject: PO not generated\nThey get \"Template not found\" after clicking Create PO.");
  assert.equal(t.customer, "GMMCO"); assert.equal(t.subject, "PO not generated"); assert.deepEqual(t.errors, ["Template not found"]);
});

test("verdicts are limited to what the facts support", () => {
  assert.deepEqual(allowedVerdicts({}), ["more_info"]);
  assert.deepEqual(allowedVerdicts({ guides: [{}] }).sort(), ["knowledge", "more_info"]);
  assert.deepEqual(allowedVerdicts({ switches: [{ effective: false, source: "default" }] }), ["more_info"], "a switch at its default proves nothing");
  assert.deepEqual(allowedVerdicts({ switches: [{ effective: false, source: "override" }] }).sort(), ["config", "more_info"]);
  assert.deepEqual(allowedVerdicts({ switches: [{ effective: true, source: "default", read_in_feature: true }] }).sort(), ["config", "more_info"], "a switch the feature's code reads counts");
  assert.ok(allowedVerdicts({ error_hits: [{}] }).includes("engineering"));
  assert.ok(allowedVerdicts({ guides: [{}], code_anchors: [{}] }).includes("engineering"), "a document and code side by side can conflict");
});

test("the model's block is enforced: a verdict the facts do not allow becomes more_info with questions", () => {
  const out = extractTriage("prose\n```triage\n{\"verdict\":\"config\",\"confidence\":\"high\",\"doing\":\"x\",\"cause\":\"y\",\"features\":[],\"switches_to_check\":[],\"checks\":[],\"reply_draft\":\"r\",\"handoff\":null,\"questions\":null}\n```", ["knowledge", "more_info"]);
  assert.equal(out.triage.verdict, "more_info"); assert.equal(out.triage.verdict_requested, "config"); assert.equal(out.downgraded, true);
  assert.ok(out.triage.questions.length >= 2); assert.equal(out.text, "prose");
  assert.equal(maskPII("mail priya@procol.in or call +91 98765 43210"), "mail [email] or call [phone]");
});
