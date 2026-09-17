// Per-company configuration, resolved exactly the way the platform resolves it (CustomConfiguration.cached_all_configs):
//   effective = master default  <-  that company's own master row (if any)  <-  the company's ACTIVE custom override (if any)
// Company type = 1 in master_configurations; an override row is item_type 'Company', item_id = company, company_id = company,
// status 1, value in modifications.value. Everything is read from the read-only mirror; nothing here can change a switch.
import { readFileSync } from "node:fs";
import { q } from "../db.mjs";

const TENANTS = JSON.parse(readFileSync(new URL("../../config/tenants.json", import.meta.url), "utf8"));
const STOP = new Set(["procol", "uat", "prod", "po", "pr", "rfq", "rfi", "nfa", "event", "events", "template", "templates", "vendor", "vendors", "buyer", "supplier", "the", "and", "for", "with", "which", "what", "how", "when", "does", "this", "that", "are", "is", "on", "off", "default", "config", "configs", "configuration", "configurations", "master", "custom", "company", "companies", "client", "customer", "user", "users", "team", "teams", "approval", "approvals", "workflow", "purchase", "order", "orders", "request", "requests", "auction", "auctions", "material", "materials", "service", "services", "show", "list", "all", "any", "tell", "explain", "describe", "give", "walk", "please", "help", "find", "check", "compare", "summarize", "summarise", "reliance industries jio"]);

/** Companies a name refers to. Tenant words expand to their patterns; otherwise a substring match on the platform name. */
export async function resolveCompanies({ name, active_only = true, limit = 12 }) {
  const raw = String(name || "").trim().replace(/[^\w &.\-']/g, " ").replace(/\s+/g, " ").trim();
  if (raw.length < 3) return [];
  const key = raw.toLowerCase();
  const find = async (patterns) => q(`select id, name, status, (select count(*) from live.custom_configurations cc where cc.item_type = 'Company' and cc.item_id = c.id and cc.status = 1)::int as overrides
                                        from live.companies c
                                       where (${patterns.map((_, i) => `c.name ilike $${i + 1}`).join(" or ")}) ${active_only ? "and c.status = 1" : ""}
                                       order by overrides desc, c.id limit $${patterns.length + 1}`, [...patterns, limit]);
  // the name as written first ("Reliance Retail" -> the retail companies); the tenant word's patterns only when nothing matches
  let rows = TENANTS[key] ? await find(TENANTS[key]) : await find([`%${raw}%`]);
  if (!rows.length) { const tenant = Object.entries(TENANTS).find(([k]) => key.startsWith(k + " ") || key.endsWith(" " + k) || key.includes(" " + k + " ")); if (tenant) rows = await find(tenant[1]); }
  return rows.map(r => ({ id: Number(r.id), name: r.name, active: r.status === 1, overrides: r.overrides }));
}

/** Capitalised names in a question that resolve to a company (for "…for Reliance?" without a tenant word). */
export async function companyMentions(question) {
  const found = new Map();
  const words = String(question || "").match(/\b[A-Z][A-Za-z&.'-]{2,}(?:\s+[A-Z][A-Za-z&.'-]{2,}){0,3}\b/g) || [];
  const lower = [...new Set(words.map(w => w.trim()))].filter(w => !STOP.has(w.toLowerCase()) && !STOP.has(w.split(" ")[0].toLowerCase()));
  for (const w of lower.slice(0, 5)) {
    // a capitalised word must START a word in the company name: "Tell" must not hit "Supply Chain INTELLigence"
    const startsWord = new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const cs = (await resolveCompanies({ name: w, limit: 6 })).filter(c => startsWord.test(c.name || ""));
    if (cs.length && cs.length <= 6) for (const c of cs) found.set(c.id, { ...c, mention: w });
  }
  // tenant words in lower case too ("reliance", "jindal")
  for (const k of Object.keys(TENANTS)) if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question)) for (const c of await resolveCompanies({ name: k, limit: 8 })) found.set(c.id, { ...c, mention: k });
  return [...found.values()];
}

