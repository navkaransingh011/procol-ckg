// The query layer. Plain functions -- deliberately transport-agnostic, so the MCP
// server and the dashboard's HTTP endpoint call the SAME code and can never drift.
//
// These are typed tools rather than raw SQL handed to a model, for three reasons:
//   1. traversal cost is unbounded -- one recursive CTE from a hub returns most of
//      the graph and blows the context window;
//   2. a hand-written join forgets `confidence >= x` and states a guess as fact;
//   3. the model selects only the columns it thinks it needs, detaching provenance
//      so nobody can check the answer.
import { q, hex } from "./db.mjs";
import path from "node:path";

// Traversing all 17 edge kinds from a component reaches half the codebase through
// IMPORTS. Narrative traversal uses only the kinds that describe execution.
export const NARRATIVE_EDGES = [
  "DISPATCHES", "INVOKES", "ISSUES_HTTP", "TARGETS", "SERVES",
  "HANDLED_BY", "USES_SERVICE", "READS", "WRITES", "ENQUEUES",
  "DECLARES", "CALLS",   // HANDLER -> its Ruby method -> runtime-verified callees
  "TRIGGERS_DEFECT",     // a known, execution-confirmed bug on this path
];

// Execution direction is NOT the same as edge direction.
//
// Both sides of the wire point INWARD at the shared contract node:
//     call_site --TARGETS--> [endpoint] <--SERVES-- server_route
//
// So walking downstream from the frontend follows TARGETS with the arrow and
// SERVES against it. Without this, every cross-repo trace dead-ends at the
// endpoint -- which looks like missing data and is really a modelling error.
const OPPOSE_DOWNSTREAM = new Set(["SERVES"]);

function orient(edgeKinds, direction) {
  const reverse = direction === "reverse";
  const follow = [], oppose = [];
  for (const k of edgeKinds) {
    const opposes = OPPOSE_DOWNSTREAM.has(k);
    ((opposes !== reverse) ? oppose : follow).push(k);
  }
  return { follow, oppose };
}

const CONFIDENCE = { any: 0, low: 0.4, medium: 0.7, high: 0.9 };
const HUB_IN_DEGREE = 100;

/**
 * Resolve ref names to the commit SHAs a traversal may read.
 * One SHA per repo -- a cross-repo hop crosses two commits (the frontend asserts
 * TARGETS at its commit, the backend asserts SERVES at its own), so a single-commit
 * filter would silently cut the graph in half at the endpoint node.
 */
export async function resolveScope(refNames = ["main"]) {
  const rows = await q(
    `select distinct on (r.repo_id, r.ref_name)
            r.repo_id, r.ref_name, encode(r.commit_sha,'hex') as sha,
            rp.name as repo
       from ckg.ref_history r join ckg.repos rp on rp.id = r.repo_id
      where r.ref_name = any($1::text[])
      order by r.repo_id, r.ref_name, r.last_seen desc`,
    [refNames],
  );
  return { commits: rows.map((r) => r.sha), refs: rows };
}

/** find_entity -- exact fqn first, then trigram on name, then path. */
export async function findEntity({ query, kind = null, repo = null, limit = 20, refs = null }) {
  // Scope to the commits those refs point at, so "bids on main" anchors on main's row --
  // not an older commit's row that happens to share the name. Contract nodes (null commit) always pass.
  const commits = refs ? (await resolveScope(refs)).commits : null;
  const rows = await q(
    `with exact as (
       select e.*, 'exact_fqn' as match_reason, 1.0::float as score
         from ckg.entities e
        where e.fqn = $1
          and ($2::text is null or e.kind::text = $2)
     ), byname as (
       select e.*, 'name_trigram' as match_reason, similarity(e.name, $1) as score
         from ckg.entities e
        where e.name is not null and e.name % $1
          and ($2::text is null or e.kind::text = $2)
     ), bypath as (
       -- a path-shaped query ("src/x/api.js", "foo.rb") means the file itself: score it above
       -- any fuzzy name hit, otherwise a handler with similar trigrams steals the anchor.
       select e.*, 'path_substring' as match_reason,
              (case when $1 ~ '[/.]' then 0.9 else 0.3 end)::float as score
         from ckg.entities e
        where e.path ilike '%' || $1 || '%'
          and ($2::text is null or e.kind::text = $2)
     )
     select id, kind::text, fqn, name, path, start_line, end_line, attrs,
            encode(commit_sha,'hex') as commit_sha, confidence,
            resolution::text, extractor, match_reason, score
       from (select * from exact union all select * from byname union all select * from bypath) u
      where ($3::text is null or exists (
              select 1 from ckg.repos rp where rp.id = u.repo_id and rp.name = $3))
        and ($5::text[] is null or u.commit_sha is null or encode(u.commit_sha,'hex') = any($5::text[]))
      order by score desc, kind, fqn
      limit $4`,
    [query, kind, repo, limit, commits],
  );
  return {
    matches: rows,
    // The agent needs to know HOW WEAK the match was. A path_substring hit on a
    // one-word query is a guess, and the answer should say so.
    weak: rows.length > 0 && rows[0].match_reason !== "exact_fqn",
    count: rows.length,
  };
}

