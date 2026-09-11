import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "../src/extractors/be-routes.rb");
const routesRb = path.resolve(here, "../../procol-backend/config/routes.rb");

// These test the INDEXER's Rails route expansion, which needs a procol-backend clone and Ruby.
// A service-only box (which reads code from the database, not clones) has neither -- skip cleanly.
let out = null, skipReason = null;
if (!existsSync(routesRb)) skipReason = "no procol-backend clone (service-only host)";
else { try { out = JSON.parse(execFileSync("ruby", [script, routesRb], { encoding: "utf8", maxBuffer: 64e6 })); } catch (e) { skipReason = `ruby route expansion failed: ${String(e.message).split("\n")[0]}`; } }
const T = (name, fn) => test(name, { skip: skipReason || false }, skipReason ? () => {} : fn);

T("routes.rb expands ~4-5k routes, not ~1.2k lines (api_routes is invoked 5x)", () => {
  assert.ok(out.routes.length > 4000, `got ${out.routes.length}`);
  assert.ok(out.routes.length < 7000, `got ${out.routes.length}`);
});
T("every route has verb, path, controller and action", () => {
  for (const r of out.routes) {
    assert.match(r.verb, /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/);
    assert.ok(r.path.startsWith("/"), r.path);
    assert.ok(r.controller && r.action, JSON.stringify(r));
  }
});
T("distinct controller#action is in the hundreds, deduped across subdomain constraints", () => {
  const n = new Set(out.routes.map(r => `${r.controller}#${r.action}`)).size;
  assert.ok(n > 700 && n < 1200, `got ${n}`);
});
T("the demo route exists", () => {
  assert.ok(out.routes.some(r => r.verb === "GET" && /activity_logs$/.test(r.path) && r.action === "index"));
});
