-- The model-facing role (ckg_reader, used for planner-written SQL) must never read who asked what, sessions or accounts.
-- These tables are service-only; the service connects with the owner role.
revoke all on ckg.users, ckg.sessions, ckg.chats, ckg.chat_turns, ckg.ask_log, ckg.triage_feedback, ckg.answer_cache from ckg_reader;
alter default privileges in schema ckg revoke select on tables from ckg_reader;