/** The effective switches of one company, with where each value comes from. */
export async function effectiveConfigs({ company_id, keys_like = null, keys = null, only = null }) {
  const rows = await q(
    `with m as (select config_key, name, description, defaults->'value' as dflt, company_id, input_type
                  from live.master_configurations
                 where item_type = 1 and status = 1 and (company_id is null or company_id = $1)),
          m1 as (select distinct on (config_key) * from m order by config_key, company_id nulls last),   -- the company's own master row wins over the global one
          c as (select config_key, modifications->'value' as val, updated_at
                  from live.custom_configurations
                 where item_type = 'Company' and item_id = $1 and company_id = $1 and status = 1)
     select m1.config_key, m1.name, m1.description, coalesce(c.val, m1.dflt) as effective, m1.dflt as default_value,
            case when c.val is not null then 'override' when m1.company_id is not null then 'company master' else 'default' end as source,
            c.updated_at as overridden_at
       from m1 left join c using (config_key)
      where ($2::text is null or m1.config_key ilike '%' || $2 || '%' or m1.name ilike '%' || $2 || '%' or m1.description ilike '%' || $2 || '%')
        and ($3::text[] is null or m1.config_key = any($3::text[]))
      order by m1.config_key`, [company_id, keys_like, keys]);
  const isOn = (v) => v === true || v === "true";
  const isOff = (v) => v === false || v === "false";
  return rows.filter(r => !only || (only === "on" ? isOn(r.effective) : only === "off" ? isOff(r.effective) : only === "overrides" ? r.source === "override" : true));
}

/**
 * "What is on for Reliance": resolve the customer, compute each company's effective table, then report what agrees
 * across the matched companies and what differs, always with company ids (names repeat in the platform).
 */
export async function configFor({ company = null, company_ids = null, keys_like = null, keys = null, only = null, max_companies = 6 }) {
  let companies = Array.isArray(company_ids) && company_ids.length
    ? (await q(`select id, name, status from live.companies where id = any($1::int[])`, [company_ids.map(Number)])).map(r => ({ id: Number(r.id), name: r.name, active: r.status === 1 }))
    : await resolveCompanies({ name: company, limit: 40 });
  if (!companies.length) return { error: `no company matches "${company || company_ids}" in the platform mirror` };
  const total_matches = companies.length;
  companies = companies.slice(0, max_companies);
  const per = [];
  for (const c of companies) per.push({ company: c, rows: await effectiveConfigs({ company_id: c.id, keys_like, keys, only }) });
  const byKey = new Map();
  for (const p of per) for (const r of p.rows) { if (!byKey.has(r.config_key)) byKey.set(r.config_key, { config_key: r.config_key, name: r.name, description: r.description, default_value: r.default_value, per_company: [] }); byKey.get(r.config_key).per_company.push({ company_id: p.company.id, company: p.company.name, effective: r.effective, source: r.source, overridden_at: r.overridden_at }); }
  const agree = [], differ = [];
  for (const k of byKey.values()) {
    const vals = new Set(k.per_company.map(x => JSON.stringify(x.effective)));
    const present = k.per_company.length === companies.length;
    if (vals.size === 1 && present) agree.push({ config_key: k.config_key, name: k.name, effective: k.per_company[0].effective, default_value: k.default_value, sources: [...new Set(k.per_company.map(x => x.source))].join("/"), description: k.description });
    else differ.push(k);
  }
  const [st] = await q(`select last_run from live.sync_state where table_name = 'custom_configurations'`).catch(() => [{}]);
  return { companies, total_matches, as_of: st?.last_run ?? null, filters: { keys_like, keys, only }, agree, differ,
           note: "effective = master default, replaced by the company's own master row, replaced by its active override; the platform resolves it the same way (CustomConfiguration.cached_all_configs)" };
}

/** Which companies have a switch at a value, with the same precedence. A true default means everyone without an override saying otherwise. */
export async function companiesWith({ config_key, value = true, limit = 60 }) {
  const rows = await q(
    `with g as (select defaults->'value' as dflt, name from live.master_configurations where config_key = $1 and item_type = 1 and status = 1 and company_id is null order by id limit 1),
          cm as (select company_id, defaults->'value' as val from live.master_configurations where config_key = $1 and item_type = 1 and status = 1 and company_id is not null),
          ov as (select item_id as company_id, modifications->'value' as val from live.custom_configurations where config_key = $1 and item_type = 'Company' and status = 1 and company_id = item_id),
          eff as (select c.id, c.name, coalesce(ov.val, cm.val, g.dflt) as effective, case when ov.val is not null then 'override' when cm.val is not null then 'company master' else 'default' end as source
                    from live.companies c cross join g left join cm on cm.company_id = c.id left join ov on ov.company_id = c.id where c.status = 1)
     select (select dflt from g) as default_value, (select name from g) as name,
            count(*) filter (where effective::text = $2::jsonb::text) as matching, count(*) as active_companies,
            (select json_agg(json_build_object('id', id, 'name', name, 'source', source) order by (source = 'default'), name) from (select * from eff where effective::text = $2::jsonb::text limit $3) s) as sample
       from eff`, [config_key, JSON.stringify(value), limit]);
  const r = rows[0] || {};
  return { config_key, name: r.name, value, default_value: r.default_value, matching: Number(r.matching || 0), active_companies: Number(r.active_companies || 0),
           sample: r.sample || [], note: Number(r.matching || 0) > limit ? `showing ${limit} of ${r.matching}` : null };
}
