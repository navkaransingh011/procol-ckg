-- Saved chats. One chat = a thread of turns for one person; a turn keeps the question, what it was understood
-- as, the answer text (kept for ever) and the gzipped event stream that redraws the answer (pruned after
-- CKG_CHAT_RETENTION_DAYS). Chats are strictly personal: every query is scoped by the session's email.
create table if not exists ckg.chats (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists chats_email_recent on ckg.chats (email, updated_at desc);

create table if not exists ckg.chat_turns (
  id                  bigserial primary key,
  chat_id             uuid not null references ckg.chats(id) on delete cascade,
  seq                 integer not null,
  question            text not null,          -- as typed
  standalone_question text,                   -- as understood (follow-ups rewritten); null when identical
  refs                text[],
  role                text,
  answer_text         text,                   -- kept for ever
  entities            jsonb,                  -- [{kind, name}] the answer resolved to; feeds later turns' context
  events_gz           bytea,                  -- gzipped event stream for replay; nulled by the retention sweep
  model               text,
  ms                  integer,
  cached              boolean,
  created_at          timestamptz not null default now(),
  unique (chat_id, seq)
);
create index if not exists chat_turns_prunable on ckg.chat_turns (created_at) where events_gz is not null;
