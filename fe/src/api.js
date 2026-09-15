// Talks to the agent service. Same origin in production; Vite proxy in dev. Identity is a session cookie
// set by the service (HttpOnly), so there is no token in the browser and nothing to store.
const BASE = import.meta.env.VITE_CKG_URL || "";

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `${path} ${res.status}`); e.status = res.status; throw e; }
  return body;
}
const post = (path, data) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data || {}) });

export const getHealth = () => call("/api/health");
export const getRefs = () => call("/api/refs");
export const getAuthConfig = () => call("/api/auth/config");
export const getMe = () => call("/api/me");
export const login = (email, password) => post("/api/auth/login", { email, password });
export const logout = () => post("/api/auth/logout");

/** Streams typed events; returns an abort function. The role on the session decides the answer style. */
export const askStream = ({ question, refs, onEvent, onError }) => {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/ask`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, refs }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const e = new Error(body.error || `ask ${res.status}`); e.status = res.status;
        throw e;
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
