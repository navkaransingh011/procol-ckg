# Agent service HTTP contract — v1

Frozen so the dashboard module and the agent service can be built in parallel.
Roles are **out of scope for v1**: every authenticated Procol staff user gets the
same answer. Access is binary (see Auth).

## Auth

The dashboard sends the **existing Procol session token** it already holds in
`PROCOL_TOKEN_KEY` — no new token type, no new `Session.token_type`, no migration.

```
Authorization: Bearer <procol access token>
```

The service forwards it to Procol to resolve identity, then checks the caller holds
the module permission. It never trusts anything else the client sends.

> Do **not** add a `token_type` to `Session` for this. `disable_same_device_sessions`
> and `enforce_single_web_session` both guard with `return if self.mcp?` — a third
> type is not exempt, so minting one would log the user out of the dashboard.

`401` unauthenticated · `403` authenticated but lacks the module permission.

## POST /api/ask

Request:

```json
{
  "question": "what happens when activity logs are fetched?",
  "refs": ["main"],
  "conversation_id": "optional, for follow-ups"
}
```

`refs` selects which deployed refs to read. Tenants run different code, so this
changes the answer; default `["main"]`. Valid values come from `GET /api/refs`.

Response: `text/event-stream`, one JSON object per `data:` line. Use
`fetch` + `ReadableStream` — **not `EventSource`**, which cannot set the auth header.

| `type` | Payload | Render as |
|---|---|---|
| `status` | `{ text }` | transient line ("tracing from api.js:5") |
| `token` | `{ text }` | append to the current answer |
| `claim` | `{ id, text, evidence_ids[], confidence }` | a sentence with citation chips |
| `evidence` | `{ id, repo, path, line, commit, ref, extractor }` | popover content for a chip |
| `unresolved` | `{ fqn, path, line, reason }` | **a normal outcome, not an error** |
| `truncated` | `{ reason, at_depth }` | "trace bounded at depth 6" |
| `done` | `{ claim_count, evidence_count, ms }` | stop the spinner |
| `error` | `{ code, message }` | error state |

### Rules the FE must honour

1. **Never render a `claim` without its evidence chips.** The chips are the product;
   a paragraph with no provenance is a chatbot.
2. **`unresolved` is not a failure.** Style it as a normal outcome that says where the
   trail stops and why. Red warning styling teaches users to ignore it — and it is
   often the most valuable thing in the answer.
3. **Show which refs were read**, always. An answer about `main` is not an answer
   about `reliance-main`.

## GET /api/refs

```json
{ "refs": [
  { "ref": "main",           "tenant": "procol", "env": "prod",    "indexed_at": "..." },
  { "ref": "reliance-main",  "tenant": "ril",    "env": "prod",    "indexed_at": "..." },
  { "ref": "jindal-sandbox", "tenant": "jindal", "env": "sandbox", "indexed_at": "..." }
] }
```

## GET /api/health

`{ "ok": true, "entities": 9430, "edges": 7223, "refs": 9, "last_indexed": "..." }`

Useful as the module's empty state: if `entities` is 0 the graph is not loaded, which
is a different message from "no answer found".

---

## Running it

```bash
# no model, no key -- for building the FE
CKG_DATABASE_URL=postgres://localhost/ckg npm run serve

# local model, still no key
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5:7b-instruct \
CKG_DATABASE_URL=postgres://localhost/ckg npm run serve

# your own project key
LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4.1-mini LLM_API_KEY=sk-... \
CKG_DATABASE_URL=postgres://localhost/ckg npm run serve
```

`LLM_BASE_URL=mock` (the default) runs a **fixed tool chain** and emits every event
type in the contract, with every claim prefixed `[MOCK]`. The dashboard module can be
built, styled and reviewed against it before any model or key exists.

| Env | Default | Notes |
|---|---|---|
| `PORT` | `8787` | binds `127.0.0.1` only |
| `CKG_ALLOWED_ORIGIN` | `http://localhost:3000` | the dashboard's dev origin |
| `CKG_AUTH_MODE` | `dev` | `dev` accepts any token and says so in the stream. Use `procol` anywhere reachable |
| `CKG_PROCOL_VERIFY_URL` | — | required when `CKG_AUTH_MODE=procol` |
| `LLM_AZURE_API_VERSION` | — | set it to switch to Azure's `api-key` header + `?api-version=` |