/**
 * trace_from -- bounded reachability with the three non-negotiable guards:
 * commit scope, edge-kind allowlist, depth cap + array cycle break. Plus hub
 * suppression, without which every answer ends "...and then the XHR wrapper,
 * which everything calls" -- true and useless.
 */
export async function traceFrom({
  entity_id,
  direction = "forward",
  depth = 6,
  edge_kinds = NARRATIVE_EDGES,
  min_confidence = "medium",
  refs = ["main"],
  max_nodes = 200,
  expand_hubs = false,
}) {
  const d = Math.min(Math.max(1, depth), 6);
  const floor = CONFIDENCE[min_confidence] ?? CONFIDENCE.medium;
  const { commits } = await resolveScope(refs);
  if (!commits.length) return { error: `no indexed commit for refs ${refs.join(", ")}` };

  const { follow, oppose } = orient(edge_kinds, direction);

  const rows = await q(
    `with hubs as (
       select dst_entity_id as id from ckg.edges
        group by 1 having count(*) > ${HUB_IN_DEGREE}
     ), hops as (
       -- normalise every usable edge into a directed hop, so the recursion below
       -- is direction-agnostic and the SERVES flip is handled once, here.
       select g.id as edge_id, g.kind::text as kind, g.confidence, g.guard_expr, g.start_line,
              encode(g.commit_sha,'hex') as commit_sha, g.resolution::text as resolution,
              g.attrs->>'observed_at' as observed_at,
              case when g.kind::text = any($2::text[]) then g.src_entity_id else g.dst_entity_id end as from_id,
              case when g.kind::text = any($2::text[]) then g.dst_entity_id else g.src_entity_id end as to_id
         from ckg.edges g
        where g.kind::text = any($2::text[] || $3::text[])
          and g.confidence >= $4
          and encode(g.commit_sha,'hex') = any($5::text[])
     ), walk as (
       select * from (
         with recursive w as (
           select h.edge_id, h.kind, h.confidence, h.guard_expr, h.start_line, h.commit_sha, h.resolution, h.observed_at,
                  h.from_id as src, h.to_id as dst, 1 as depth,
                  array[h.from_id, h.to_id] as path
             from hops h where h.from_id = $1
           union all
           select h.edge_id, h.kind, h.confidence, h.guard_expr, h.start_line, h.commit_sha, h.resolution, h.observed_at,
                  h.from_id, h.to_id, w.depth + 1, w.path || h.to_id
             from w join hops h on h.from_id = w.dst
            where w.depth < $6
              and not (h.to_id = any(w.path))                       -- cycle break
              and ($7::boolean or not exists (select 1 from hubs x where x.id = w.dst))
         ) select * from w
       ) z
     )
     select w.*, e.kind::text as dst_kind, e.fqn as dst_fqn, e.name as dst_name,
            e.path as dst_path, e.start_line as dst_line, e.attrs as dst_attrs,
            e.resolution::text as dst_resolution,
            exists (select 1 from hubs x where x.id = w.dst) as dst_is_hub
       from walk w join ckg.entities e on e.id = w.dst
      order by w.depth, w.kind
      limit $8`,
    [entity_id, follow, oppose, floor, commits, d, expand_hubs, max_nodes + 1],
  );

  const truncated = rows.length > max_nodes;
  const kept = truncated ? rows.slice(0, max_nodes) : rows;

  return {
    root: entity_id,
    direction,
    depth: d,
    scope: { refs, commits },
    min_confidence,
    // One node per id: the same handler is reachable via several route paths
    // (api_routes is invoked 5x under different scopes), and reporting it five
    // times reads as broken data rather than as one action with five routes.
    nodes: [...new Map(kept.map((r) => [String(r.dst), {
      id: r.dst, kind: r.dst_kind, fqn: r.dst_fqn, name: r.dst_name,
      path: r.dst_path, line: r.dst_line, depth: r.depth,
      resolution: r.dst_resolution, is_hub: r.dst_is_hub, attrs: r.dst_attrs,
    }])).values()],
    edges: kept.map((r) => ({
      id: r.edge_id, kind: r.kind, src: r.src, dst: r.dst,
      confidence: Number(r.confidence), guard: r.guard_expr, resolution: r.resolution,
      line: r.start_line, commit: r.commit_sha,
      ...(r.observed_at ? { observed_at: r.observed_at } : {}),   // RUNTIME evidence carried from an earlier commit
    })),
    // Three states the caller MUST be able to distinguish, because collapsing
    // them is the core dishonesty risk.
    truncated,
    hubs_not_expanded: [...new Set(kept.filter((r) => r.dst_is_hub).map((r) => r.dst_fqn))],
    unresolved: kept.filter((r) => r.dst_resolution === "AMBIGUOUS")
      .map((r) => ({ id: r.dst, fqn: r.dst_fqn, path: r.dst_path, line: r.dst_line,
                     reason: "path built at runtime; not statically resolvable" })),
  };
}

