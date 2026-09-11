// Talks to the agent service (docs/API_CONTRACT.md). Same origin in production; Vite proxy in dev.
// fetch + ReadableStream, not EventSource: EventSource cannot send an Authorization header.
const BASE = import.meta.env.VITE_CKG_URL || "";

const authHeader = () => {
  let token = null;
  try { token = localStorage.getItem("ckg_token"); } catch { /* storage blocked */ }
  return token ? { authorization: `Bearer ${token}` } : {};
};

export const getHealth = async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: authHeader() });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
};

export const getRefs = async () => {
  const res = await fetch(`${BASE}/api/refs`, { headers: authHeader() });
  if (!res.ok) throw new Error(`refs ${res.status}`);
  return res.json();
};

/** Streams typed events; returns an abort function. */
export const askStream = ({ question, refs, style, onEvent, onError }) => {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({ question, refs, style }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `ask ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* keep-alive or partial frame */ }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") onError(err);
    }
  })();
  return () => controller.abort();
};
