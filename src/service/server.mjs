#!/usr/bin/env node
// The agent service. Implements docs/API_CONTRACT.md.
// Node's built-in http server -- no framework, so there is nothing to keep updated.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "./agent.mjs";
import { provider } from "./llm.mjs";
import { q, pool } from "../db.mjs";
import { resolveScope } from "../tools.mjs";
import { embed } from "./embed.mjs";
import { authConfig, sessionFromRequest, createSession, destroySession, checkPassword, clearCookie as clearCookieFor } from "./auth.mjs";
import { filterEvent, allowedRefs, styleFor, isOpen } from "./policy.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.CKG_HOST || "127.0.0.1";
// The standalone UI (fe/) is served from here when built, so production is one process, one origin.
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fe/dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
               ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json" };
const ORIGIN = process.env.CKG_ALLOWED_ORIGIN || "http://localhost:3000";
// Identity: a session cookie set by /api/auth/google or /api/auth/dev (src/service/auth.mjs).
// Roles: config/roles.json, enforced by src/service/policy.mjs on refs, facts and every streamed event.
function cors(res) {
  res.setHeader("access-control-allow-origin", ORIGIN);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("vary", "origin");
}

const json = (res, code, body, headers = {}) => {
  cors(res);
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

async function readJson(req, max = 64 * 1024) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > max) throw Object.assign(new Error("body too large"), { code: 413 }); }
  try { return JSON.parse(body || "{}"); } catch { throw Object.assign(new Error("invalid JSON"), { code: 400 }); }
}

const publicUser = (u) => u && { email: u.email, name: u.name, picture: u.picture, role: u.role, via: u.via,
                                  label: u.policy.label, can: { code_names: u.policy.code_names, endpoints: u.policy.endpoints,
                                  paths: u.policy.paths, code_source: u.policy.code_source, refs: u.policy.refs, admin: !!u.policy.admin } };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  if (url.pathname === "/api/health") {
    const [row] = await q(
      `select (select count(*) from ckg.entities) as entities,
              (select count(*) from ckg.edges) as edges,
              (select count(distinct ref_name) from ckg.ref_history) as refs,
              (select max(finished_at) from ckg.index_runs where ok) as last_indexed`);
    const p = provider();
    return json(res, 200, {
      ok: true,
      entities: Number(row.entities), edges: Number(row.edges), refs: Number(row.refs),
      last_indexed: row.last_indexed,
      provider: p.mock ? "mock (no model configured)" : `${p.base} · ${p.model}`,
      auth_mode: "password",
    });
  }

  if (url.pathname === "/api/refs") {
    const user = await sessionFromRequest(req);
    if (!user) return json(res, 401, { error: "sign in first" });
    const rows = await q(
      `select distinct on (r.repo_id, r.ref_name)
              r.ref_name as ref, r.tenant, r.env, rp.name as repo, r.last_seen as indexed_at
         from ckg.ref_history r join ckg.repos rp on rp.id = r.repo_id
        order by r.repo_id, r.ref_name, r.last_seen desc`);
    const names = allowedRefs(user.policy, [...new Set(rows.map(r => r.ref))]);
    return json(res, 200, { refs: rows.filter(r => names.includes(r.ref)) });
  }

  // ---- identity ----
  if (url.pathname === "/api/auth/config") return json(res, 200, authConfig());

  if (url.pathname === "/api/me") {
    const user = await sessionFromRequest(req);
    return user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: "not signed in" });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const { email, password } = await readJson(req, 4 * 1024);
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
      const who = await checkPassword({ email, password }, ip);
      const { cookie, user } = await createSession({ ...who, via: "password" }, req);
      return json(res, 200, { user: publicUser(user) }, { "set-cookie": cookie });
    } catch (e) { return json(res, e.code || 401, { error: e.message }); }
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    await destroySession(req);
    return json(res, 200, { ok: true }, { "set-cookie": clearCookieFor(req) });
  }

  // ---- the question ----
  if (url.pathname === "/api/ask" && req.method === "POST") {
    const user = await sessionFromRequest(req);
    if (!user) return json(res, 401, { error: "sign in first" });
    const policy = user.policy;

    let parsed;
    try { parsed = await readJson(req); } catch (e) { return json(res, e.code || 400, { error: e.message }); }

    const question = String(parsed.question || "").trim();
    if (!question) return json(res, 400, { error: "question is required" });
    const wanted = Array.isArray(parsed.refs) && parsed.refs.length ? parsed.refs : ["main"];
    const refs = allowedRefs(policy, wanted);            // a branch the role may not read becomes main
    const style = styleFor(policy);                      // the role decides the answer style, not the client
    const fresh = parsed.fresh === true;

    const known = await resolveScope(refs);
    if (!known.commits.length) {
      return json(res, 400, { error: `no indexed commit for refs: ${refs.join(", ")}` });
    }

    cors(res);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Every event passes the role filter on its way out: paths, code nodes and source never reach a browser
    // whose role may not see them, whatever the model wrote.
    const emit = (event) => { const f = filterEvent(event, policy); if (f) res.write(`data: ${JSON.stringify(f)}\n\n`); };
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

    const t0 = Date.now();
    let summary = null, failed = false;
    try {
      if (!isOpen(policy)) emit({ type: "status", text: `answering for ${policy.label}: ${policy.code_names ? "code names, no file paths" : "product terms only, no code"}` });
      if (refs.join() !== wanted.join()) emit({ type: "status", text: `branch ${wanted.join(", ")} is not available to ${policy.label}; reading ${refs.join(", ")}` });
      summary = await ask({ question, refs, emit, style, fresh, policy });
    } catch (e) {
      failed = true;
      emit({ type: "error", code: "agent_failed", message: e.message });
    } finally {
      clearInterval(keepAlive);
      res.end();
      q(`insert into ckg.ask_log (email, role, question, refs, style, model, ms, ok, cached) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [user.email, user.role, question, refs, style, summary?.model || null, Date.now() - t0, !failed, !!summary?.cached]).catch(() => {});
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

  // static UI with SPA fallback; refuses anything that escapes fe/dist
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(STATIC_DIR, rel);
    if (!file.startsWith(STATIC_DIR)) return json(res, 403, { error: "forbidden" });
    const serve = async (f) => {
      const body = await readFile(f);
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream",
                           "cache-control": f.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
      res.end(body);
    };
    try {
      if ((await stat(file)).isFile()) return await serve(file);
    } catch { /* fall through to SPA index */ }
    try { return await serve(path.join(STATIC_DIR, "index.html")); }
    catch { return json(res, 404, { error: "UI not built: run `npm run build` in fe/" }); }
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  const p = provider();
  console.log(`ckg-agent on http://${HOST}:${PORT}`);
  console.log(`  provider  ${p.mock ? "mock (no model, no key)" : p.base + " · " + p.model}`);
  console.log(`  auth      email + password (ckg.users), roles from config/roles.json`);
  console.log(`  cors      ${ORIGIN}`);
  // Warm the embedding model now, so the first question's document search is ~12 ms instead of ~170 ms.
  embed(["warm up"]).then(() => console.log("  embed     warm")).catch((e) => console.log(`  embed     not available (${e.message}); document search will be skipped`));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