/** get_evidence -- separate call so traces stay cheap and citations stay checkable. */
export async function getEvidence({ ids = [] }) {
  if (!ids.length) return { evidence: [] };
  const rows = await q(
    `select e.id, e.kind::text, e.fqn, e.path, e.start_line, e.end_line,
            encode(e.blob_sha,'hex') as blob_sha, encode(e.commit_sha,'hex') as commit_sha,
            e.extractor, e.confidence, e.resolution::text, rp.name as repo,
            (select string_agg(distinct r.ref_name, ', ')
               from ckg.ref_history r
              where r.repo_id = e.repo_id and r.commit_sha = e.commit_sha) as refs
       from ckg.entities e left join ckg.repos rp on rp.id = e.repo_id
      where e.id = any($1::bigint[])`,
    [ids],
  );
  return { evidence: rows, missing: ids.filter((i) => !rows.some((r) => String(r.id) === String(i))) };
}

/** Free report the shared-endpoint design makes possible. */
export async function endpointCoverage({ refs = ["main"] } = {}) {
  const { commits } = await resolveScope(refs);
  const rows = await q(
    `with ep as (
       select e.id, e.fqn,
              count(*) filter (where g.kind='TARGETS' and encode(g.commit_sha,'hex') = any($1::text[])) as fe,
              count(*) filter (where g.kind='SERVES'  and encode(g.commit_sha,'hex') = any($1::text[])) as be
         from ckg.entities e join ckg.edges g on g.dst_entity_id = e.id
        where e.kind='HTTP_ENDPOINT' group by 1,2)
     select count(*) filter (where fe>0 and be>0) as joined,
            count(*) filter (where fe>0 and be=0) as called_but_not_served,
            count(*) filter (where fe=0 and be>0) as served_but_not_called
       from ep`,
    [commits],
  );
  return { scope: refs, ...rows[0] };
}


/**
 * listEntities -- the SET operation the agent was missing. findEntity answers
 * "which node is this?"; this answers "give me EVERY node matching a shape".
 * Without it, "name all 39 external services" retrieved one, because point
 * lookup plus edge-walking cannot express a set.
 */
