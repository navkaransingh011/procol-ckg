-- Thumbs up / down on ordinary answers (triage cards already have ckg.triage_feedback). This is how the evaluation
-- set grows from real use: a thumbs-down question is a candidate for eval/answers.json with a human-written expectation.
--   select question, confidence, email, created_at from ckg.answer_feedback where not helpful order by created_at desc;
set search_path = ckg, public;

create table if not exists ckg.answer_feedback (
  id         bigserial primary key,
  email      text not null,
  chat_id    uuid,
  seq        integer,
  helpful    boolean not null,
  question   text,             -- as the person asked it (the standalone form is in chat_turns when there is a chat)
  confidence text,             -- the level the answer carried, to spot over-confident misses
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists answer_feedback_at on ckg.answer_feedback (created_at desc);
revoke all on ckg.answer_feedback from ckg_reader;   -- people's ratings are not model-readable data
