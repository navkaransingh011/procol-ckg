-- Triage feedback: CS marks a triage verdict right or wrong. This is the only way to know whether feature ranking
-- and verdicts work, and it becomes the calibration set.
create table if not exists ckg.triage_feedback (
  id         bigserial primary key,
  email      text not null,
  chat_id    uuid,
  seq        integer,
  verdict    text,
  correct    boolean not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists triage_feedback_at on ckg.triage_feedback (created_at desc);
