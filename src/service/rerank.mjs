// Cross-encoder reranking. The embedding search (bge-small) is a blunt first pass: on this index a passage that
// answers the question and one that merely mentions the same nouns can score 0.70 and 0.69. A cross-encoder reads the
// question and ONE candidate together and answers "does this address the question", which separates the two.
// It is too slow for 27k rows, so the pipeline is: vector (and full-text) fetch the top ~30, this reorders them, the
// writer sees the best few. Runs locally through @huggingface/transformers, no key, weights fetched once into the
// same cache as the embedder. If the model cannot be loaded (offline VM, first run without network) reranking is
// skipped and the vector order stands -- the answer degrades, never fails.
//
//   CKG_RERANK=0                 turn it off
//   CKG_RERANK_MODEL=<hub id>    default Xenova/ms-marco-MiniLM-L-6-v2 (22M params, ~10 ms a pair on a laptop);
//                                Xenova/bge-reranker-base is stronger and ~10x slower
import os from "node:os";
import path from "node:path";

const cfg = () => ({ enabled: process.env.CKG_RERANK !== "0", model: process.env.CKG_RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2" });
export const rerankModelId = () => (cfg().enabled ? cfg().model : null);

let loaded = null, failed = null;
async function load() {
  if (loaded) return loaded;
  if (failed && Date.now() - failed < 10 * 60_000) return null;   // do not retry a missing model on every question
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
    env.cacheDir = process.env.EMBED_CACHE_DIR || path.join(os.homedir(), ".cache", "procol-ckg-models");
    const id = cfg().model;
    const [tokenizer, model] = await Promise.all([AutoTokenizer.from_pretrained(id), AutoModelForSequenceClassification.from_pretrained(id, { dtype: "q8" })]);
    loaded = { tokenizer, model };
    failed = null;
    return loaded;
  } catch (e) {
    failed = Date.now();
    console.error(`[rerank] ${cfg().model} unavailable, vector order kept: ${String(e.message).slice(0, 160)}`);
    return null;
  }
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * rerank(question, items, textOf, { top, batch }) -> items with `rerank` (0..1 probability that the item addresses
 * the question), best first, cut to `top`. `textOf(item)` gives the text to judge. When reranking is off or the model
 * is unavailable, the items come back unchanged (rerank: null) and uncut beyond `top`.
 */
export async function rerank(question, items, textOf, { top = 8, batch = 16, max_length = 384 } = {}) {
  if (!items?.length) return [];
  if (!cfg().enabled) return items.slice(0, top).map(x => ({ ...x, rerank: null }));
  const m = await load();
  if (!m) return items.slice(0, top).map(x => ({ ...x, rerank: null }));
  const scores = new Array(items.length);
  for (let i = 0; i < items.length; i += batch) {
    const slice = items.slice(i, i + batch);
    const texts = slice.map(x => String(textOf(x) || "").slice(0, 2000));
    const inputs = m.tokenizer(slice.map(() => question), { text_pair: texts, padding: true, truncation: true, max_length });
    const out = await m.model(inputs);
    const logits = out.logits;                                  // [n, 1] for a relevance cross-encoder
    const data = Array.from(logits.data);
    const width = data.length / slice.length;
    for (let j = 0; j < slice.length; j++) scores[i + j] = sigmoid(width === 1 ? data[j] : data[j * width + (width - 1)]);
  }
  return items.map((x, i) => ({ ...x, rerank: Number(scores[i].toFixed(4)) })).sort((a, b) => b.rerank - a.rerank).slice(0, top);
}

/** Reciprocal-rank fusion of several ranked lists into one; `key` identifies the same item across lists. */
export function fuse(lists, key, { k = 60 } = {}) {
  const score = new Map(), item = new Map();
  for (const list of lists) list.forEach((x, rank) => { const id = key(x); score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1)); if (!item.has(id)) item.set(id, x); });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ ...item.get(id), fused: Number(s.toFixed(5)) }));
}

/** Release the native session; without it process.exit can abort with "mutex lock failed" on macOS. */
export async function disposeReranker() { try { await loaded?.model?.dispose?.(); } catch { /* already gone */ } loaded = null; }
