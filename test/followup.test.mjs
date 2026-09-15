import { test } from "node:test";
import assert from "node:assert/strict";
import { needsContext } from "../src/service/followup.mjs";

test("follow-ups are recognised; standalone questions are not", () => {
  for (const qn of ["and for RIL?", "show me that template", "what about the supplier side?", "why?", "Also the approval part", "can you expand on the second step"])
    assert.equal(needsContext(qn), true, qn);
  for (const qn of ["How does the approval workflow decide who approves a purchase request?", "Which master configs are on by default for Reliance?", "Show me the RFQ Template - Materials used by GMMCO"])
    assert.equal(needsContext(qn), false, qn);
});
