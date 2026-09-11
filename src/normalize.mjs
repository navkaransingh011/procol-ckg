/** Query-string keys are evidence, never part of path identity. */
export function normalizeEndpoint(raw) {
  if (!raw) return null;
  let p = raw.split("?")[0].trim();
  p = p.replace(/\(\.:format\)$/, "");            // Rails
  p = p.replace(/^https?:\/\/[^/]+/, "");         // absolute -> path
  p = p.replace(/\/+$/, "") || "/";
  p = p.replace(/:[A-Za-z_][\w]*/g, "*");         // :id  -> *
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/\/{2,}/g, "/");
}
