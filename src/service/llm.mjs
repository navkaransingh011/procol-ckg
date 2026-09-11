// Provider-agnostic LLM client. Everything speaks the OpenAI-compatible
// /v1/chat/completions shape, so local Ollama, your own project key, and the
// platform's Azure deployment are the SAME code and three env vars:
//
//   LLM_BASE_URL=http://localhost:11434/v1   LLM_MODEL=qwen2.5:7b-instruct   LLM_API_KEY=
//   LLM_BASE_URL=https://api.openai.com/v1   LLM_MODEL=gpt-4.1-mini          LLM_API_KEY=sk-...
//   LLM_BASE_URL=mock                        (no model, no key -- for FE development)

// Read at call time (not module load) so an eval can switch models in one process.
const cfg = () => {
  const BASE = process.env.LLM_BASE_URL || "mock";
  return { BASE, MODEL: process.env.LLM_MODEL || (BASE === "mock" ? "mock" : "unspecified"),
           KEY: process.env.LLM_API_KEY || "", AZURE_VERSION: process.env.LLM_AZURE_API_VERSION || "" };
};

export const provider = () => { const c = cfg(); return { base: c.BASE, model: c.MODEL, mock: c.BASE === "mock" }; };

function endpoint() {
  const { BASE, AZURE_VERSION } = cfg();
  // Azure puts the deployment in the path and the api-version in the query.
  if (AZURE_VERSION) return `${BASE}/chat/completions?api-version=${AZURE_VERSION}`;
  return `${BASE}/chat/completions`;
}

function headers() {
  const { KEY, AZURE_VERSION } = cfg();
  const h = { "content-type": "application/json" };
  if (!KEY) return h;
  if (AZURE_VERSION) h["api-key"] = KEY;      // Azure OpenAI
  else h.authorization = `Bearer ${KEY}`;     // OpenAI, Ollama, most others
  return h;
}

/** One non-streaming round. Tool rounds don't need streaming; the final answer does. */
export async function chat({ messages, tools, temperature = 0.1, max_tokens = 2000 }) {
  const { BASE, MODEL } = cfg();
  if (BASE === "mock") throw new Error("mock provider: use mockRound() instead");
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: MODEL, messages, temperature, max_tokens,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message ?? { content: "" };
}

/** Final answer, streamed token by token. */
export async function* chatStream({ messages, temperature = 0.1, max_tokens = 2000 }) {
  const { BASE, MODEL } = cfg();
  if (BASE === "mock") return;
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens, stream: true }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* keep-alive or partial frame */ }
    }
  }
}
