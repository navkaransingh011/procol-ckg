#!/usr/bin/env ruby
# frozen_string_literal: true
# Ruby symbol extractor. Batch protocol: one JSON object per stdin line
#   {"id": "<blob sha>", "path": "app/models/x.rb", "b64": "<base64 source>"}
# emits one JSON line per input, in order:
#   {"id":..., "ok":true, "parser":"ast"|"regex", "symbols":[...], "calls":[...], "includes":{owner:[...]}}
#   {"id":..., "ok":false, "error":"..."}
# Uses RubyVM::AbstractSyntaxTree (stdlib, Ruby 2.6+). No gems. Files the running Ruby cannot parse
# (newer syntax) fall back to a line scanner that still recovers class/module/def declarations.
require 'json'
require 'base64'

Node = RubyVM::AbstractSyntaxTree::Node

def const_name(n)
  return nil unless n.is_a?(Node)
  case n.type
  when :CONST  then n.children[0].to_s
  when :COLON3 then n.children[0].to_s
  when :COLON2
    base = const_name(n.children[0])
    base ? "#{base}::#{n.children[1]}" : n.children[1].to_s
  else nil
  end
end

def join_ns(ns, name)
  return name if ns.empty?
  "#{ns.join('::')}::#{name}"
end

class Extractor
  def initialize
    @symbols = []; @calls = []; @includes = Hash.new { |h, k| h[k] = [] }
  end

  def run(root)
    walk(root, [], false, nil)
    { symbols: @symbols, calls: @calls, includes: @includes }
  end

  private

  def sym(kind, name, n, owner = nil, extra = {})
    @symbols << { kind: kind, name: name, owner: owner, line: n.first_lineno, end_line: n.last_lineno }.merge(extra)
  end

  def walk(n, ns, singleton, cur)
    return unless n.is_a?(Node)
    case n.type
    when :CLASS
      name = const_name(n.children[0]) || '?'
      full = join_ns(ns, name)
      sym('class', full, n, nil, superclass: const_name(n.children[1]))
      walk(n.children[2], ns + [name], false, nil)
    when :MODULE
      name = const_name(n.children[0]) || '?'
      full = join_ns(ns, name)
      sym('module', full, n)
      walk(n.children[1], ns + [name], false, nil)
    when :SCLASS
      recv = n.children[0]
      walk(n.children[1], ns, true, nil) if recv.is_a?(Node) && recv.type == :SELF
    when :DEFN
      owner = ns.join('::'); mname = n.children[0].to_s
      full = owner.empty? ? mname : "#{owner}#{singleton ? '.' : '#'}#{mname}"
      sym(singleton ? 'class_method' : 'method', full, n, owner)
      walk(n.children[1], ns, singleton, full)
    when :DEFS
      recv = n.children[0]; mname = n.children[1].to_s; owner = ns.join('::')
      target = (recv.is_a?(Node) && recv.type == :SELF) ? owner : (const_name(recv) || owner)
      full = target.empty? ? mname : "#{target}.#{mname}"
      sym('class_method', full, n, target)
      walk(n.children[2], ns, true, full)
    when :FCALL, :VCALL
      mname = n.children[0].to_s
      if cur.nil? && %w[include extend prepend].include?(mname) && !ns.empty?
        args = n.children[1]
        if args.is_a?(Node)
          args.children.each { |a| c = const_name(a); @includes[ns.join('::')] << "#{mname}:#{c}" if c }
        end
      elsif cur
        @calls << { from: cur, recv: nil, meth: mname, line: n.first_lineno }
      end
      n.children.each { |c| walk(c, ns, singleton, cur) }
    when :CALL, :QCALL, :OPCALL
      if cur
        recv = const_name(n.children[0])
        @calls << { from: cur, recv: recv, meth: n.children[1].to_s, line: n.first_lineno } if recv || n.type != :OPCALL
      end
      n.children.each { |c| walk(c, ns, singleton, cur) }
    else
      n.children.each { |c| walk(c, ns, singleton, cur) }
    end
  end
end

# Line scanner for files the running Ruby cannot parse (Ruby 3 syntax on Ruby 2.6, etc.).
# Nesting by indentation. Recovers declarations only, no calls. Marked as such.
def regex_extract(src)
  symbols = []; stack = [] # [indent, name]  -- popped ONLY by an `end` at the same indent,
  in_sclass = nil          # so heredoc bodies and other column-0 text cannot close a class.
  src.each_line.with_index(1) do |raw, ln|
    line = raw.rstrip
    next if line.strip.empty? || line.strip.start_with?('#')
    indent = line[/\A */].size
    if line =~ /\A\s*end\b/
      in_sclass = nil if in_sclass && indent <= in_sclass
      stack.pop if stack.any? && stack.last[0] == indent
      next
    end
    if (m = line.match(/\A\s*(class|module)\s+([A-Z][\w:]*)(?:\s*<\s*([\w:]+))?/))
      kind, name, sup = m[1], m[2], m[3]
      full = stack.empty? ? name : "#{stack.map { |s| s[1] }.join('::')}::#{name}"
      symbols << { kind: kind, name: full, owner: nil, line: ln, end_line: nil, superclass: sup }
      stack << [indent, name] unless line =~ /;\s*end\s*\z/   # one-liner `class X < Y; end`
    elsif line =~ /\A\s*class\s*<<\s*self\b/
      in_sclass = indent
    elsif (m = line.match(/\A\s*(?:(?:private|protected|public|private_class_method|memoize|memoized|sig)\s+)*def\s+(self\.)?([\w?!=<>+\-*\/%\[\]~^&|]+)/))
      owner = stack.map { |s| s[1] }.join('::')
      singleton = !m[1].nil? || (in_sclass && indent > in_sclass)
      full = owner.empty? ? m[2] : "#{owner}#{singleton ? '.' : '#'}#{m[2]}"
      symbols << { kind: singleton ? 'class_method' : 'method', name: full, owner: owner, line: ln, end_line: nil }
    end
  end
  { symbols: symbols, calls: [], includes: {} }
end

$stdout.sync = true
$stdin.each_line do |raw|
  raw = raw.strip
  next if raw.empty?
  item = JSON.parse(raw)
  src = Base64.decode64(item['b64']).force_encoding('UTF-8')
  src = src.scrub('?') unless src.valid_encoding?
  begin
    ast = RubyVM::AbstractSyntaxTree.parse(src)
    out = Extractor.new.run(ast)
    puts JSON.generate({ id: item['id'], ok: true, parser: 'ast' }.merge(out))
  rescue SyntaxError => e
    begin
      out = regex_extract(src)
      puts JSON.generate({ id: item['id'], ok: true, parser: 'regex', syntax_error: e.message.lines.first.to_s.strip[0, 200] }.merge(out))
    rescue StandardError => e2
      puts JSON.generate({ id: item['id'], ok: false, error: "#{e.class}: #{e.message.lines.first.to_s.strip[0, 200]}; fallback: #{e2.message[0, 100]}" })
    end
  rescue StandardError => e
    puts JSON.generate({ id: item['id'], ok: false, error: "#{e.class}: #{e.message[0, 200]}" })
  end
end