export async function listEntities({ kind = null, subkind = null, path_prefix = null, name_prefix = null,
                                     name_contains = null, refs = ["main"], repo = null,
                                     order_by = "name", limit = 200 }) {
  const commits = refs ? (await resolveScope(refs)).commits : null;
  const order = { name: "e.name",
                  activity: "coalesce((e.attrs->'activity'->>'file_touches_12mo')::int, (e.attrs->'activity'->>'commits_12mo')::int) desc nulls last, e.name",
                  path: "e.path, e.start_line" }[order_by] ?? "e.name";
  const rows = await q(
    `select e.id, e.kind::text, e.fqn, e.name, e.path, e.start_line, e.end_line,
            e.attrs, e.resolution::text, e.confidence, rp.name as repo,
            encode(e.commit_sha,'hex') as commit_sha
       from ckg.entities e left join ckg.repos rp on rp.id = e.repo_id
      where ($1::text is null or e.kind::text = $1)
        and ($2::text is null or e.path like $2 || '%')
        and ($3::text is null or e.name ilike $3 || '%')
        and ($4::text is null or e.name ilike '%' || $4 || '%')
        and ($5::text is null or rp.name = $5)
        and ($6::text[] is null or e.commit_sha is null or encode(e.commit_sha,'hex') = any($6::text[]))
        and ($8::text is null or coalesce(e.attrs->>'subkind','') = $8)
      order by ${order}
      limit $7`,
    [kind, path_prefix, name_prefix, name_contains, repo, commits, Math.min(limit, 500), subkind]);
  const [{ n }] = await q(
    `select count(*)::int n from ckg.entities e left join ckg.repos rp on rp.id = e.repo_id
      where ($1::text is null or e.kind::text = $1)
        and ($2::text is null or e.path like $2 || '%')
        and ($3::text is null or e.name ilike $3 || '%')
        and ($4::text is null or e.name ilike '%' || $4 || '%')
        and ($5::text is null or rp.name = $5)
        and ($6::text[] is null or e.commit_sha is null or encode(e.commit_sha,'hex') = any($6::text[]))
        and ($7::text is null or coalesce(e.attrs->>'subkind','') = $7)`,
    [kind, path_prefix, name_prefix, name_contains, repo, commits, subkind]);
  // Breakdown by subkind: EXTERNAL_SERVICE mixes runtime integrations with CI actions, and an
  // answer that says "all 55 external services" without that distinction is misleading.
  const bySubkind = rows.reduce((a, r) => { const k = r.attrs?.subkind ?? "(none)"; a[k] = (a[k] || 0) + 1; return a; }, {});
  return { total: n, returned: rows.length, complete: rows.length >= n, by_subkind: bySubkind, items: rows };
}

/** Who touches this code, from git history. Answers "who do I ask?". */
export async function ownersOf({ entity_ids = [], path_prefix = null, refs = ["main"], limit = 10 }) {
  const commits = (await resolveScope(refs)).commits;
  return q(
    `select p.name, p.attrs->>'email' as email, sum((g.attrs->>'commits_touching')::int) as commits,
            max(g.attrs->>'last_commit') as last_commit, count(distinct g.dst_entity_id) as nodes
       from ckg.edges g
       join ckg.entities p on p.id = g.src_entity_id and p.kind = 'PERSON'
       join ckg.entities t on t.id = g.dst_entity_id
      where g.kind = 'OWNS'
        and encode(g.commit_sha,'hex') = any($1::text[])
        and (($2::bigint[] = '{}' or t.id = any($2::bigint[])) and ($3::text is null or t.path like $3 || '%'))
      group by 1,2 order by 3 desc limit $4`,
    [commits, entity_ids, path_prefix, limit]);
}

/** Cached prose at a given altitude -- the cheap path to a big-picture answer. */
export async function getSummaries({ altitude = null, subject_key = null, audience = "all", refs = ["main"], limit = 40 }) {
  const commits = (await resolveScope(refs)).commits;
  return q(
    `select s.altitude, s.subject_key, s.audience, s.headline, s.body, s.entity_count,
            s.generated_by, s.evidence_ids, s.generated_at
       from ckg.summaries s
      where encode(s.commit_sha,'hex') = any($1::text[])
        and ($2::text is null or s.altitude = $2)
        and ($3::text is null or s.subject_key = $3)
        and s.audience in ($4, 'all')
      order by case s.altitude when 'system' then 0 when 'feature' then 1 when 'module' then 2 else 3 end, s.headline
      limit $5`,
    [commits, altitude, subject_key, audience, limit]);
}


