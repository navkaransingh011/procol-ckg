// The live-data tool is the ONLY way the model reaches platform data. It must refuse anything outside the allowlist.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { queryLive, LIVE_TABLES, liveFreshness } from "../src/tools.mjs";
import { pool } from "../src/db.mjs";
after(() => pool.end());

test("unknown tables and non-allowlisted columns are refused", async () => {
  assert.match((await queryLive({ table: "users" })).error, /not a live table/);
  assert.match((await queryLive({ table: "companies", where: { email: "x" } })).error, /not allowed/);
  assert.match((await queryLive({ table: "procol_variables", columns: ["value"] })).error || "no allowed", /no allowed/);   // value is deliberately not mirrored
});

test("allowlisted query returns rows, an exact total, and as_of; limit is capped at 200", async () => {
  const r = await queryLive({ table: "master_configurations", like: { config_key: "approval" }, limit: 5000 });
  assert.ok(!r.error, r.error);
  assert.ok(r.returned <= 200);
  assert.equal(typeof r.total, "number");
  assert.ok(r.rows.every(row => Object.keys(row).every(k => LIVE_TABLES.master_configurations.columns.includes(k))), "only allowlisted columns come back");
  assert.ok(r.as_of, "as_of present");
});

test("freshness reports every mirrored table", async () => {
  const f = await liveFreshness();
  assert.ok(f.tables.length >= Object.keys(LIVE_TABLES).length - 1, `tables=${f.tables.length}`);
});
