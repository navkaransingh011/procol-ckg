// Confidence comes from how the facts were found, and side facts reach the writer only when they stand clear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConfidence, clearTop } from "../src/service/confidence.mjs";

const score = (x) => x.score;

test("clearTop keeps the best, adds a close runner-up, and drops a flat field as noise", () => {
  assert.deepEqual(clearTop([{ k: "a", score: 0.81 }, { k: "b", score: 0.79 }, { k: "c", score: 0.66 }, { k: "d", score: 0.63 }], score, { floor: 0.6 }).kept.map(x => x.k), ["a", "b"]);
  assert.deepEqual(clearTop([{ k: "a", score: 0.81 }, { k: "b", score: 0.70 }, { k: "c", score: 0.66 }], score, { floor: 0.6 }).kept.map(x => x.k), ["a"], "runner-up too far behind");
  const flat = clearTop([{ k: "a", score: 0.70 }, { k: "b", score: 0.69 }, { k: "c", score: 0.68 }, { k: "d", score: 0.67 }], score, { floor: 0.6 });
  assert.deepEqual(flat.kept, []); assert.equal(flat.flat, true); assert.equal(flat.dropped, 4);
  const lenient = clearTop([{ k: "a", score: 0.70 }, { k: "b", score: 0.69 }, { k: "c", score: 0.68 }], score, { floor: 0.6, lenient: true });
  assert.deepEqual(lenient.kept.map(x => x.k), ["a", "b"], "a question explicitly about this data still gets the best two");
  assert.deepEqual(clearTop([{ k: "a", score: 0.5 }], score, { floor: 0.6 }).kept, [], "below the floor");
  assert.deepEqual(clearTop([], score).kept, []);
});

test("a journey read from the code in the order asked, confirmed by documents, is high even when the name lookups were fuzzy", () => {
  const c = assessConfidence({
    lookups: [{ match: "approximate", matched_on: "awarding", anchor: { kind: "UI_ROUTE", name: "Awarding" } }],
    screen_journey: { screens: [{ screen: "New Event" }, { screen: "Awarding" }, { screen: "Purchase Orders" }], follows_question_order: true },
    screens: [{ id: 1 }], documents: [{ score: 0.78 }, { score: 0.71 }], journeyQuestion: true,
  });
  assert.equal(c.level, "high");
  assert.match(c.reason, /screen chain .* in the order asked/);
  assert.match(c.reason, /2 document passages/);
  assert.equal(c.missing, undefined);
});

test("a fuzzy name match with nothing else behind it is low, and says what is missing", () => {
  const c = assessConfidence({ lookups: [{ match: "approximate", matched_on: "reject", anchor: { kind: "SYMBOL", name: "Bid#validate" } }], sem: [{ score: 0.58 }] });
  assert.equal(c.level, "low");
  assert.match(c.reason, /only a fuzzy name match on "reject"/);
  assert.doesNotMatch(c.reason, /Bid#validate/, "code names never leak into the reason");
  assert.equal(c.missing, "no document covers this");
});

test("an exact code match with a clean trace is high on its own; an unresolved trace is medium", () => {
  const clean = assessConfidence({ lookups: [{ match: "exact", anchor: { kind: "SYMBOL", name: "Bid#validate" } }] });
  assert.equal(clean.level, "high");
  assert.equal(clean.reason, "an exact match in the code");
  const broken = assessConfidence({ lookups: [{ match: "exact", anchor: { kind: "SYMBOL", name: "Bid#validate" } }], unresolved: 3 });
  assert.equal(broken.level, "medium");
  assert.equal(broken.missing, "part of the code path could not be followed");
});

test("a state question answered by live rows the planner asked for is high; live rows nobody asked for do not count", () => {
  const asked = assessConfidence({ lookups: [], live: [{ table: "custom_configurations", total: 12 }], planAskedLive: true });
  assert.equal(asked.level, "high");
  assert.match(asked.reason, /live platform rows answer it directly/);
  const unasked = assessConfidence({ lookups: [], live: [{ table: "approval_flows", total: 77 }], planAskedLive: false });
  assert.equal(unasked.level, "low");
});

test("documents alone are medium; nothing at all is low", () => {
  const docs = assessConfidence({ lookups: [{ match: "none" }], documents: [{ score: 0.74 }] });
  assert.equal(docs.level, "medium");
  assert.match(docs.reason, /only documents cover it/);
  const nothing = assessConfidence({ lookups: [{ match: "none" }], sem: [{ score: 0.5 }] });
  assert.equal(nothing.level, "low");
  assert.match(nothing.reason, /nothing matched by name/);
});

test("a journey question whose screens were matched out of order is medium and names that as the gap", () => {
  const c = assessConfidence({ lookups: [{ match: "exact", anchor: { kind: "UI_ROUTE", name: "Awarding" } }],
                               screen_journey: { screens: [{ screen: "Awarding" }, { screen: "Events" }], follows_question_order: false }, journeyQuestion: true, unresolved: 1 });
  assert.equal(c.level, "high", "an exact screen match plus a chain is still two sources");
  const weakOrder = assessConfidence({ lookups: [{ match: "approximate", matched_on: "po" }],
                                       screen_journey: { screens: [{ screen: "Awarding" }, { screen: "Events" }], follows_question_order: false }, journeyQuestion: true });
  assert.equal(weakOrder.level, "medium");
  assert.equal(weakOrder.missing, "the screens were matched, but not in the order the question asked");
});