// ---------------------------------------------------------------------------------
// endpointFamily -- a RELATIONSHIP list. "Every frontend call site whose target endpoint
// starts with /approval_workflow/approval_requests, and what serves each." listEntities
// filters entity fields; this walks TARGETS/SERVES/HANDLED_BY for a whole path family.
// ---------------------------------------------------------------------------------
export async function endpointFamily({ path_prefix, method = null, refs = ["main"], limit = 60 }) {
  if (!path_prefix) return { error: "path_prefix required" };
  const { commits } = await resolveScope(refs);
  const norm = path_prefix.replace(/\/+$/, "");
  const rows = await q(
    `with ep as (
       select e.id, e.fqn, e.name, e.attrs->>'method' as method
         from ckg.entities e
        where e.kind='HTTP_ENDPOINT' and (e.name = $1 or e.name like $1 || '/%')
          and ($2::text is null or e.attrs->>'method' = $2)
     )
     select ep.fqn as endpoint, ep.method, ep.name as path,
            coalesce((select json_agg(json_build_object('path', cs.path, 'line', cs.start_line, 'raw', cs.attrs->>'raw', 'repo', rp.name))
                        from ckg.edges t join ckg.entities cs on cs.id=t.src_entity_id join ckg.repos rp on rp.id=cs.repo_id
                       where t.dst_entity_id=ep.id and t.kind='TARGETS' and encode(t.commit_sha,'hex') = any($3::text[])), '[]') as callers,
            coalesce((select json_agg(distinct jsonb_build_object('route', sr.name, 'handler', h.name, 'handler_path', h.path))
                        from ckg.edges sv join ckg.entities sr on sr.id=sv.src_entity_id
                        left join ckg.edges hb on hb.src_entity_id=sr.id and hb.kind='HANDLED_BY'
                        left join ckg.entities h on h.id=hb.dst_entity_id
                       where sv.dst_entity_id=ep.id and sv.kind='SERVES' and encode(sv.commit_sha,'hex') = any($3::text[])), '[]') as served_by
       from ep order by ep.name, ep.method limit $4`,
    [norm, method, commits, limit]);
  const fam = rows.map(r => ({ ...r, callers: r.callers, served_by: r.served_by,
                               status: r.callers.length && r.served_by.length ? "joined" : r.callers.length ? "called_not_served" : "served_not_called" }));
  // Unresolved call sites that mention this path family in their raw source. They are NOT linked
  // (URL built at runtime), so "served_not_called" may be false for them -- say so.
  const possibly = await q(
    `select cs.path, cs.start_line as line, cs.attrs->>'raw' as raw, rp.name as repo
       from ckg.entities cs join ckg.repos rp on rp.id = cs.repo_id
      where cs.kind='HTTP_CALL_SITE' and cs.resolution='AMBIGUOUS'
        and encode(cs.commit_sha,'hex') = any($1::text[])
        and (cs.attrs->>'raw') ilike '%' || $2 || '%'
      order by cs.path, cs.start_line limit 30`, [commits, norm.split("/").filter(Boolean).slice(-1)[0] || norm]);
  const files = new Set(fam.flatMap(f => f.callers.map(c => c.path)));
  const siblings = await q(
    `select cs.path, cs.start_line as line, left(cs.attrs->>'raw', 120) as raw, rp.name as repo
       from ckg.entities cs join ckg.repos rp on rp.id = cs.repo_id
      where cs.kind='HTTP_CALL_SITE' and cs.resolution='AMBIGUOUS'
        and encode(cs.commit_sha,'hex') = any($1::text[]) and cs.path = any($2::text[])
      order by cs.path, cs.start_line limit 30`, [commits, [...files]]);
  const seenK = new Set(); const unresolved = [];
  for (const u of [...possibly, ...siblings]) { const k = `${u.path}:${u.line}`; if (!seenK.has(k)) { seenK.add(k); unresolved.push(u); } }
  return { prefix: norm, refs, endpoints: fam.length, call_sites: fam.reduce((a, f) => a + f.callers.length, 0),
           joined: fam.filter(f => f.status === "joined").length, family: fam,
           unresolved_possible_callers: unresolved,
           note: unresolved.length ? `${unresolved.length} call site(s) build their URL at runtime and could not be linked; "served_not_called" may be wrong for them.` : undefined };
}

// ---------------------------------------------------------------------------------
// Source on demand. The graph is structure; git is the code. Read the exact lines at the
// INDEXED commit, never from a working tree, never a path the graph does not know about,
// never a secret. Bounded so a model can't ask for the repo.
// ---------------------------------------------------------------------------------
const SECRET_PATHS = /(^|\/)(\.env|\.env\..*|.*\.pem|id_rsa.*|.*\.key|.*\.p12|.*\.jks)$/;
const MAX_LINES = 120;

async function commitFor(repo, refs) {
  const { refs: rows } = await resolveScope(refs);
  return rows.find(r => r.repo === repo)?.sha ?? null;
}

