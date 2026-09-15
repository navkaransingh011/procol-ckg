import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWidgets, widgetNames } from "../src/template-layout.mjs";

test("trade template: groups become sheet columns in priority order, line items first", () => {
  const n = normalizeWidgets({
    global_price_components: [{ name: "Freight", input_type: "number", configuration: { field_type: "participant", priority: 1, prefix: "₹" } }],
    inline_components: [{ name: "Price Cap", key_attribute: "ceil_price", input_type: "number", configuration: { field_type: "creator", priority: 4, prefix: "₹", suffix: "/KG" } },
                        { name: "Min Quantity", input_type: "number", configuration: { priority: 2, suffix: "KG", is_required: true } }],
  });
  assert.equal(n.layout, "sheet"); assert.equal(n.count, 3);
  assert.equal(n.groups[0].key, "inline_components");
  assert.deepEqual(n.groups[0].widgets.map((w) => w.name), ["Min Quantity", "Price Cap"]);
  assert.equal(n.groups[0].widgets[0].required, true);
  assert.equal(n.groups[1].widgets[0].side, "participant");
});

test("RFI template: pages of questions with choices", () => {
  const n = normalizeWidgets([{ order: 2, name: "Terms", page_headers: [], page_response_headers: [{ name: "Do you agree?", input_type: "radio", configuration: { field_type: "participant", cell_options: [{ value: "I Agree" }] } }] },
                              { order: 1, name: "Company", page_response_headers: [{ name: "GST number", input_type: "string", configuration: { is_required: true } }] }]);
  assert.equal(n.layout, "form"); assert.equal(n.count, 2);
  assert.deepEqual(n.pages.map((p) => p.name), ["Company", "Terms"]);
  assert.deepEqual(n.pages[1].questions[0].options, ["I Agree"]);
  assert.equal(n.pages[0].questions[0].required, true);
});

test("field-map template and empty shapes", () => {
  const n = normalizeWidgets({ po_number: { input_type: "string", configuration: { priority: 1 } }, status: { input_type: "dropdown", configuration: { priority: 0 } } });
  assert.equal(n.layout, "fields"); assert.deepEqual(n.groups[0].widgets.map((w) => w.name), ["status", "po number"]);
  assert.equal(normalizeWidgets(null).layout, "empty");
  assert.equal(normalizeWidgets("not json").layout, "empty");
  assert.deepEqual(widgetNames({ inline_components: [{ name: "A" }, { name: "A" }, { name: "B" }] }), ["A", "B"]);
});
