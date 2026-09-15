// A Procol template's `widgets` JSON, normalised into what a screen shows. Three shapes exist in the data:
//   sheet  -- trade/auction templates: an object of groups (inline_components = line-item columns,
//             global_price_components = event-level price components), each an array of widgets
//   fields -- module/document templates: an object keyed by field, each value a widget definition
//   form   -- RFI / vendor onboarding / intake: an array of pages, each with headers and questions
// Pure functions, no database, so the view, the search index and the tests share one reading of the JSON.

const GROUP_LABEL = {
  inline_components: "Line item columns",
  global_price_components: "Event-level price components",
  aggregate_components: "Aggregate columns",
  header_components: "Header fields",
};
const TYPE = { string: "text", String: "text", text: "text", multiline_text: "long text", number: "number", amount: "amount", quantity: "quantity",
               percentage: "%", percent_and_amount: "% or amount", formula: "formula", product: "product", dropdown: "dropdown", multi_select: "multi-select",
               delivery_location: "location", attachment: "file", date: "date", date_time: "date & time", radio: "choice", question_group: "group",
               tabular: "table", variant: "variant", action: "action", vendor: "vendor" };
export const typeLabel = (t) => TYPE[t] || (t ? String(t).replace(/_/g, " ") : "text");

const num = (v) => (v == null || v === "" ? null : Number(v));
const widget = (w, fallbackName) => {
  const c = w?.configuration || w?.config || {};
  return {
    name: w?.name || w?.label || fallbackName || w?.key_attribute || "(unnamed)",
    key: w?.key_attribute || w?.key || null,
    input_type: w?.input_type || null,
    type: typeLabel(w?.input_type),
    side: c.field_type === "participant" ? "participant" : c.field_type === "formula" ? "formula" : "creator",
    required: c.is_required === true,
    hidden: c.mode_type === "hidden",
    prefix: c.prefix || null, suffix: c.suffix || null, precision: c.precision ?? null,
    priority: num(c.priority),
    options: Array.isArray(c.cell_options) ? c.cell_options.map((o) => (o && typeof o === "object" ? o.value : o)).filter((x) => x != null).slice(0, 12) : null,
    custom: w?.widget_type === "custom",
  };
};
const byPriority = (a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9);
const isWidgetDef = (v) => v && typeof v === "object" && !Array.isArray(v) && ("input_type" in v || "key_attribute" in v || "configuration" in v);

export function normalizeWidgets(widgets) {
  if (widgets == null || widgets === "") return { layout: "empty", groups: [], pages: [], count: 0 };
  if (typeof widgets === "string") { try { widgets = JSON.parse(widgets); } catch { return { layout: "empty", groups: [], pages: [], count: 0 }; } }

  if (Array.isArray(widgets)) {                                    // form pages
    const pages = widgets.filter((p) => p && typeof p === "object").map((p, i) => {
      const qs = [];
      for (const [bucket, side] of [["page_headers", "creator"], ["page_response_headers", "participant"], ["aggregate_level_questions", "aggregate"]])
        for (const h of Array.isArray(p[bucket]) ? p[bucket] : []) qs.push({ ...widget(h), bucket: side });
      return { order: num(p.order) ?? i + 1, name: p.name || `Page ${i + 1}`, description: p.description || "", kind: p.config?.type || "form", questions: qs };
    }).sort((a, b) => a.order - b.order);
    return { layout: "form", groups: [], pages, count: pages.reduce((n, p) => n + p.questions.length, 0) };
  }

  if (typeof widgets === "object") {
    const arrays = Object.entries(widgets).filter(([, v]) => Array.isArray(v));
    const defs = Object.entries(widgets).filter(([, v]) => isWidgetDef(v));
    if (arrays.length) {                                           // sheet: groups of columns
      const groups = arrays.map(([k, arr]) => ({
        key: k, label: GROUP_LABEL[k] || k.replace(/_/g, " "),
        widgets: arr.filter((w) => w && typeof w === "object").map((w) => widget(w)).sort(byPriority),
      })).filter((g) => g.widgets.length);
      // line items first: that is the sheet people see; price components sit above it
      groups.sort((a, b) => (a.key === "inline_components" ? -1 : b.key === "inline_components" ? 1 : 0));
      return { layout: "sheet", groups, pages: [], count: groups.reduce((n, g) => n + g.widgets.length, 0) };
    }
    if (defs.length) {                                             // fields: a flat map of named widgets
      const ws = defs.map(([k, v]) => widget(v, k.replace(/_/g, " "))).sort(byPriority);
      return { layout: "fields", groups: [{ key: "fields", label: "Fields", widgets: ws }], pages: [], count: ws.length };
    }
  }
  return { layout: "empty", groups: [], pages: [], count: 0 };
}

/** Column and question names, for the search card: "what does this template ask for". */
export function widgetNames(widgets, max = 40) {
  const n = normalizeWidgets(widgets);
  const names = n.layout === "form" ? n.pages.flatMap((p) => [p.name, ...p.questions.map((q) => q.name)]) : n.groups.flatMap((g) => g.widgets.map((w) => w.name));
  return [...new Set(names.filter(Boolean).map((s) => String(s).slice(0, 80)))].slice(0, max);
}
