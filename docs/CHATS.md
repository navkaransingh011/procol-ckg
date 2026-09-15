# Saved chats and conversation context

Every question a person asks is saved in a chat of their own. Reopening a chat redraws each answer exactly as
it was shown: prose, trace, tables, template previews and workflow diagrams, with the "as of" stamps of the day.
Inside a chat the agent understands follow-ups ("and for RIL?", "show me that template").

## Storage (Postgres, same database)

| Table | Holds | Size |
|---|---|---|
| `ckg.chats` | id, owner email, title, timestamps | tiny |
| `ckg.chat_turns` | question, how it was understood, refs, role, answer text, entities, **gzipped events**, model, ms | ~3-7 KB per turn compressed (23 KB avg raw, 8x gzip) |

Sizing: 50 people asking 10 questions a day is roughly 50 MB a month compressed. Retention keeps it bounded:
after `CKG_CHAT_RETENTION_DAYS` (default 180) the replay events of a turn are nulled and only the question and
answer text remain (about 2 KB). The sweep runs a minute after the service starts and then daily.

Chats are strictly personal: every query is scoped by the session's email, admins included. `ckg.ask_log` stays
the audit trail. Deleting a chat deletes its turns (cascade). Signing out keeps chats; a disabled account keeps
them but cannot reach them.

The repo's bootstrap dump (`db/dump/`) is graph-only. Back chats up separately, small and quick:

```bash
pg_dump "$CKG_DATABASE_URL" -t ckg.chats -t ckg.chat_turns -Fc > chats-$(date +%F).dump
```

## Conversation context

- The last 6 turns go to the planner and the answer model in condensed form: the question, how it was understood,
  a 400-character answer summary, and the named things the answer resolved to (screens, templates, code names).
  A few hundred tokens; no effect on a first question in a new chat.
- A question that leans on the conversation (short, or "that / it / and for X / what about") is rewritten once,
  at minimal reasoning effort, into a standalone question using only names the conversation made explicit. The
  rewrite is what gets planned, retrieved and **cached**; the UI shows the original with an "understood as" line.
  If the model is unsure, the original question is used unchanged.
- The answer model is told the conversation is context, never evidence: it must not restate earlier answers as facts.

## API

`GET /api/chats` · `POST /api/chats {title?}` · `GET /api/chats/:id` (turns with events) · `PATCH /api/chats/:id {title}` ·
`DELETE /api/chats/:id`. `POST /api/ask` takes `chat_id`; without one a chat is created and announced as the first
event `{type:"chat", id, title, is_new}`. A rewritten follow-up emits `{type:"rewrite", question, standalone}`.

## What a reopened answer is

A snapshot. Live data (configs, templates) may have changed since; the turn shows its date and an **ask again**
control that re-runs the same question fresh into the same chat rather than silently refreshing the old answer.
