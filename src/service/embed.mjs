// Embedding provider. Two backends behind one function:
//   EMBED_PROVIDER=local   @huggingface/transformers on this machine. No key. Model weights are
//                          fetched from the Hugging Face hub once (~34 MB) into EMBED_CACHE_DIR.
//   EMBED_PROVIDER=openai  any /v1/embeddings endpoint (Slingring TEXT_EMBED_3_LARGE when the key allows it).
import os from "node:os";
import path from "node:path";

const cfg = () => ({
  provider: process.env.EMBED_PROVIDER || "local",
  model: process.env.EMBED_MODEL || "Xenova/bge-small-en-v1.5",
  base: process.env.EMBED_BASE_URL || process.env.LLM_BASE_URL,
  key: process.env.EMBED_API_KEY || process.env.LLM_API_KEY,
  dims: Number(process.env.EMBED_DIMS || 384),
});

// bge models want this prefix on the QUESTION side only.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const embedModelId = () => `${cfg().provider}:${cfg().model}`;
export const embedDims = () => cfg().dims;

let pipe = null;
async function local(texts) {
  if (!pipe) {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = process.env.EMBED_CACHE_DIR || path.join(os.homedir(), ".cache", "procol-ckg-models");
    pipe = await pipeline("feature-extraction", cfg().model, { dtype: "q8" });
  }
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await pipe(texts.slice(i, i + 32), { pooling: "cls", normalize: true });
    out.push(...t.tolist());
  }
  return out;
}

async function remote(texts) {
  const c = cfg();
  const r = await fetch(`${c.base.replace(/\/$/, "")}/embeddings`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
    body: JSON.stringify({ model: c.model, input: texts }) });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

/** embed(texts, {isQuery}) -> number[][]  (unit-normalized) */
export async function embed(texts, { isQuery = false } = {}) {
  const c = cfg();
  const input = isQuery && c.provider === "local" ? texts.map(t => QUERY_PREFIX + t) : texts;
  return c.provider === "local" ? local(input) : remote(input);
}

export const toPgVector = (v) => `[${v.map(x => Number(x).toFixed(7)).join(",")}]`;
