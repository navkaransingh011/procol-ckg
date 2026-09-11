// The platform database must never be written to. This guards the ONLY code path that talks to it.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.LIVE_DATABASE_URL ||= "postgresql://x:y@localhost:1/z";   // module needs a URL to load; no connection is opened by import
const { assertSelectOnly } = await import("../src/sync-live.mjs");

test("only SELECT / WITH statements may be sent to the platform database", () => {
  assert.equal(assertSelectOnly("select 1"), "select 1");
  assert.equal(assertSelectOnly("  WITH x as (select 1) select * from x"), "  WITH x as (select 1) select * from x");
  for (const bad of ["update t set a=1", "insert into t values (1)", "delete from t", "create table t(x int)", "drop table t", "truncate t",
                     "select 1; delete from t", "/* c */ update t set a=1", "-- c\nupdate t set a=1", "copy t to stdout", "alter table t add x int"])
    assert.throws(() => assertSelectOnly(bad), /refused/, bad);
});
