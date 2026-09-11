# Picking a model provider

Every provider below speaks the OpenAI-compatible `/v1/chat/completions` shape, so
switching is **three environment variables and no code change**.

## What actually gets sent to the model

Worth knowing before choosing, because it decides how much the provider's data terms matter.

In `LLM_MODE=guided` (the fast path; `auto` is the default and routes to it only for exact identifiers) the model receives **only the extracted JSON facts** —
node kinds, names, file paths, line numbers, the edge chain, and the gap list. Typically
2–8 KB. It never receives source code, and the pipeline already excludes `.env`, `*.pem`,
`*.key` and `id_rsa*` at the tree walk, so no credential can reach it.

What it *does* reveal is a map of your architecture: file paths, table names, endpoint
inventory, service class names. Not secret, but not nothing.

**Some free tiers train on your inputs by default.** That is a call for whoever owns data
policy at Procol, not an engineering one. If the answer is no, use Ollama — nothing leaves
the network at all.

## Free options

| Provider | `LLM_BASE_URL` | Notes |
|---|---|---|
| **Ollama** (local) | `http://localhost:11434/v1` | Free forever, no signup, nothing leaves. Needs a machine to run it |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai/` | Real free tier via AI Studio. Free-tier inputs are used to improve Google products |
| **Groq** | `https://api.groq.com/openai/v1` | Free tier, very fast, hosts Llama/Qwen |
| **Cerebras** | `https://api.cerebras.ai/v1` | Free tier, fast, Llama models |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Aggregator; some models are free (`:free` suffix) |
| **Mistral** | `https://api.mistral.ai/v1` | Free experiment tier |

Model names change often — take the current one from the provider's own model list rather
than from this table.

## Commands

```bash
# Local, free, nothing leaves the network
brew install ollama && ollama pull qwen2.5:7b-instruct
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5:7b-instruct LLM_MODE=guided \
CKG_DATABASE_URL=postgres://localhost/ckg npm run serve

# Google Gemini free tier
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
LLM_MODEL=gemini-2.0-flash LLM_API_KEY=<ai-studio-key> LLM_MODE=guided \
CKG_DATABASE_URL=postgres://localhost/ckg npm run serve

# Groq free tier
LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_MODEL=<current-llama-model> \
LLM_API_KEY=<groq-key> LLM_MODE=guided \
CKG_DATABASE_URL=postgres://localhost/ckg npm run serve
```

## The two modes

| | `LLM_MODE=guided` (default) | `LLM_MODE=agent` |
|---|---|---|
| Who picks the tools | **the service**, deterministically | the model |
| Model requirement | any model, including weak free tiers | reliable tool-calling |
| Model's job | write prose over facts it cannot influence | choose tools, then write prose |
| If the model is bad | prose is worse; **facts are unaffected** | may pick wrong tools or skip them |
| Follow-up questions | one anchor per question | can explore |

**Use `guided` with any free or local model.** It removes the failure that matters: the
model cannot skip the graph, cannot pick the wrong tool, and cannot bury the gaps — because
`unresolved`, `truncated` and `hubs_not_expanded` are computed by the service and emitted
to the client *before* the model is asked anything.

`agent` mode fails closed: if the model answers without calling a single tool, the service
returns `error: model_skipped_tools` rather than passing off an ungrounded answer, because
a model answering about your codebase from generic React/Rails knowledge is precisely the
failure this system exists to prevent.

## Verified degradation

With the model endpoint dead, `guided` still returns claims and evidence from the graph and
says only the prose is missing:

```
CLAIM: HANDLER api/activity_logs#index at app/controllers/api/activity_logs_controller.rb
ERROR: fetch failed
TOKEN: (No prose available — the language model call failed. The claims and evidence
        above come from the code graph and are unaffected.)
DONE:  {"claim_count":1,"evidence_count":1,"tool_calls":4,"mode":"guided","ms":85}
```

The graph is the product. The model is the narrator, and it is replaceable.
