-- Role-based access. Identity comes from Google sign-in (procol.in) or, on a laptop, the dev sign-in;
-- the role comes from ckg.users (unknown staff get config/roles.json default_role, the lowest).
-- Sessions are opaque random tokens stored hashed; the browser holds them in an HttpOnly cookie.

create table if not exists ckg.users (
  email    text primary key,             -- lower-cased
  role     text not null,                -- a key of config/roles.json "roles"
  name     text,
  set_by   text,
  set_at   timestamptz not null default now()
);

create table if not exists ckg.sessions (
  token_hash text primary key,           -- sha256 of the cookie value; the raw token is never stored
  email      text not null,
  name       text,
  picture    text,
  role       text,                       -- role at sign-in, for audit; the live role is read from ckg.users per request
  via        text,                       -- 'google' | 'dev'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen  timestamptz not null default now()
);
create index if not exists sessions_email on ckg.sessions (email);
create index if not exists sessions_expires on ckg.sessions (expires_at);

-- Who asked what, under which role. Questions only; answers stay in answer_cache.
create table if not exists ckg.ask_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  email     text,
  role      text,
  question  text,
  refs      text[],
  style     text,
  model     text,
  ms        integer,
  ok        boolean,
  cached    boolean
);
create index if not exists ask_log_at on ckg.ask_log (at desc);
