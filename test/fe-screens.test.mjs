import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "../src/extractors/fe-screens.mjs";

const routeCfg = `export const ROUTES = {
  [ROUTE_KEYS.PR]: { key: "pr:read", path: "/purchase-requisitions", name: "Purchase Requisitions", breadNav: ["Purchase Requisitions"], exact: true, component: Components.AsyncPR, searchKeywords: ["PR"] },
  [ROUTE_KEYS.CREATE_ORDER]: { key: "order:create", path: "/create-order", name: "Create Event", breadNav: [{ name: "Events", link: "/events" }, "Create"], component: Components.AsyncCreateOrder },
  [ROUTE_KEYS.ORDER]: { key: "order:read", path: "/orders/:id", name: "Event Details", breadNav: ["Events", ":id"], component: Components.AsyncOrderDetails },
};`;
const cmpCfg = `export const AsyncPR = lazy(() => import("../../views/purchaseRequisition"));
export const AsyncCreateOrder = lazy(
  () => import("../../views/createOrder/createOrder"),
);
export const AsyncOrderDetails = lazy(() => import("../../views/orderDetails"));`;
const en = JSON.stringify({ eventCreation: { footer: { publishEvent: "Publish Event", schedule: "Schedule" } }, common: { cancel: "Cancel" } });
const view = `export default function Footer() {
  return (<div>
    <Steps><Step title="Select Template" /><Step title="Select Participants" /></Steps>
    <Button type="primary" onClick={publish}>{t("eventCreation.footer.publishEvent")}</Button>
    <Button onClick={() => history.push("/orders/" + id)}>View Event</Button>
    <Button>{t("common.cancel")}</Button>
    <Modal title="Add PO" />
  </div>);
}`;

test("routes, component map and labels extract from their config files", () => {
  const r = fs.extract(Buffer.from(routeCfg), "src/app/routes/routeConfigs.js");
  assert.equal(r.routes.length, 3);
  assert.deepEqual(r.routes[1], { route_key: "CREATE_ORDER", permission: "order:create", path: "/create-order", name: "Create Event", parents: ["Events", "Create"], component: "AsyncCreateOrder", keywords: [] });
  const c = fs.extract(Buffer.from(cmpCfg), "src/app/routes/routeComponentsConfigs.js");
  assert.equal(c.components.AsyncCreateOrder, "src/views/createOrder/createOrder");
  assert.equal(c.components.AsyncPR, "src/views/purchaseRequisition");
  const l = fs.extract(Buffer.from(en), "src/translations/en.json");
  assert.equal(l.labels["eventCreation.footer.publishEvent"], "Publish Event");
});

test("a view file yields screens' actions, API links and navigations, with noise dropped", () => {
  const all = new Map([
    ["src/app/routes/routeConfigs.js", fs.extract(Buffer.from(routeCfg), "src/app/routes/routeConfigs.js")],
    ["src/app/routes/routeComponentsConfigs.js", fs.extract(Buffer.from(cmpCfg), "src/app/routes/routeComponentsConfigs.js")],
    ["src/translations/en.json", fs.extract(Buffer.from(en), "src/translations/en.json")],
  ]);
  const http = new Map([["src/views/createOrder/components/footer.jsx", { callSites: [{ line: 4, method: "POST", pathTemplate: "/trade_requests" }] }]]);
  const ctx = { siteHash: (s) => Buffer.from(s), normalizeEndpoint: (p) => p, factsFor: (n) => (n === fs.NAME ? all : n === "fe-http" ? http : new Map()) };
  const facts = fs.extract(Buffer.from(view), "src/views/createOrder/components/footer.jsx");
  const out = fs.resolve(facts, { path: "src/views/createOrder/components/footer.jsx", blobSha: Buffer.alloc(0) }, ctx);
  const names = out.entities.map((e) => `${e.attrs.role}:${e.name}`).sort();
  assert.deepEqual(names, ["button:Publish Event", "button:View Event", "step:Select Participants", "step:Select Template", "title:Add PO"]);
  assert.ok(out.entities.every((e) => e.attrs.screen === "Create Event"));
  const kinds = out.edges.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "DECLARES").length, 5);
  assert.ok(out.edges.some((e) => e.kind === "ISSUES_HTTP" && e.dstFqn === "fe:src/views/createOrder/components/footer.jsx#L4"));
  assert.ok(out.edges.some((e) => e.kind === "NAVIGATES_TO" && e.dstFqn === "screen:/orders/:id"));
  const screens = fs.resolve(all.get("src/app/routes/routeConfigs.js"), { path: "src/app/routes/routeConfigs.js", blobSha: Buffer.alloc(0) }, ctx);
  assert.equal(screens.entities.length, 3);
  assert.equal(screens.entities[1].attrs.view_dir, "src/views/createOrder");
});
