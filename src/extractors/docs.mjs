// PER-BLOB extractor: human-written documentation inside the repos (README, docs/**, ai-review/**, service
// READMEs). Business logic lives here that no parser can see in code. Each file becomes a DOCUMENT node,
// its text is chunked by heading for semantic retrieval, and every code identifier it names becomes a
// MENTIONS edge to the matching graph node (filtered at load to nodes that exist).
export const NAME = "docs";
export const VERSION = "1.0";

// Skipped: changelogs (release noise), CI/templates, and docs about WRITING TESTS or AI code review -- they
// describe how engineers work, not how the product behaves, and they matched everything weakly.
const SKIP = /(^|\/)(CHANGELOG|CHANGES|HISTORY|LICENSE|CODE_OF_CONDUCT)[^/]*$|node_modules\/|(^|\/)\.github\/|(^|\/)\.gitlab\/|(^|\/)robots\.txt$|(^|\/)\.claude\/|^spec\/|^test\/|^ai-review\/(spec-|comprehensive-testing|playwright|review-rules|instructions\/)/i;
export function handles(p) {
  return /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(p) && !SKIP.test(p);
}

const MAX_CHUNK_WORDS = 350, MIN_CHUNK_WORDS = 40;
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Split markdown into heading-scoped passages; long sections are cut into ~350-word pieces. */
export function chunk(text) {
  const lines = text.split("\n");
  const sections = [];                          // {path:[h1,h2..], lines:[]}
  let cur = { path: [], lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) {
      if (cur.lines.some(l => l.trim())) sections.push(cur);
      const level = m[1].length; const title = m[2].replace(/[*_`]/g, "").trim();
      cur = { path: [...cur.path.slice(0, level - 1), title], lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.some(l => l.trim())) sections.push(cur);

  const out = [];
  const push = (path, body) => { const t = body.trim(); if (t) out.push({ heading_path: path.join(" > "), text: t, words: words(t) }); };
  for (const s of sections) {
    const body = s.lines.join("\n");
    if (words(body) <= MAX_CHUNK_WORDS) { push(s.path, body); continue; }
    let buf = [], n = 0;                          // cut long sections at paragraph boundaries
    for (const para of body.split(/\n\s*\n/)) {
      const w = words(para);
      if (n + w > MAX_CHUNK_WORDS && buf.length) { push(s.path, buf.join("\n\n")); buf = []; n = 0; }
      buf.push(para); n += w;
    }
    if (buf.length) push(s.path, buf.join("\n\n"));
  }
  // merge tiny fragments ONLY with a predecessor under the same heading (pieces of one long section).
  // A short section with its own heading stays its own chunk: the heading is the retrieval signal.
  const merged = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (prev && c.words < MIN_CHUNK_WORDS && prev.heading_path === c.heading_path && prev.words + c.words <= MAX_CHUNK_WORDS) {
      prev.text += `\n\n${c.text}`; prev.words += c.words;
    } else merged.push({ ...c });
  }
  return merged.map((c, i) => ({ ordinal: i, ...c }));
}

/** Identifiers a doc names: Ruby constants (Api::V1::Trade, FxResponse), snake_case names (approval_flows), Class#method. */
export function mentions(text) {
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  // a Ruby constant: any namespaced path (Api::V1::Trade, T::Sig) or a single CamelCase word with 2+ humps (FxResponse)
  for (const m of text.matchAll(/\b((?:[A-Z][A-Za-z0-9]*::)+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)(?:([#.])([a-z_][a-z0-9_]*[?!]?))?/g)) {
    bump(`const:${m[1]}`); if (m[3]) bump(`method:${m[1]}${m[2]}${m[3]}`);
  }
  for (const m of text.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)) bump(`snake:${m[1]}`);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, n]) => ({ key: k, n }));
}

export function extract(buf, p) {
  const text = buf.toString("utf8");
  const title = (text.match(/^#\s+(.+?)\s*$/m)?.[1] || p.split("/").pop().replace(/\.[^.]+$/, "")).replace(/[*_`]/g, "").trim();
  const chunks = chunk(text);
  return { schema: 1, title, words: words(text), chunks, mentions: mentions(text) };
}

export function resolve(facts, file, ctx) {
  const entities = [], edges = [];
  if (!facts?.chunks) return { entities, edges };
  const fqn = `doc:${file.path}`;
  entities.push({ fqn, kind: "DOCUMENT", name: facts.title, path: file.path, blobSha: file.blobSha,
                  startLine: 1, endLine: null,
                  attrs: { subkind: file.path.split("/")[0] === "docs" ? "design_doc" : /readme/i.test(file.path) ? "readme" : /ai-review/.test(file.path) ? "scenarios" : "doc",
                           chunks: facts.chunks.length, words: facts.words, headings: facts.chunks.map(c => c.heading_path).filter((h, i, a) => h && a.indexOf(h) === i).slice(0, 30) },
                  status: "OBSERVED", extractor: `${NAME}@${VERSION}`, confidence: 1.0, resolution: "DOCUMENTED" });
  // MENTIONS: doc -> the code it names. Targets that do not exist in this commit are dropped at load time.
  for (const { key, n } of facts.mentions || []) {
    const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const targets = kind === "const" ? [`be:sym:${name}`]
                  : kind === "method" ? [`be:sym:${name}`]
                  : kind === "snake" ? [`be:table:${name}`, `be:sym:${name}`] : [];
    for (const t of targets)
      edges.push({ kind: "MENTIONS", srcFqn: fqn, dstFqn: t, siteHash: ctx.siteHash(`${fqn}|${t}`), startLine: null,
                   confidence: Math.min(0.95, 0.6 + n * 0.05), resolution: "DOCUMENTED", attrs: { times: n } });
  }
  return { entities, edges };
}
