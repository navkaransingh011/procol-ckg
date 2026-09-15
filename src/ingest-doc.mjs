#!/usr/bin/env node
// Ingest an EXTERNAL document (PRD, process doc, Notion export, PDF, Word) into the code graph database.
// The document becomes a commit-less DOCUMENT node (visible under every branch), its text is chunked and
// embedded for semantic retrieval, and every code identifier it names is linked with MENTIONS edges to
// the current main commits -- so answers can compare what the doc says with what the code does.
//
//   node --env-file=.env src/ingest-doc.mjs --file "Approval Policy.docx" --title "Approval policy" \
//        --tags approvals,workflow --owner "CS team" --url "https://notion.so/..." [--replace]
//   node --env-file=.env src/ingest-doc.mjs --file ... --replace --if-changed   # idempotent: skip when text+metadata are unchanged
//   Ship a PRD WITH the code it describes (linked to exactly the files that commit/PR changed):
//   node --env-file=.env src/ingest-doc.mjs --file prd.md --repo procol-backend --commit <sha> [--files a.rb,b.rb | --repo-dir ../procol-backend] [--pr 512 --url <pr or prd url>]
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
    const slug = arg("delete"); const fqn = slug.startsWith("doc:") ? slug : `doc:upload/${slug}`;   // upload slug, or a full fqn (doc:commit/<sha12>/<slug>)
    const [e] = await q(`select id from ckg.entities where fqn=$1 and kind='DOCUMENT' and extractor='ingest-doc@1.0'`, [fqn]);
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
  const fqn = arg("commit", null) ? `doc:commit/${arg("commit").slice(0, 12)}/${slug}` : `doc:upload/${slug}`;
  const pathInGraph = arg("commit", null) ? `docs/prd/${slug}.md` : `uploads/${slug}.md`;
  const facts = docs.extract(Buffer.from(text), pathInGraph);
  // flags win; otherwise YAML front matter (title/feature/jira/owner/status/tags) fills the metadata
  const meta = facts.meta || {};
  const tags = [...new Set([...(arg("tags", "") || "").split(",").map(s => s.trim()).filter(Boolean), ...(meta.tags || []), ...(meta.feature ? [meta.feature] : [])])];
  const blobSha = createHash("sha1").update(text).digest("hex");

  const [existing] = await q(`select id, encode(blob_sha,'hex') as sha, attrs from ckg.entities where fqn=$1 and kind='DOCUMENT' and commit_sha is null`, [fqn]);
  if (existing && !has("replace")) throw new Error(`${fqn} already exists; pass --replace to overwrite`);
  // --if-changed: the deploy re-runs the whole set on every release; unchanged documents cost one SELECT.
  if (existing && has("if-changed")) {
    const same = existing.sha === blobSha && existing.attrs?.title === title && existing.attrs?.owner === arg("owner", meta.owner || null)
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

  // --commit: the document belongs to THIS commit of THIS repo (visible in that branch's history like code), and is
  // linked by DESCRIBES to every node of that commit living in the files the commit changed (from --files or git).
  const commitSha = arg("commit", null); const repoName = arg("repo", null);
  let repoId = null, changed = null;
  if (commitSha) {
    if (!repoName) throw new Error("--commit needs --repo <procol-backend|procol-client-dashboard|web-bidding>");
    const [rp] = await q(`select id from ckg.repos where name=$1`, [repoName]); if (!rp) throw new Error(`unknown repo ${repoName}`);
    repoId = rp.id;
    const [cm] = await q(`select 1 from ckg.commits where repo_id=$1 and sha=decode($2,'hex')`, [repoId, commitSha]);
    if (!cm) throw new Error(`commit ${commitSha.slice(0, 8)} of ${repoName} is not indexed yet -- index it first, then attach the document`);
    if (arg("files", null)) changed = arg("files").split(",").map(x => x.trim()).filter(Boolean);
    else if (arg("repo-dir", null)) { const { execFileSync } = await import("node:child_process"); changed = execFileSync("git", ["-C", arg("repo-dir"), "show", "--name-only", "--format=", commitSha], { encoding: "utf8" }).split("\n").filter(Boolean); }
    else throw new Error("--commit needs --files <a,b,..> or --repo-dir <clone> so the changed files are known");
  }
  const attrs = { source: arg("source", commitSha ? (arg("pr", null) ? "pr" : "commit") : "upload"), subkind: commitSha ? "prd" : "business_doc", title, tags, owner: arg("owner", meta.owner || null), url: arg("url", meta.prd || meta.url || null),
                  ...(meta.feature ? { feature: meta.feature } : {}), ...(meta.jira ? { jira: meta.jira } : {}), ...(meta.status ? { status: meta.status } : {}),
                  ...(commitSha ? { commit: commitSha, repo: repoName, pr: arg("pr", null), changed_files: changed } : {}),
                  original_file: path.basename(file), chunks: facts.chunks.length, words: facts.words,
                  headings: facts.chunks.map(c => c.heading_path).filter((h, i, a) => h && a.indexOf(h) === i).slice(0, 40), mentions: facts.mentions, ingested_at: new Date().toISOString() };
  const [ent] = await q(`insert into ckg.entities (repo_id, commit_sha, kind, fqn, name, path, blob_sha, start_line, attrs, status, extractor, confidence, resolution)
                          values ($6, $7, 'DOCUMENT', $1, $2, $3, $4, 1, $5, 'OBSERVED', 'ingest-doc@1.0', 1.0, 'DOCUMENTED') returning id`,
                        [fqn, title, pathInGraph, hex(blobSha), JSON.stringify(attrs), repoId, commitSha ? hex(commitSha) : null]);
  const linked = commitSha ? await linkDocMentions(ent.id, facts.mentions, { repoId, commitSha }) : await linkDocMentions(ent.id, facts.mentions);
  // DESCRIBES: by diff. Every node of this commit that lives in a changed file.
  let described = 0;
  if (commitSha && changed?.length) {
    const nodes = await q(`select id, path from ckg.entities where repo_id=$1 and commit_sha=decode($2,'hex') and path = any($3::text[]) and kind in ('FILE','SYMBOL','HANDLER','DB_TABLE','HTTP_CALL_SITE','SERVER_ROUTE')`, [repoId, commitSha, changed]);
    for (let i = 0; i < nodes.length; i += 500) {
      const b = nodes.slice(i, i + 500);
      await q(`insert into ckg.edges (repo_id, commit_sha, kind, src_entity_id, dst_entity_id, site_hash, status, extractor, confidence, resolution)
               select $1, decode($2,'hex'), 'DESCRIBES', $3, u.dst, u.site, 'OBSERVED', 'ingest-doc@1.0', 0.95, 'DOCUMENTED'
                 from unnest($4::bigint[], $5::bytea[]) as u(dst, site) on conflict do nothing`,
              [repoId, commitSha, ent.id, b.map(n => n.id), b.map(n => hex(createHash("sha1").update(`describes:${ent.id}|${n.id}`).digest("hex")))]);
      described += b.length;
    }
  }

  // embed the chunks now (heading + text), so the doc is searchable immediately
  const model = embedModelId();
  const todo = await q(`select ordinal, heading_path, text from ckg.doc_chunks where blob_sha=$1 and (embedding is null or model<>$2) order by ordinal`, [hex(blobSha), model]);
  for (let i = 0; i < todo.length; i += 64) {
    const b = todo.slice(i, i + 64);
    const vecs = await embed(b.map(c => `${title} > ${c.heading_path}\n${c.text}`));
    for (let j = 0; j < b.length; j++) await q(`update ckg.doc_chunks set embedding=$3::vector, model=$4 where blob_sha=$1 and ordinal=$2`, [hex(blobSha), b[j].ordinal, toPgVector(vecs[j]), model]);
  }
  // the document's own card, so it is a candidate by meaning like any other node
  try { const [vec] = await embed([`Documentation: ${title}. ${facts.chunks.slice(0, 3).map(c => c.heading_path).join("; ")}.${tags.length ? ` Tags: ${tags.join(", ")}.` : ""}`]);
        await q(`insert into ckg.embeddings (entity_id, model, dims, text_hash, card, embedding) values ($1,$2,$3,decode(md5($4),'hex'),$4,$5::vector) on conflict (entity_id, model) do update set card=excluded.card, embedding=excluded.embedding`,
                [ent.id, model, vec.length, `doc-card:${fqn}:${blobSha}`, toPgVector(vec)]); } catch { /* card is a nicety */ }
  console.log(`ingested ${fqn}\n  title    ${title}\n  chunks   ${facts.chunks.length} (${facts.words} words)\n  linked   ${linked} code mentions${commitSha ? `\n  describes ${described} nodes changed in ${repoName}@${commitSha.slice(0, 8)} (${changed?.length || 0} files)` : ""}\n  tags     ${tags.join(", ") || "-"}\n  embedded ${todo.length} passages with ${model}`);
}
main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); process.exit(1); });
