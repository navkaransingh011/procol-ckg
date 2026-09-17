#!/usr/bin/env ruby
# frozen_string_literal: false
#
# Expand config/routes.rb WITHOUT booting Rails and WITHOUT any gems.
#
# How: instance_eval the file against a recorder that implements the routing DSL.
# routes.rb uses plain `def` + method calls (api_routes is invoked 5x under different
# subdomain constraints, and itself calls integration_routes 4x), so Ruby's own method
# dispatch performs that expansion for us. A text parser gets this catastrophically
# wrong in both directions; this cannot, because it IS evaluation.
#
# Usage: ruby be-routes.rb <path-to-routes.rb>   -> JSON array on stdout

require 'json'

# Any constant we don't define resolves to this: responds to everything, returns itself,
# never runs blocks. Lets `Sidekiq::Web.use Rack::Auth::Basic do ... end` pass harmlessly.
class Blackhole
  def self.const_missing(_n)
    self
  end

  def self.method_missing(*_a, &_b)
    self
  end

  def method_missing(*_a, &_b)
    self
  end

  def to_s
    ''
  end
end

class Object
  def self.const_missing(_name)
    Blackhole
  end
end

Frame = Struct.new(:path, :mod, :constraints, :defaults, :scope_name)

class Recorder
  attr_reader :routes, :mounts

  VERBS = %w[get post put patch delete options head].freeze

  def initialize
    @routes = []
    @mounts = []
    @stack  = [Frame.new([], [], [], {}, [])]
  end

  # --- swallow non-routing statements inside the draw block -------------------
  def require(*)
    true
  end
  def require_relative(*)
    true
  end
  def method_missing(_name, *_a, **_k)
    Blackhole
  end
  def respond_to_missing?(*)
    true
  end

  # --- frame helpers ---------------------------------------------------------
  def frame
    @stack.last
  end

  def push(path: nil, mod: nil, constraints: nil, defaults: nil, scope_name: nil)
    f = frame
    @stack.push Frame.new(
      f.path + (path ? [path.to_s] : []),
      f.mod  + (mod  ? [mod.to_s]  : []),
      f.constraints + (constraints ? [constraints] : []),
      f.defaults.merge(defaults || {}),
      f.scope_name + (scope_name ? [scope_name.to_s] : []),
    )
    yield if block_given?
  ensure
    @stack.pop if block_given?
  end

  def current_path(extra = nil)
    parts = (frame.path + (extra ? [extra.to_s] : [])).reject { |p| p.nil? || p.empty? }
    '/' + parts.join('/').gsub(%r{/+}, '/').sub(%r{\A/}, '')
  end

  def qualify(ctrl)
    return nil if ctrl.nil?
    return ctrl if ctrl.include?('/')          # already namespaced by the author
    (frame.mod + [ctrl]).join('/')
  end

  def emit(verb, path, to, source: 'explicit')
    ctrl, action = to.to_s.split('#', 2)
    @routes << {
      'verb'        => verb.to_s.upcase,
      'path'        => path,
      'controller'  => qualify(ctrl),
      'action'      => action,
      'constraints' => frame.constraints.flatten.compact,
      'defaults'    => frame.defaults,
      'source'      => source,
    }
  end

  # --- the DSL --------------------------------------------------------------
  VERBS.each do |verb|
    define_method(verb) do |*args, **opts, &blk|
      spec = args.first
      to   = opts[:to]
      if spec.is_a?(Hash)                       # get 'x' => 'c#a'
        opts = opts.merge(spec.select { |k, _| k.is_a?(Symbol) })
        spec.each do |k, v|
          next if k.is_a?(Symbol)                 # :to, :constraints, :defaults ...
          emit(verb, current_path(k), v)
        end
        emit(verb, current_path(args[1] || opts[:path]), opts[:to]) if opts[:to] && spec.empty?
      elsif to
        emit(verb, current_path(spec), to)
      elsif spec.is_a?(String) && spec.include?('#')
        emit(verb, current_path(spec.split('#').first), spec)
      elsif spec
        # get :search  inside a member/collection block -> action name is the path
        emit(verb, current_path(spec), "#{frame.scope_name.last}##{spec}")
      end
      blk&.call
    end
  end

  def match(*args, **opts, &blk)
    via = Array(opts[:via] || %i[get post])
    via.each { |v| send(v, *args, **opts.reject { |k, _| k == :via }, &blk) }
  end

  def root(*args, **opts)
    to = opts[:to] || args.first
    emit(:get, current_path, to) if to
  end

  def scope(*args, **opts, &blk)
    path = opts[:path] || (args.first.is_a?(String) || args.first.is_a?(Symbol) ? args.first : nil)
    push(path: path, mod: opts[:module], constraints: opts[:constraints],
         defaults: opts[:defaults], &blk)
  end

  def namespace(name, **opts, &blk)
    push(path: opts[:path] || name, mod: opts[:module] || name, &blk)
  end

  def constraints(arg = nil, **opts, &blk)
    c = arg.is_a?(Hash) ? arg : (opts.empty? ? { lambda: true } : opts)
    push(constraints: c, &blk)
  end

  def defaults(hash, &blk)
    push(defaults: hash, &blk)
  end
  def concern(name, &blk)
    (@concerns ||= {})[name] = blk
  end
  def concerns(*names)
    names.each { |n| instance_eval(&@concerns[n]) if @concerns&.key?(n) }
  end

  # `mount Rswag::Ui::Engine => '/api-docs'` is the common form, and Ruby 3 hands that
  # braceless hash over as KEYWORDS, not as a positional argument. A signature of
  # (arg, **opts) therefore raises "given 0, expected 1" on Ruby 3 for the most ordinary
  # mount line there is -- and since the rescue below swallows it, the whole file expands
  # to zero routes with a successful exit code. Accept both shapes.
  def mount(*args, **opts)
    pairs = args.first.is_a?(Hash) ? args.first : {}
    pairs = pairs.merge(opts.reject { |k, _| k == :at })
    if pairs.any?
      pairs.each { |engine, at| @mounts << { 'engine' => engine.to_s, 'at' => at.to_s } }
    elsif args.first
      @mounts << { 'engine' => args.first.to_s, 'at' => (opts[:at] || '').to_s }
    end
  end

  ACTIONS = {
    'index'   => [:get,    nil],
    'create'  => [:post,   nil],
    'new'     => [:get,    'new'],
    'edit'    => [:get,    ':id/edit'],
    'show'    => [:get,    ':id'],
    'update'  => [:patch,  ':id'],
    'update2' => [:put,    ':id'],
    'destroy' => [:delete, ':id'],
  }.freeze

  def resources(*names, **opts, &blk)
    names.each { |n| build_resource(n, opts, collection: true, &blk) }
  end

  def resource(*names, **opts, &blk)
    names.each { |n| build_resource(n, opts, collection: false, &blk) }
  end

  def build_resource(name, opts, collection:, &blk)
    only   = opts[:only]   ? Array(opts[:only]).map(&:to_s)   : nil
    except = opts[:except] ? Array(opts[:except]).map(&:to_s) : []
    ctrl   = (opts[:controller] || name).to_s
    base   = (opts[:path] || name).to_s

    ACTIONS.each do |act, (verb, suffix)|
      real = act.sub(/2\z/, '')
      next if only && !only.include?(real)
      next if except.include?(real)
      next if !collection && %w[index].include?(real)
      seg = collection ? [base, suffix] : [base, suffix&.sub(':id', '')]
      path = '/' + (frame.path + seg.compact.reject(&:empty?)).join('/').gsub(%r{/+}, '/')
      @routes << {
        'verb' => verb.to_s.upcase, 'path' => path,
        'controller' => qualify(ctrl), 'action' => real,
        'constraints' => frame.constraints.flatten.compact,
        'defaults' => frame.defaults, 'source' => 'resources',
      }
    end

    return unless blk
    # Nested block: member/collection routes, and nested resources under /:parent_id
    @nesting = (@nesting || []) + [singularize(base)]
    push(path: base, scope_name: ctrl) do
      @member_param = ":#{singularize(base)}_id"
      instance_eval(&blk)
    end
    @nesting.pop
  end

  def member(&blk)
    push(path: ':id', &blk)
  end
  def collection(&blk)
    push(&blk)
  end

  def singularize(w)
    s = w.to_s
    return s.sub(/ies\z/, 'y')  if s.end_with?('ies')
    return s.sub(/sses\z/, 'ss') if s.end_with?('sses')
    return s.sub(/s\z/, '')      if s.end_with?('s') && !s.end_with?('ss')
    s
  end
end

module Rails
  # routes.rb sometimes gates blocks on Rails.env.production? etc. We model the
  # DEPLOYED route set: production? is true, every other env predicate is false.
  class EnvInquirer < String
    def method_missing(name, *_a)
      return name.to_s == 'production?' if name.to_s.end_with?('?')
      super
    end
    def respond_to_missing?(name, _p = false)
      name.to_s.end_with?('?') || super
    end
  end
  def self.env
    EnvInquirer.new('production')
  end
  module RouteSet
    def self.draw(&blk)
      Recorder::CURRENT.instance_eval(&blk)
    end
  end
  module App
    def self.routes
    RouteSet
  end
  end
  def self.application
    App
  end
end

src = File.read(ARGV[0])
rec = Recorder.new
Recorder.const_set(:CURRENT, rec)
begin
  eval(src, TOPLEVEL_BINDING, ARGV[0]) # rubocop:disable Security/Eval
rescue StandardError, ScriptError => e
  warn "partial expansion: #{e.class}: #{e.message}"
end
puts JSON.generate({ 'routes' => rec.routes, 'mounts' => rec.mounts })
