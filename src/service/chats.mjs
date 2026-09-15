// Saved chats: personal threads of turns. Events are stored gzipped (about 8x smaller) so a reopened chat
// redraws prose, trace, tables, template previews and diagrams without a model call; the answer text stays
// after the events are pruned. Every function takes the owner's email and refuses anything not theirs.
import { gzipSync, gunzipSync } from "node:zlib";
import { q, one } from "../db.mjs";

const TITLE_MAX = 80;
const titleOf = (question) => { const t = String(question || "").replace(/\s+/g, " ").trim(); return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + "…" : t || "New chat"; };

export async function createChat(email, title = null) {
  return one(`insert into ckg.chats (email, title) values ($1, $2) returning id, title, created_at, updated_at`, [email, title ? titleOf(title) : null]);
}

export async function listChats(email, limit = 200) {
  return q(`select c.id, c.title, c.created_at, c.updated_at,
                   (select count(*) from ckg.chat_turns t where t.chat_id = c.id)::int as turns
              from ckg.chats c where c.email = $1 and c.archived_at is null
             order by c.updated_at desc limit $2`, [email, limit]);
}

export async function chatMeta(email, id) {
  return one(`select id, title, created_at, updated_at from ckg.chats where id = $1 and email = $2 and archived_at is null`, [id, email]).catch(() => null);
}

/** The full chat for replay: turns in order, events decompressed (null when pruned). */
export async function getChat(email, id) {
  const chat = await chatMeta(email, id);
  if (!chat) return null;
  const rows = await q(`select seq, question, standalone_question, refs, role, answer_text, entities, events_gz, model, ms, cached, created_at
                          from ckg.chat_turns where chat_id = $1 order by seq`, [id]);
  const turns = rows.map((r) => {
    let events = null;
    if (r.events_gz) { try { events = JSON.parse(gunzipSync(r.events_gz).toString("utf8")); } catch { events = null; } }
    return { seq: r.seq, question: r.question, standalone_question: r.standalone_question, refs: r.refs || [], role: r.role, answer_text: r.answer_text,
             entities: r.entities || [], events, pruned: !r.events_gz, model: r.model, ms: r.ms, cached: r.cached, created_at: r.created_at };
  });
  return { ...chat, turns };
}

/** What the answer was about: the named things in its claims, templates and screens. Small, for later context. */
export function extractEntities(events, max = 12) {
  const seen = new Set(), out = [];
  const push = (kind, name) => { const k = `${kind}:${name}`; if (name && !seen.has(k) && out.length < max) { seen.add(k); out.push({ kind, name: String(name).slice(0, 80) }); } };
  for (const e of events || []) {
    if (e.type === "claim" && e.name && e.kind !== "HTTP_CALL_SITE") push(e.kind, e.name);
    if (e.type === "template") push("TEMPLATE", e.name);
    if (e.type === "table" && e.source) push("LIVE_TABLE", e.source);
  }
  for (const e of events || []) if (e.type === "flow") for (const s of (e.steps || []).slice(0, 4)) push("STEP", s.label);
  return out;
}

export async function appendTurn(email, chatId, { question, standalone_question = null, refs = [], role = null, events = [], model = null, ms = null, cached = false }) {
  const chat = await chatMeta(email, chatId);
  if (!chat) throw new Error("no such chat");
  const answer_text = events.filter((e) => e.type === "token").map((e) => e.text).join("").trim();
  const stored = events.filter((e) => e.type !== "status");
  const events_gz = stored.length ? gzipSync(Buffer.from(JSON.stringify(stored), "utf8"), { level: 6 }) : null;
  const entities = JSON.stringify(extractEntities(stored));
  const row = await one(`insert into ckg.chat_turns (chat_id, seq, question, standalone_question, refs, role, answer_text, entities, events_gz, model, ms, cached)
                         values ($1, (select coalesce(max(seq), 0) + 1 from ckg.chat_turns where chat_id = $1), $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
                         returning seq, created_at`,
                        [chatId, question, standalone_question && standalone_question !== question ? standalone_question : null, refs, role, answer_text, entities, events_gz, model, ms, cached]);
  await q(`update ckg.chats set updated_at = now(), title = coalesce(title, $2) where id = $1`, [chatId, titleOf(question)]);
  return { seq: row.seq, created_at: row.created_at, bytes: events_gz ? events_gz.length : 0, answer_text };
}

/** The last n turns, condensed for the model: what was asked, how it was understood, a short answer, what it was about. */
export async function historyFor(email, chatId, n = 6) {
  const chat = await chatMeta(email, chatId);
  if (!chat) return [];
  const rows = await q(`select question, standalone_question, answer_text, entities from ckg.chat_turns where chat_id = $1 order by seq desc limit $2`, [chatId, n]);
  return rows.reverse().map((r) => ({ question: r.question, ...(r.standalone_question ? { understood_as: r.standalone_question } : {}),
                                       answer: String(r.answer_text || "").replace(/\s+/g, " ").slice(0, 400), about: (r.entities || []).slice(0, 10) }));
}

export async function renameChat(email, id, title) {
  return one(`update ckg.chats set title = $3, updated_at = updated_at where id = $1 and email = $2 returning id, title`, [id, email, titleOf(title)]);
}

export async function deleteChat(email, id) {
  const r = await q(`delete from ckg.chats where id = $1 and email = $2 returning id`, [id, email]);
  return r.length > 0;
}

/** Retention: turns older than `days` lose their event stream; question and answer text stay. */
export async function sweepRetention(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const r = await q(`update ckg.chat_turns set events_gz = null where events_gz is not null and created_at < now() - ($1 || ' days')::interval returning id`, [String(days)]);
  return r.length;
}

export async function chatStorage() {
  const [r] = await q(`select count(*)::int chats, (select count(*) from ckg.chat_turns)::int turns,
                              pg_size_pretty(pg_total_relation_size('ckg.chat_turns') + pg_total_relation_size('ckg.chats')) as size from ckg.chats`);
  return r;
}
