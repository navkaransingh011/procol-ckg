// Per-company configuration follows the platform's own precedence: default <- company master <- active override.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveCompanies, effectiveConfigs, configFor, companiesWith, companyMentions } from "../src/service/configs.mjs";
import { pool, q } from "../src/db.mjs";
after(() => pool.end());

test("an active override wins over the default and is labelled as such", async () => {
  const [ov] = await q(`select item_id, config_key, modifications->'value' v from live.custom_configurations where item_type='Company' and status=1 and company_id=item_id
                         and config_key in (select config_key from live.master_configurations where item_type=1 and status=1 and company_id is null) limit 1`);
  const rows = await effectiveConfigs({ company_id: Number(ov.item_id), keys: [ov.config_key] });
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows[0].effective), JSON.stringify(ov.v));
  assert.equal(rows[0].source, "override");
  const plain = await effectiveConfigs({ company_id: Number(ov.item_id) });
  assert.ok(plain.length > 400, "every global company-type switch has an effective value");
  assert.ok(plain.some(r => r.source === "default"));
});

test("a tenant word resolves to its companies; the report separates agreement from differences", async () => {
  const cs = await resolveCompanies({ name: "reliance", limit: 5 });
  assert.ok(cs.length >= 2 && cs.every(c => /reliance/i.test(c.name)));
  const r = await configFor({ company: "Reliance", keys_like: "approval", max_companies: 3 });
  assert.equal(r.companies.length, 3);
  assert.ok(r.agree.length + r.differ.length > 0);
  for (const d of r.differ) assert.ok(d.per_company.every(x => typeof x.company_id === "number"), "differences always carry company ids");
  const m = await companyMentions("Which approval configs are switched off for Reliance Retail on UAT?");
  assert.ok(m.some(c => /reliance/i.test(c.name)));
});

test("companiesWith applies the default to everyone without an override", async () => {
  const [k] = await q(`select config_key from live.master_configurations where item_type=1 and status=1 and company_id is null and defaults->>'value' in ('true','false') order by config_key limit 1`);
  const on = await companiesWith({ config_key: k.config_key, value: true });
  const off = await companiesWith({ config_key: k.config_key, value: false });
  assert.equal(on.matching + off.matching <= on.active_companies, true);
  assert.ok(on.active_companies > 1000);
});
