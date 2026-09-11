import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEndpoint as n } from "../src/normalize.mjs";

test("template params and rails params both become *", () => {
  assert.equal(n("/event_groups/*/participants"), "/event_groups/*/participants");
  assert.equal(n("/event_groups/:id/participants"), "/event_groups/*/participants");
});
test("query string is evidence, not identity", () => {
  assert.equal(n("/event_groups?page=2&q=x"), "/event_groups");
});
test("rails (.:format) suffix is stripped", () => {
  assert.equal(n("/api/v1/trade/:id(.:format)"), "/api/v1/trade/*");
});
test("version prefixes are NEVER stripped — /v1/trade/home and /trade/home both exist", () => {
  assert.notEqual(n("/v1/trade/home"), n("/trade/home"));
});
test("no case or plural normalisation", () => {
  assert.notEqual(n("/Vendors"), n("/vendors"));
  assert.notEqual(n("/vendor"), n("/vendors"));
});
test("absolute URLs reduce to their path", () => {
  assert.equal(n("https://api.procol.in/api/x"), "/api/x");
});