/** File text at the indexed commit, from the database. No clone, no git. */
async function fileText(repo, p, sha) {
  const rows = await q(
    `select bt.text from ckg.commit_files cf
       join ckg.repos rp on rp.id = cf.repo_id
       join ckg.blob_text bt on bt.blob_sha = cf.blob_sha
      where rp.name = $1 and cf.path = $2 and cf.commit_sha = decode($3,'hex') limit 1`, [repo, p, sha]);
  return rows[0]?.text ?? null;
}

export async function readSource({ repo, path: p, start_line = 1, end_line = null, refs = ["main"], context = 0 }) {
  if (!repo || !p) return { error: "repo and path required" };
  if (SECRET_PATHS.test(p)) return { error: "refused: secret path" };
  const sha = await commitFor(repo, refs);
  if (!sha) return { error: `no indexed commit for ${repo}@${refs}` };
  const text = await fileText(repo, p, sha);
  if (text === null) return { error: `${p} is not a source file the graph holds at ${sha.slice(0, 8)}` };
  const lines = text.split("\n");
  const from = Math.max(1, (start_line || 1) - context);
  const to = Math.min(lines.length, (end_line || Math.min(lines.length, from + 59)) + context, from + MAX_LINES - 1);
  return { repo, path: p, commit: sha.slice(0, 10), from, to, total_lines: lines.length,
           truncated: (end_line || lines.length) > to,
           lines: lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`) };
}

// Bounded, commit-pinned, fixed-string search over the stored source. Answers "where else does
// this appear?" -- e.g. every `return if self.mcp?` -- without giving the model the repo.
export async function grepSource({ repo, pattern, refs = ["main"], paths = ["app", "lib", "src", "config"], max_hits = 40, context = 2 }) {
  if (!repo || !pattern || pattern.length < 3) return { error: "repo and a pattern of 3+ chars required" };
  const sha = await commitFor(repo, refs);
  if (!sha) return { error: `no indexed commit for ${repo}` };
  const prefixes = (paths || []).map(d => `${String(d).replace(/\/$/, "")}/%`);
  const rows = await q(
    `select cf.path, bt.text from ckg.commit_files cf
       join ckg.repos rp on rp.id = cf.repo_id
       join ckg.blob_text bt on bt.blob_sha = cf.blob_sha
      where rp.name = $1 and cf.commit_sha = decode($2,'hex')
        and ($3::text[] = '{}' or cf.path like any($3::text[]))
        and position($4 in bt.text) > 0
      order by cf.path limit 200`, [repo, sha, prefixes, pattern]);
  const files = [];
  let total = 0;
  outer: for (const r of rows) {
    if (SECRET_PATHS.test(r.path)) continue;
    const src = r.text.split("\n");
    const hits = [];
    for (let i = 0; i < src.length; i++) {
      if (!src[i].includes(pattern)) continue;
      hits.push({ line: i + 1, text: src[i].trim().slice(0, 200),
                  context: src.slice(Math.max(0, i - context), i + 1 + context).map((l, j) => `${String(Math.max(1, i + 1 - context) + j).padStart(5)}  ${l}`) });
      if (++total >= max_hits) { files.push({ path: r.path, hits }); break outer; }
    }
    if (hits.length) files.push({ path: r.path, hits });
  }
  return { repo, pattern, commit: sha.slice(0, 10), total_hits: total, capped: total >= max_hits, files };
}

/**
 * semantic_anchor -- meaning-based lookup of a starting node. Embeds the question and returns the
 * k nearest entity cards. Used ONLY to choose where a trace starts; never as a source of facts.
 * Scoped to the commits the refs point at, like every other tool. Falls back to {matches: []}
 * when no embeddings exist for the configured model.
 */
export async function semanticAnchor({ question, k = 10, refs = ["main"], kinds = null, repo = null }) {
  const { embed, embedModelId, toPgVector } = await import("./service/embed.mjs");
  const model = embedModelId();
  const [v] = await embed([question], { isQuery: true });
  const { commits } = await resolveScope(refs);
  const rows = await q(
    `select e.id, e.kind::text, e.fqn, e.name, e.path, encode(e.commit_sha,'hex') as commit_sha,
            m.card, (1 - (m.embedding <=> $1::vector))::float as score
       from ckg.embeddings m join ckg.entities e on e.id = m.entity_id
      where m.model = $2
        and ($3::text[] is null or e.kind::text = any($3::text[]))
        and (e.commit_sha is null or encode(e.commit_sha,'hex') = any($4::text[]))
        and ($5::text is null or exists (select 1 from ckg.repos rp where rp.id = e.repo_id and rp.name = $5))
      order by m.embedding <=> $1::vector
      limit $6`, [toPgVector(v), model, kinds, commits, repo, k]);
  return { model, matches: rows, count: rows.length };
}


/**
 * search_docs -- semantic search over documentation passages (in-repo docs at the indexed commits, plus
 * uploaded business documents, which are commit-less). Returns passages with the document, heading and text.
 * Used to put what the DOCS say next to what the CODE does; the answer compares the two and says which wins.
 */
export async function searchDocs({ question, k = 6, refs = ["main"], repo = null, min_score = 0.45 }) {
  const { embed, embedModelId, toPgVector } = await import("./service/embed.mjs");
  const model = embedModelId();
  const [v] = await embed([question], { isQuery: true });
  const { commits } = await resolveScope(refs);
  const rows = await q(
    `select d.id as doc_id, d.name as title, d.path, d.attrs->>'source' as source, d.attrs->>'subkind' as subkind, d.attrs->'tags' as tags,
            rp.name as repo, c.ordinal, c.heading_path, c.text, c.words,
            (1 - (c.embedding <=> $1::vector))::float as score
       from ckg.doc_chunks c
       join ckg.entities d on d.blob_sha = c.blob_sha and d.kind = 'DOCUMENT'
       left join ckg.repos rp on rp.id = d.repo_id
      where c.model = $2 and c.embedding is not null
        and (d.commit_sha is null or encode(d.commit_sha,'hex') = any($3::text[]))
        and ($4::text is null or rp.name = $4)
      order by c.embedding <=> $1::vector
      limit $5`, [toPgVector(v), model, commits, repo, k * 3]);
  // one passage per (doc, heading): the best-scoring; then top-k above the floor
  const seen = new Set(); const out = [];
  for (const r of rows) {
    const key = `${r.doc_id}:${r.heading_path}`;
    if (seen.has(key) || Number(r.score) < min_score) continue;
    seen.add(key); out.push({ ...r, score: Number(r.score) });
    if (out.length >= k) break;
  }
  return { model, passages: out, count: out.length };
}

// ---------------------------------------------------------------------------------
// LIVE PLATFORM DATA -- a read-only mirror of a few allowlisted UAT tables (config/live_tables.json),
// kept fresh by src/sync-live.mjs. The model never touches UAT; it asks this bounded tool.
// ---------------------------------------------------------------------------------
import { readFileSync as _rf } from "node:fs";
export const LIVE_TABLES = JSON.parse(_rf(new URL("../config/live_tables.json", import.meta.url), "utf8")).tables;
export const LIVE_DOC = Object.entries(LIVE_TABLES).map(([t, s]) => `- live.${t} (${s.columns.join(", ")}): ${s.describe}`).join("\n");
const lident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };

export async function liveFreshness() {
  const rows = await q(`select table_name, rows_total, last_run, last_cursor, last_error from live.sync_state order by 1`).catch(() => []);
  return { tables: rows, as_of: rows.reduce((m, r) => (!m || (r.last_run && r.last_run > m)) ? r.last_run : m, null) };
}

/**
 * query_live -- SELECT allowlisted columns from ONE mirrored table with equality / substring filters.
 * Never joins arbitrary SQL; company lookups by name go through where/like on live.companies first.
 * Returns rows, the exact total, and as_of (when this table was last synced) -- answers must say both.
 */
export async function queryLive({ table, where = {}, like = {}, contains = {}, not_null = [], columns = null, limit = 50, order_by = null }) {
  const spec = LIVE_TABLES[table];
  if (!spec) return { error: `not a live table: ${table}. Allowed: ${Object.keys(LIVE_TABLES).join(", ")}` };
  const cols = (columns && columns.length ? columns : spec.columns).filter(c => spec.columns.includes(c));
  if (!cols.length) return { error: "no allowed columns requested" };
  const params = []; const conds = [];
  for (const [c, v] of Object.entries(where || {})) {
    if (!spec.columns.includes(c)) return { error: `column ${c} is not allowed on ${table}` };
    if (Array.isArray(v)) { params.push(v); conds.push(`${lident(c)}::text = any($${params.length}::text[])`); }
    else if (v === null) conds.push(`${lident(c)} is null`);
    else { params.push(String(v)); conds.push(`${lident(c)}::text = $${params.length}`); }
  }
  for (const [c, v] of Object.entries(like || {})) {
    if (c === "any") {                                              // OR across several columns: {"any": {"columns": [...], "value": "lot"}}
      const cols2 = (v?.columns || []).filter(x => spec.columns.includes(x));
      if (!cols2.length) return { error: "like.any needs allowed columns" };
      params.push(`%${String(v.value)}%`); conds.push(`(${cols2.map(x => `${lident(x)}::text ilike $${params.length}`).join(" or ")})`);
      continue;
    }
    if (!spec.columns.includes(c)) return { error: `column ${c} is not allowed on ${table}` };
    params.push(`%${String(v)}%`); conds.push(`${lident(c)}::text ilike $${params.length}`);
  }
  // JSON-aware: contains = jsonb @> (e.g. {"defaults": {"value": true}}), not_null = column is not null
  for (const [c, v] of Object.entries(arguments[0].contains || {})) {
    if (!spec.columns.includes(c)) return { error: `column ${c} is not allowed on ${table}` };
    params.push(JSON.stringify(v)); conds.push(`${lident(c)}::jsonb @> $${params.length}::jsonb`);
  }
  for (const c of arguments[0].not_null || []) { if (spec.columns.includes(c)) conds.push(`${lident(c)} is not null`); }
  const whereSql = conds.length ? `where ${conds.join(" and ")}` : "";
  const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  const ord = order_by && spec.columns.includes(order_by) ? `order by ${lident(order_by)} desc` : `order by ${lident(spec.cursor)} desc`;
  const [{ n }] = await q(`select count(*)::int n from live.${lident(table)} ${whereSql}`, params);
  const rows = await q(`select ${cols.map(lident).join(", ")}, synced_at from live.${lident(table)} ${whereSql} ${ord} limit ${lim}`, params);
  const [st] = await q(`select last_run from live.sync_state where table_name=$1`, [table]);
  return { table, where, like, contains, total: n, returned: rows.length, complete: n <= rows.length, as_of: st?.last_run ?? null, source: "UAT platform database (mirror)",
           rows: rows.map(r => { const o = { ...r }; delete o.synced_at; for (const k of Object.keys(o)) if (typeof o[k] === "string" && o[k].length > 600) o[k] = o[k].slice(0, 600) + "…"; return o; }) };
}


/**
 * search_configs -- find configuration switches by MEANING over key + human name + description + default,
 * and say how many companies override each (and how many have it on). This is how "the lock that stops two
 * flexi PO transactions running together" resolves to fx_response_sequence_advisory_lock_enabled.
 */
export async function searchConfigs({ question, k = 6, min_score = 0.4 }) {
  const { embed, embedModelId, toPgVector } = await import("./service/embed.mjs");
  const model = embedModelId();
  const [v] = await embed([question], { isQuery: true });
  const rows = await q(
    `select ci.config_key, (1 - (ci.embedding <=> $1::vector))::float as score,
            m.name, m.description, m.defaults, m.status, m.item_type,
            (select count(*) from live.custom_configurations cc where cc.config_key = ci.config_key) as overrides,
            (select count(*) from live.custom_configurations cc where cc.config_key = ci.config_key and cc.status = 1) as overrides_active,
            (select count(distinct cc.company_id) from live.custom_configurations cc where cc.config_key = ci.config_key and cc.status = 1) as companies_active
       from live.config_index ci
       join lateral (select name, description, defaults, status, item_type from live.master_configurations m where m.config_key = ci.config_key order by company_id nulls first limit 1) m on true
      where ci.model = $2
      order by ci.embedding <=> $1::vector
      limit $3`, [toPgVector(v), model, k]).catch(() => []);
  const [st] = await q(`select last_run from live.sync_state where table_name='master_configurations'`).catch(() => [{}]);
  return { model, as_of: st?.last_run ?? null, configs: rows.filter(r => Number(r.score) >= min_score).map(r => ({ ...r, score: Number(Number(r.score).toFixed(2)), overrides: Number(r.overrides), overrides_active: Number(r.overrides_active), companies_active: Number(r.companies_active) })) };
}
