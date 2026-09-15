// Chats are personal, replayable and pruned by age. Uses the database; cleans up after itself.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createChat, appendTurn, getChat, listChats, historyFor, renameChat, deleteChat, sweepRetention, extractEntities } from "../src/service/chats.mjs";
import { pool, q } from "../src/db.mjs";
after(() => pool.end());

const me = "chats-test@procol.in", other = "someone-else@procol.in";
const events = [{ type: "intent", intent: "simple" }, { type: "status", text: "transient" },
                { type: "claim", kind: "UI_ROUTE", name: "Purchase Requisition" }, { type: "template", name: "RFQ Template - Materials", layout: "sheet" },
                { type: "token", text: "You start on the Purchase Requisition screen." }, { type: "done", ms: 1200 }];

test("a chat stores turns, replays events, condenses history, and is invisible to others", async () => {
  const c = await createChat(me);
  const t1 = await appendTurn(me, c.id, { question: "How does a buyer create a PO from a PR?", refs: ["main"], role: "cs", events, model: "FAST_SMALLER", ms: 1200 });
  assert.equal(t1.seq, 1); assert.ok(t1.bytes > 0 && t1.bytes < 2000, "gzipped");
  await appendTurn(me, c.id, { question: "and for RIL?", standalone_question: "How does a Reliance buyer create a PO from a PR?", refs: ["main"], role: "cs", events });
  const full = await getChat(me, c.id);
  assert.equal(full.title, "How does a buyer create a PO from a PR?");
  assert.equal(full.turns.length, 2);
  assert.equal(full.turns[0].events.some((e) => e.type === "status"), false, "status lines are not stored");
  assert.equal(full.turns[0].answer_text, "You start on the Purchase Requisition screen.");
  assert.equal(full.turns[1].standalone_question, "How does a Reliance buyer create a PO from a PR?");
  assert.deepEqual(extractEntities(events), [{ kind: "UI_ROUTE", name: "Purchase Requisition" }, { kind: "TEMPLATE", name: "RFQ Template - Materials" }]);
  const h = await historyFor(me, c.id);
  assert.equal(h.length, 2); assert.equal(h[1].understood_as, "How does a Reliance buyer create a PO from a PR?"); assert.ok(h[0].answer.startsWith("You start"));
  assert.equal(await getChat(other, c.id), null, "another person cannot open it");
  assert.equal((await listChats(other)).some((x) => x.id === c.id), false);
  assert.equal((await renameChat(me, c.id, "PR to PO")).title, "PR to PO");
  // retention: backdate one turn by ten years and sweep anything older than nine
  await q(`update ckg.chat_turns set created_at = now() - interval '10 years' where chat_id = $1 and seq = 1`, [c.id]);
  assert.equal(await sweepRetention(9 * 365), 1);
  const after = await getChat(me, c.id);
  assert.equal(after.turns[0].pruned, true); assert.equal(after.turns[0].events, null); assert.ok(after.turns[0].answer_text, "text survives pruning");
  assert.equal(after.turns[1].pruned, false);
  assert.equal(await deleteChat(other, c.id), false);
  assert.equal(await deleteChat(me, c.id), true);
  assert.equal(await getChat(me, c.id), null);
});
