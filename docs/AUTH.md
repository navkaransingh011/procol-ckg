# Sign-in and roles

Who can open the Code Graph, and how much of the code each person's answers show.

## How it works

1. **Identity**: email + password, checked against `ckg.users`. Passwords are stored as salted scrypt hashes
   (Node built-in); the service never stores or logs the raw value. Five wrong attempts on an email or an address
   trigger a one-minute wait. There is no self sign-up: an engineer creates accounts with the CLI below.
   Google sign-in is written but parked until the VM has a hostname with TLS (Google refuses IP origins).
2. **Session**: an opaque random token in an HttpOnly, SameSite=Lax cookie (`ckg_session`). Only its SHA-256 hash
   is stored (`ckg.sessions`), for `CKG_SESSION_DAYS` (default 14). Sign-out deletes the row; disabling an account
   ends its sessions at once.
3. **Role**: the `role` column of `ckg.users`, one of the keys in `config/roles.json`. The role is read on every
   request, so a change applies to the person's next question without a new login. Nobody chooses a role in the UI.
4. **Enforcement** is in the service, not the prompt (`src/service/policy.mjs`), in three places:
   - retrieval: a role without `code_source` never reads or greps source, so that text never reaches the model;
   - facts: what the answer model receives is redacted to the role's view (code nodes, paths, lines removed);
   - stream: every event to the browser passes the same filter, whatever the model wrote.
   The answer cache is keyed by role, so an engineer's answer never replays for a CS user.
5. **Audit**: `ckg.ask_log` records who asked what, under which role, and how long it took.

## Roles (config/roles.json)

| | cs | product | qa | engineer |
|---|---|---|---|---|
| Documents, PRDs, live platform data, config names and defaults | yes | yes | yes | yes |
| Answer style | plain English | plain English | router decides | router decides |
| Endpoints and routes | no | no | yes | yes |
| Class, method, model names | no | no | yes | yes |
| File paths and line numbers | no | no | no | yes |
| Source snippets, grep, read | no | no | no | yes |
| Branches | main | main | all | all |

Edit the JSON to change a role. Restart the service to pick it up.

## Accounts

Run where the database is (laptop or VM). Generated passwords are printed once.

```bash
npm run users -- seed-demo                         # cs.demo, product.demo, qa.demo, engineer.demo @procol.in
npm run users -- add priya@procol.in engineer "Priya S"
npm run users -- role priya@procol.in qa           # applies to her next request
npm run users -- password priya@procol.in          # new generated password
npm run users -- disable priya@procol.in           # ends her sessions too
npm run users -- list
npm run users -- sessions                          # who is signed in now
```

## Testing the restrictions

Sign in as `cs.demo` and as `engineer.demo` in two browsers and ask the same technical question, for example
"What happens when GET /activity_logs is called and which file handles it?". CS gets a plain answer with no file
names, no class names and no trace; engineer gets the handler, the controller path and the evidence trail.
Then change a role with `npm run users -- role` and ask again without signing out: the next answer already follows
the new role. Asking the agent to "show the code anyway" changes nothing, because the code never left the server.

## On the VM

`.env` needs nothing new for password sign-in. The deploy runs the migrations (`ckg.users`, `ckg.sessions`,
`ckg.ask_log`, password columns) and restarts. After the first deploy, create the accounts on the VM with the
commands above. If the site is served over https without an `x-forwarded-proto` header from nginx, set
`CKG_COOKIE_SECURE=1` so the cookie is marked Secure.
