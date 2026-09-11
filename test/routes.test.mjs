import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "../src/extractors/be-routes.rb");
const routesRb = path.resolve(here, "../../procol-backend/config/routes.rb");
const out = JSON.parse(execFileSync("ruby", [script, routesRb], { encoding: "utf8", maxBuffer: 64e6 }));

test("routes.rb expands ~4-5k routes, not ~1.2k lines (api_routes is invoked 5x)", () => {
  assert.ok(out.routes.length > 4000, `got ${out.routes.length}`);
  assert.ok(out.routes.length < 7000, `got ${out.routes.length}`);
});
test("every route has verb, path, controller and action", () => {
  for (const r of out.routes) {
    assert.match(r.verb, /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/);
    assert.ok(r.path.startsWith("/"), r.path);
    assert.ok(r.controller && r.action, JSON.stringify(r));
  }
});
test("distinct controller#action is in the hundreds, deduped across subdomain constraints", () => {
  const n = new Set(out.routes.map(r => `${r.controller}#${r.action}`)).size;
  assert.ok(n > 700 && n < 1200, `got ${n}`);
});
test("the demo route exists", () => {
  assert.ok(out.routes.some(r => r.verb === "GET" && /activity_logs$/.test(r.path) && r.action === "index"));
});
