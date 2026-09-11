// The Ruby symbol extractor: identities must match the graph's fqn scheme exactly, because runtime
// edges, summaries and embeddings hang off them. Pure functions, no database, no clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as beAst from "../src/extractors/be-ast.mjs";

const ctx = { siteHash: (k) => Buffer.from(String(k)) };
const run = (src, path = "app/models/x.rb") => {
  const facts = beAst.extract(Buffer.from(src), path);
  return { facts, ...beAst.resolve(facts, { path, blobSha: null }, ctx) };
};
const names = (r) => r.entities.map(e => `${e.attrs.subkind}:${e.name}`);

test("classes, modules, instance and class methods get the import's fqn scheme", () => {
  const r = run(`module Api\n  class TradeController < ApplicationController\n    include Pundit\n    def quote_details; end\n    def self.k; end\n    class << self\n      def z; end\n    end\n  end\nend\n`);
  assert.equal(r.facts.parser, "ast");
  assert.deepEqual(names(r), [
    "module:Api", "class:Api::TradeController",
    "method:Api::TradeController#quote_details",
    "class_method:Api::TradeController.k", "class_method:Api::TradeController.z",
  ]);
  const cls = r.entities.find(e => e.name === "Api::TradeController");
  assert.equal(cls.attrs.superclass, "ApplicationController");
  assert.deepEqual(cls.attrs.mixins, ["include:Pundit"]);
  assert.ok(r.entities.every(e => e.fqn === `be:sym:${e.name}` && e.kind === "SYMBOL" && e.resolution === "EXACT"));
  assert.ok(r.entities.every(e => e.startLine > 0 && e.endLine >= e.startLine));
});

test("class << self inside `included do` yields CLASS methods (the bootstrap dump got this wrong)", () => {
  const r = run(`module ModelCachingHelper\n  extend ActiveSupport::Concern\n  included do\n    class << self\n      def all_cached; end\n    end\n  end\nend\n`);
  assert.ok(names(r).includes("class_method:ModelCachingHelper.all_cached"));
  assert.ok(!names(r).some(n => n.includes("#all_cached")));
});

test("class -> method DECLARES uses the import's hash so nothing duplicates; controllers also bridge to their HANDLER", () => {
  const r = run(`module Api\n  module V1\n    class ApprovalWorkflowController < Base\n      def resolve_approval; end\n    end\n  end\nend\n`);
  const sym = "be:sym:Api::V1::ApprovalWorkflowController#resolve_approval";
  const decl = r.edges.filter(e => e.kind === "DECLARES");
  assert.ok(decl.some(e => e.srcFqn === "be:sym:Api::V1::ApprovalWorkflowController" && e.dstFqn === sym
                        && e.siteHash.toString() === `Api::V1::ApprovalWorkflowController|${sym}`));
  assert.ok(decl.some(e => e.srcFqn === "be:api/v1/approval_workflow#resolve_approval" && e.dstFqn === sym));
});

test("Ruby 3 syntax the local Ruby cannot parse falls back to the line scanner, marked HEURISTIC", () => {
  const r = run(`class Fx\n  def a(x) = x + 1\n  private_class_method def self.b; end\n  def c\n    q = <<~SQL\nselect 1\n    SQL\n  end\nend\n`);
  if (r.facts.parser === "ast") return;          // a modern Ruby parsed it natively; nothing to prove here
  assert.equal(r.facts.parser, "regex");
  assert.deepEqual(names(r), ["class:Fx", "method:Fx#a", "class_method:Fx.b", "method:Fx#c"]);
  assert.ok(r.entities.every(e => e.resolution === "HEURISTIC" && e.confidence < 1));
});

test("heredoc text at column 0 does not close the enclosing module in the fallback scanner", () => {
  const src = `module M\n  def a\n    x = <<~SQL\nselect 1\nend_marker\n    SQL\n  end\n  def b(y) = y\n  def c; end\nend\n`;
  const r = run(src);
  const ms = names(r).filter(n => n.startsWith("method:"));
  assert.deepEqual(ms, ["method:M#a", "method:M#b", "method:M#c"]);
});

test("top-level script methods have no owner and are dropped (they collide across files)", () => {
  const r = run(`require 'csv'\ndef extract_fund_center(x); end\nclass Tool\n  def run; end\nend\n`, "scripts/download_tr_matrix.rb");
  assert.deepEqual(names(r), ["class:Tool", "method:Tool#run"]);
});

test("handles() mirrors what the bootstrap dump covered", () => {
  for (const p of ["app/models/bid.rb", "lib/modules/x.rb", "db/migrate/1_a.rb", "scripts/customer/a.rb", "mcp_tools/erfx/t.rb"]) assert.ok(beAst.handles(p), p);
  for (const p of ["spec/models/bid_spec.rb", "config/routes.rb", "app/views/x.rb", "vendor/x.rb", "app/models/bid.js"]) assert.ok(!beAst.handles(p), p);
});

test("static CALLS edges are off unless CKG_STATIC_CALLS=1", () => {
  const src = `class A\n  def go\n    B.run(1)\n  end\nend\n`;
  delete process.env.CKG_STATIC_CALLS;
  assert.equal(run(src).edges.filter(e => e.kind === "CALLS").length, 0);
  process.env.CKG_STATIC_CALLS = "1";
  const on = run(src).edges.filter(e => e.kind === "CALLS");
  delete process.env.CKG_STATIC_CALLS;
  assert.equal(on.length, 1);
  assert.equal(on[0].dstFqn, "be:sym:B.run");
  assert.equal(on[0].resolution, "HEURISTIC");
});
