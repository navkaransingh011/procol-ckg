// PER-BLOB extractor: frontend HTTP call sites.
// Depends ONLY on this file's bytes -- which is what makes it cacheable by blob SHA.
//
// v0.1 is regex-based on purpose: it exists to prove the pipeline end to end and to
// produce real coverage numbers on day 1. When the Babel version lands, bump VERSION
// to "1.0-babel" and every blob re-extracts automatically. Nothing else changes.

export const NAME = "fe-http";
export const VERSION = "0.1-regex";

// Tests call the same XHR wrapper against mocked paths. Indexing them mints
// HTTP_CALL_SITE nodes and TARGETS edges indistinguishable from production call
// sites, so a trace would claim a screen calls an endpoint it only calls in a test.
const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?)\/|\.(test|spec|stories)\.[jt]sx?$/i;

export function handles(path) {
  return /\.(js|jsx)$/.test(path) && !path.includes("node_modules") && !TEST_PATH.test(path);
}

const CALL = /promisifiedXHR\s*\(/g;

function classify(arg) {
  const a = arg.trim();
  if (a.startsWith("`")) return "TEMPLATE";
  if (a.startsWith('"') || a.startsWith("'")) return "LITERAL";
  if (/^[A-Za-z_$][\w$]*$/.test(a)) return "IDENTIFIER";
  return "OTHER";
}

/** Template literal -> path template: static parts kept, every ${...} becomes '*'. */
function foldTemplate(raw) {
  const inner = raw.slice(1, -1);
  return inner.replace(/\$\{[^}]*\}/g, "*");
}

function readArg(src, openIdx) {
  // Walk to the matching paren, tracking nesting and strings, and split the first arg.
  let depth = 0, i = openIdx, quote = null, argStart = openIdx + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(argStart, i);
    } else if (c === "," && depth === 1) {
      return src.slice(argStart, i);
    }
  }
  return null;
}

export function extract(buf, path) {
  const src = buf.toString("utf8");
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; lineStarts[mid] <= idx ? (lo = mid) : (hi = mid - 1); }
    return { line: lo + 1, col: idx - lineStarts[lo] };
  };

  const callSites = [];
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(src)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const arg = readArg(src, openIdx);
    if (arg === null) continue;
    const shape = classify(arg);
    const { line, col } = lineOf(m.index);

    // Second arg is the HTTP verb in this codebase's convention.
    const after = src.slice(openIdx, openIdx + 400);
    const verbMatch = after.match(/,\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i);

    callSites.push({
      line, col,
      method: verbMatch ? verbMatch[1].toUpperCase() : null,
      shape,
      raw: arg.trim().slice(0, 200),
      pathTemplate:
        shape === "LITERAL"  ? arg.trim().slice(1, -1) :
        shape === "TEMPLATE" ? foldTemplate(arg.trim()) : null,
    });
  }

  const exports = [...src.matchAll(/export\s+(?:const|function|default|class)\s+([\w$]+)/g)]
    .map((x) => x[1]);

  return { schema: 1, path, callSites, exports, bytes: buf.length };
}

export function resolve(facts, file, ctx) {
  const entities = [], edges = [];
  for (const cs of facts?.callSites ?? []) {
    const resolved = cs.pathTemplate !== null;
    const fqn = `fe:${file.path}#L${cs.line}`;
    entities.push({
      fqn, kind: "HTTP_CALL_SITE", name: null, path: file.path, blobSha: file.blobSha,
      startLine: cs.line, endLine: cs.line,
      attrs: { method: cs.method, shape: cs.shape, raw: cs.raw, pathTemplate: cs.pathTemplate },
      status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
      confidence: resolved ? 0.95 : 0.4,
      // The "I don't know" node is a first-class citizen. Omitting these is what
      // loses an engineer's trust; keeping them is what earns it.
      resolution: resolved ? "EXACT" : "AMBIGUOUS",
    });
    if (!resolved) continue;
    const norm = ctx.normalizeEndpoint(cs.pathTemplate);
    const epFqn = `${cs.method ?? "ANY"} ${norm}`;
    entities.push({
      fqn: epFqn, kind: "HTTP_ENDPOINT", name: norm, path: null, blobSha: null,
      startLine: null, endLine: null, attrs: { method: cs.method, normalized: norm },
      status: "OBSERVED", extractor: `${NAME}@${VERSION}`,
      confidence: 1.0, resolution: "EXACT", repoAgnostic: true,
    });
    edges.push({ kind: "TARGETS", srcFqn: fqn, dstFqn: epFqn,
                 siteHash: ctx.siteHash(`${file.path}:${cs.line}:${cs.col}:TARGETS`),
                 startLine: cs.line, confidence: 0.95, resolution: "EXACT" });
  }
  return { entities, edges };
}
