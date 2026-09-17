// Hybrid retrieval pieces: the word query built from a question, reciprocal-rank fusion, and the cross-encoder's
// graceful path. The model itself is exercised only when it is already cached (no network in tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lexicalQuery, DOC_RERANK_FLOOR } from "../src/tools.mjs";
import { fuse, rerank, disposeReranker } from "../src/service/rerank.mjs";

test("lexicalQuery: typed snake_case keys are kept whole, stop words go, the rest becomes an OR query", () => {
  const l = lexicalQuery("What does the switch custom_po_enabled do and who has it on?");
  assert.deepEqual(l.keys, ["custom_po_enabled"]);
  assert.ok(l.words.includes("switch") && l.words.includes("enabled"));
  assert.ok(!l.words.includes("what") && !l.words.includes("does"));
  assert.match(l.tsquery, /^[a-z0-9]+( \| [a-z0-9]+)+$/);
  assert.equal(lexicalQuery("the and of").tsquery, null, "nothing left after stop words");
  assert.deepEqual(lexicalQuery("Is partial awarding enabled for Reliance?").keys, []);
});

test("fuse: an item high in two lists beats one that tops a single list", () => {
  const a = [{ id: "x" }, { id: "y" }, { id: "z" }], b = [{ id: "y" }, { id: "w" }];
  const out = fuse([a, b], (r) => r.id);
  assert.equal(out[0].id, "y");
  assert.ok(out.every((r) => typeof r.fused === "number"));
  assert.equal(out.length, 4);
});

test("rerank: switched off, the items come back in order with rerank null and cut to top", async () => {
  const prev = process.env.CKG_RERANK; process.env.CKG_RERANK = "0";
  try {
    const out = await rerank("anything", [{ t: "a" }, { t: "b" }, { t: "c" }], (x) => x.t, { top: 2 });
    assert.deepEqual(out.map((x) => x.t), ["a", "b"]);
    assert.equal(out[0].rerank, null);
    assert.deepEqual(await rerank("anything", [], (x) => x.t), []);
  } finally { if (prev === undefined) delete process.env.CKG_RERANK; else process.env.CKG_RERANK = prev; }
});

test("rerank: with the model available, the passage that answers the question ranks first and off-topic text falls under the floor", async () => {
  const q = "How does a buyer create a purchase order after awarding an event?";
  const items = [
    { t: "The dashboard's styling uses CSS variables for colours and spacing across components." },
    { t: "After awarding the event, the buyer clicks Create PO on the Awarding screen, fills the PO form and submits it for approval." },
    { t: "The MS Teams bot is configured with an app registration and a webhook URL." },
  ];
  const out = await rerank(q, items, (x) => x.t, { top: 3 });
  if (out[0].rerank == null) { console.log("  (reranker model not cached here; skipping the ordering assertion)"); return; }
  assert.match(out[0].t, /Create PO/);
  assert.ok(out[0].rerank > 0.5, `top passage should be confidently relevant, got ${out[0].rerank}`);
  assert.ok(out.slice(1).every((x) => x.rerank < DOC_RERANK_FLOOR), `off-topic passages should fall under ${DOC_RERANK_FLOOR}: ${out.slice(1).map((x) => x.rerank)}`);
  await disposeReranker();
});
