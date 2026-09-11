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

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.CKG_HOST || "127.0.0.1";
// The standalone UI (fe/) is served from here when built, so production is one process, one origin.
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fe/dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
               ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json" };
const ORIGIN = process.env.CKG_ALLOWED_ORIGIN || "http://localhost:3000";
// 'procol' verifies the bearer token against the platform. 'dev' accepts anything
// and says so loudly -- never run 'dev' anywhere reachable from outside your machine.
const AUTH_MODE = process.env.CKG_AUTH_MODE || "dev";
const PROCOL_VERIFY_URL = process.env.CKG_PROCOL_VERIFY_URL || "";

function cors(res) {
  res.setHeader("access-control-allow-origin", ORIGIN);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("vary", "origin");
}

const json = (res, code, body) => {
  cors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Identity comes from the platform, never from the request body.
 * Roles are out of scope for v1: every authenticated staff user gets the same answer.
 */
async function authenticate(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (AUTH_MODE === "dev") {
    return { ok: true, user: { email: "dev@localhost", dev_mode: true } };
  }
  if (!token) return { ok: false, code: 401, message: "missing bearer token" };
  if (!PROCOL_VERIFY_URL) return { ok: false, code: 500, message: "CKG_PROCOL_VERIFY_URL not set" };

  try {
    const r = await fetch(PROCOL_VERIFY_URL, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!r.ok) return { ok: false, code: 401, message: "platform rejected the token" };
    const u = await r.json();
    return { ok: true, user: u };
  } catch (e) {
    return { ok: false, code: 502, message: `identity check failed: ${e.message}` };
  }
}

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
      auth_mode: AUTH_MODE,
    });
  }

  if (url.pathname === "/api/refs") {
    const rows = await q(
      `select distinct on (r.repo_id, r.ref_name)
              r.ref_name as ref, r.tenant, r.env, rp.name as repo, r.last_seen as indexed_at
         from ckg.ref_history r join ckg.repos rp on rp.id = r.repo_id
        order by r.repo_id, r.ref_name, r.last_seen desc`);
    return json(res, 200, { refs: rows });
  }

  if (url.pathname === "/api/ask" && req.method === "POST") {
    const auth = await authenticate(req);
    if (!auth.ok) return json(res, auth.code, { error: auth.message });

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) return json(res, 413, { error: "body too large" });
    }
    let parsed;
    try { parsed = JSON.parse(body || "{}"); }
    catch { return json(res, 400, { error: "invalid JSON" }); }

    const question = String(parsed.question || "").trim();
    if (!question) return json(res, 400, { error: "question is required" });
    const refs = Array.isArray(parsed.refs) && parsed.refs.length ? parsed.refs : ["main"];
    const style = ["code", "simple", "auto"].includes(parsed.style) ? parsed.style : "auto";
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
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

    try {
      if (auth.user?.dev_mode) {
        emit({ type: "status", text: "AUTH_MODE=dev — requests are not authenticated" });
      }
      await ask({ question, refs, emit, style, fresh });
    } catch (e) {
      emit({ type: "error", code: "agent_failed", message: e.message });
    } finally {
      clearInterval(keepAlive);
      res.end();
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
  console.log(`  auth      ${AUTH_MODE}${AUTH_MODE === "dev" ? "  ← NOT AUTHENTICATED" : ""}`);
  console.log(`  cors      ${ORIGIN}`);
  // Warm the embedding model now, so the first question's document search is ~12 ms instead of ~170 ms.
  embed(["warm up"]).then(() => console.log("  embed     warm")).catch((e) => console.log(`  embed     not available (${e.message}); document search will be skipped`));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
