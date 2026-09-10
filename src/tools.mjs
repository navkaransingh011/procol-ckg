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

// Traversing all 17 edge kinds from a component reaches half the codebase through
// IMPORTS. Narrative traversal uses only the kinds that describe execution.
export const NARRATIVE_EDGES = [
  "DISPATCHES", "INVOKES", "ISSUES_HTTP", "TARGETS", "SERVES",
  "HANDLED_BY", "USES_SERVICE", "READS", "WRITES", "ENQUEUES",
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
export async function findEntity({ query, kind = null, repo = null, limit = 20 }) {
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
       select e.*, 'path_substring' as match_reason, 0.3::float as score
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
      order by score desc, kind, fqn
      limit $4`,
    [query, kind, repo, limit],
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
              encode(g.commit_sha,'hex') as commit_sha,
              case when g.kind::text = any($2::text[]) then g.src_entity_id else g.dst_entity_id end as from_id,
              case when g.kind::text = any($2::text[]) then g.dst_entity_id else g.src_entity_id end as to_id
         from ckg.edges g
        where g.kind::text = any($2::text[] || $3::text[])
          and g.confidence >= $4
          and encode(g.commit_sha,'hex') = any($5::text[])
     ), walk as (
       select * from (
         with recursive w as (
           select h.edge_id, h.kind, h.confidence, h.guard_expr, h.start_line, h.commit_sha,
                  h.from_id as src, h.to_id as dst, 1 as depth,
                  array[h.from_id, h.to_id] as path
             from hops h where h.from_id = $1
           union all
           select h.edge_id, h.kind, h.confidence, h.guard_expr, h.start_line, h.commit_sha,
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
      confidence: Number(r.confidence), guard: r.guard_expr,
      line: r.start_line, commit: r.commit_sha,
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
