#!/usr/bin/env node
// Ingest an EXTERNAL document (PRD, process doc, Notion export, PDF, Word) into the code graph database.
// The document becomes a commit-less DOCUMENT node (visible under every branch), its text is chunked and
// embedded for semantic retrieval, and every code identifier it names is linked with MENTIONS edges to
// the current main commits -- so answers can compare what the doc says with what the code does.
//
//   node --env-file=.env src/ingest-doc.mjs --file "Approval Policy.docx" --title "Approval policy" \
//        --tags approvals,workflow --owner "CS team" --url "https://notion.so/..." [--replace]
//   node --env-file=.env src/ingest-doc.mjs --file ... --replace --if-changed   # idempotent: skip when text+metadata are unchanged
//   node --env-file=.env src/ingest-doc.mjs --list
//   node --env-file=.env src/ingest-doc.mjs --delete approval-policy
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { q, pool, hex } from "./db.mjs";
import * as docs from "./extractors/docs.mjs";
import { linkDocMentions } from "./doclink.mjs";
import { embed, embedModelId, toPgVector } from "./service/embed.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

async function toMarkdown(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = readFileSync(file);
  if ([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"].includes(ext)) return buf.toString("utf8");
  if (ext === ".pdf") { const pdf = (await import("pdf-parse")).default; const r = await pdf(buf); return r.text; }
  if (ext === ".docx") { const mammoth = await import("mammoth"); const r = await mammoth.convertToMarkdown({ buffer: buf }); return r.value; }
  if (ext === ".html" || ext === ".htm") return buf.toString("utf8").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n" + "#".repeat(Number(n)) + " ").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  throw new Error(`unsupported file type ${ext}; export it as .md, .txt, .docx, .pdf or .html`);
}


async function main() {
  if (has("list")) {
    const rows = await q(`select e.id, e.fqn, e.name, e.attrs->>'source' source, e.attrs->'tags' tags, e.attrs->>'owner' owner, (e.attrs->>'chunks')::int chunks, e.attrs->>'ingested_at' ingested_at
                            from ckg.entities e where e.kind='DOCUMENT' and e.commit_sha is null order by e.attrs->>'ingested_at' desc`);
    for (const r of rows) console.log(`${String(r.id).padStart(6)}  ${r.fqn.padEnd(40)} ${String(r.chunks).padStart(3)} chunks  tags=${JSON.stringify(r.tags)}  owner=${r.owner || "-"}  ${r.name}`);
    if (!rows.length) console.log("no uploaded documents yet"); return;
  }
  if (has("delete")) {
    const slug = arg("delete"); const fqn = `doc:upload/${slug}`;
    const [e] = await q(`select id from ckg.entities where fqn=$1 and kind='DOCUMENT' and commit_sha is null`, [fqn]);
    if (!e) throw new Error(`no uploaded document ${fqn}`);
    await q(`delete from ckg.edges where src_entity_id=$1 or dst_entity_id=$1`, [e.id]);
    await q(`delete from ckg.embeddings where entity_id=$1`, [e.id]);
    await q(`delete from ckg.entities where id=$1`, [e.id]);
    console.log(`deleted ${fqn} (chunks are content-addressed and kept; harmless)`); return;
  }
  const file = arg("file"); if (!file) throw new Error("--file is required (or --list / --delete <slug>)");
  const text = (await toMarkdown(file)).replace(/\r\n/g, "\n");
  const title = arg("title", null) || text.match(/^#\s+(.+?)\s*$/m)?.[1] || path.basename(file).replace(/\.[^.]+$/, "");
  const slug = slugify(arg("slug", title));
  const fqn = `doc:upload/${slug}`;
  const pathInGraph = `uploads/${slug}.md`;
  const tags = (arg("tags", "") || "").split(",").map(s => s.trim()).filter(Boolean);
  const facts = docs.extract(Buffer.from(text), pathInGraph);
  const blobSha = createHash("sha1").update(text).digest("hex");

  const [existing] = await q(`select id, encode(blob_sha,'hex') as sha, attrs from ckg.entities where fqn=$1 and kind='DOCUMENT' and commit_sha is null`, [fqn]);
  if (existing && !has("replace")) throw new Error(`${fqn} already exists; pass --replace to overwrite`);
  // --if-changed: the deploy re-runs the whole set on every release; unchanged documents cost one SELECT.
  if (existing && has("if-changed")) {
    const same = existing.sha === blobSha && existing.attrs?.title === title && existing.attrs?.owner === arg("owner", null)
              && existing.attrs?.url === arg("url", null) && JSON.stringify(existing.attrs?.tags || []) === JSON.stringify(tags);
    // ...but only if every passage is embedded under the CURRENT model; after an EMBED_PROVIDER/EMBED_MODEL
    // switch the text is unchanged yet the passages are invisible to search until re-embedded.
    const [{ stale }] = same ? await q(`select count(*)::int as stale from ckg.doc_chunks where blob_sha=$1 and (embedding is null or model<>$2)`, [hex(blobSha), embedModelId()]) : [{ stale: 0 }];
    if (same && stale === 0) { console.log(`unchanged ${fqn} (${existing.attrs?.chunks} chunks) — skipped`); return; }
    if (same) console.log(`re-embedding ${fqn}: ${stale} passages not under ${embedModelId()}`);
  }
  if (existing) { await q(`delete from ckg.edges where src_entity_id=$1 or dst_entity_id=$1`, [existing.id]); await q(`delete from ckg.embeddings where entity_id=$1`, [existing.id]); await q(`delete from ckg.entities where id=$1`, [existing.id]); }

  await q(`insert into ckg.blobs (blob_sha, size_bytes, lang) values ($1,$2,'md') on conflict do nothing`, [hex(blobSha), Buffer.byteLength(text)]);
  await q(`insert into ckg.blob_text (blob_sha, text, lines) values ($1,$2,$3) on conflict do nothing`, [hex(blobSha), text, text.split("\n").length]);
  for (const c of facts.chunks)
    await q(`insert into ckg.doc_chunks (blob_sha, ordinal, heading_path, text, words) values ($1,$2,$3,$4,$5) on conflict do nothing`, [hex(blobSha), c.ordinal, c.heading_path, c.text, c.words]);

  const attrs = { source: arg("source", "upload"), subkind: "business_doc", title, tags, owner: arg("owner", null), url: arg("url", null),
                  original_file: path.basename(file), chunks: facts.chunks.length, words: facts.words,
                  headings: facts.chunks.map(c => c.heading_path).filter((h, i, a) => h && a.indexOf(h) === i).slice(0, 40), mentions: facts.mentions, ingested_at: new Date().toISOString() };
  const [ent] = await q(`insert into ckg.entities (repo_id, commit_sha, kind, fqn, name, path, blob_sha, start_line, attrs, status, extractor, confidence, resolution)
                          values (null, null, 'DOCUMENT', $1, $2, $3, $4, 1, $5, 'OBSERVED', 'ingest-doc@1.0', 1.0, 'DOCUMENTED') returning id`,
                        [fqn, title, pathInGraph, hex(blobSha), JSON.stringify(attrs)]);
  const linked = await linkDocMentions(ent.id, facts.mentions);

  // embed the chunks now (heading + text), so the doc is searchable immediately
  const model = embedModelId();
  const todo = await q(`select ordinal, heading_path, text from ckg.doc_chunks where blob_sha=$1 and (embedding is null or model<>$2) order by ordinal`, [hex(blobSha), model]);
  for (let i = 0; i < todo.length; i += 64) {
    const b = todo.slice(i, i + 64);
    const vecs = await embed(b.map(c => `${title} > ${c.heading_path}\n${c.text}`));
    for (let j = 0; j < b.length; j++) await q(`update ckg.doc_chunks set embedding=$3::vector, model=$4 where blob_sha=$1 and ordinal=$2`, [hex(blobSha), b[j].ordinal, toPgVector(vecs[j]), model]);
  }
  console.log(`ingested ${fqn}\n  title    ${title}\n  chunks   ${facts.chunks.length} (${facts.words} words)\n  linked   ${linked} code mentions\n  tags     ${tags.join(", ") || "-"}\n  embedded ${todo.length} passages with ${model}`);
}
main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); process.exit(1); });
