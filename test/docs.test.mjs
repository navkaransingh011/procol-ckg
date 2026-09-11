import { test } from "node:test";
import assert from "node:assert/strict";
import * as docs from "../src/extractors/docs.mjs";

const ctx = { siteHash: (k) => Buffer.from(String(k)) };
const md = `# Rule Engine — Complete Documentation

**Status:** core done.

## 1. Executive Summary

The Rule Engine evaluates rules against any ActiveRecord model. FxResponse rows are matched via rule_group_mappings.

## 2. Design Philosophy

Generic by design.

### How it differs

The current validations live on fx_datasource_fields. See Api::V1::TradeController#quote_details and CustomConfiguration.cached_all_configs.

\`\`\`
# not a heading: inside a fence
\`\`\`
`;

test("handles() takes docs and READMEs, not changelogs or CI files", () => {
  for (const p of ["README.md", "docs/flexi-module/rule-engine.md", "app/workers/Readme.md", "ai-review/product-scenarios.md", "docs/notes.txt"]) assert.ok(docs.handles(p), p);
  for (const p of ["CHANGELOG.md", "node_modules/x/README.md", ".github/PULL_REQUEST_TEMPLATE.md", "public/robots.txt", "app/models/bid.rb"]) assert.ok(!docs.handles(p), p);
});

test("chunks follow headings, keep the heading path, and ignore # inside code fences", () => {
  const f = docs.extract(Buffer.from(md), "docs/rule-engine.md");
  assert.equal(f.title, "Rule Engine — Complete Documentation");
  const paths = f.chunks.map(c => c.heading_path);
  assert.ok(paths.includes("Rule Engine — Complete Documentation > 1. Executive Summary"), JSON.stringify(paths));
  assert.ok(paths.some(p => p.endsWith("2. Design Philosophy > How it differs")), JSON.stringify(paths));
  assert.ok(!paths.some(p => /not a heading/.test(p)));
  assert.ok(f.chunks.every(c => c.words > 0 && typeof c.ordinal === "number"));
});

test("mentions find constants, methods and snake_case names; resolve turns them into MENTIONS edges", () => {
  const f = docs.extract(Buffer.from(md), "docs/rule-engine.md");
  const keys = f.mentions.map(m => m.key);
  for (const k of ["const:FxResponse", "const:Api::V1::TradeController", "method:Api::V1::TradeController#quote_details", "method:CustomConfiguration.cached_all_configs", "snake:rule_group_mappings", "snake:fx_datasource_fields"]) assert.ok(keys.includes(k), k);
  const r = docs.resolve(f, { path: "docs/rule-engine.md", blobSha: null }, ctx);
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].kind, "DOCUMENT"); assert.equal(r.entities[0].fqn, "doc:docs/rule-engine.md"); assert.equal(r.entities[0].resolution, "DOCUMENTED");
  assert.equal(r.entities[0].attrs.subkind, "design_doc");
  const dst = r.edges.map(e => e.dstFqn);
  assert.ok(dst.includes("be:sym:FxResponse") && dst.includes("be:table:rule_group_mappings") && dst.includes("be:sym:Api::V1::TradeController#quote_details"));
  assert.ok(r.edges.every(e => e.kind === "MENTIONS" && e.srcFqn === "doc:docs/rule-engine.md"));
});

test("long sections are cut at paragraph boundaries near 350 words", () => {
  const para = "word ".repeat(120).trim();
  const long = `# T\n\n## Big\n\n${[para, para, para, para, para].join("\n\n")}\n`;
  const f = docs.extract(Buffer.from(long), "docs/big.md");
  assert.ok(f.chunks.length >= 2, `got ${f.chunks.length}`);
  assert.ok(f.chunks.every(c => c.words <= 360));
});
