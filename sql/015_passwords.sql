-- Email + password sign-in (Google deferred). Passwords are scrypt hashes; the raw value is never stored.
alter table ckg.users add column if not exists password_hash text;
alter table ckg.users add column if not exists disabled boolean not null default false;
alter table ckg.users add column if not exists last_login timestamptz;
