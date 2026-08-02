// Web DOM renderer test (jsdom) — the VM's rn.op stream builds real DOM, no
// React. Drives the actual HostDispatcher → DomWidgetRenderer path and asserts
// the resulting DOM for every widget kind, plus events (native DOM event → VM),
// styling (RN → CSS), and tree mutations.
//
//   node --experimental-strip-types test/domWidgetRenderer.test.ts

import assert from "node:assert";
import { JSDOM } from "jsdom";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";
import { DomWidgetRenderer, type DomHost } from "../src/render/domWidgetRenderer.ts";
import type { Wire } from "../src/core/protocol.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function setup(): {
  d: HostDispatcher;
  r: DomWidgetRenderer;
  fired: Array<[number, string, Wire]>;
  win: JSDOM["window"];
  tag: (id: number) => string;
} {
  const dom = new JSDOM("<!DOCTYPE html><body><div id='root'></div></body>");
  const doc = dom.window.document;
  const container = doc.getElementById("root")!;
  const fired: Array<[number, string, Wire]> = [];
  const host = {
    document: doc,
    container,
    fire: (id: number, ev: string, arg?: Wire) => fired.push([id, ev, arg ?? null]),
  } as unknown as DomHost;
  const r = new DomWidgetRenderer(host);
  const d = new HostDispatcher(new MockScene3dEngine(), r);
  const tag = (id: number): string =>
    (r.elementFor(id) as unknown as { tagName: string }).tagName.toLowerCase();
  return { d, r, fired, win: dom.window, tag };
}

function rn(d: HostDispatcher, op: object): void {
  d.handle("rn.op", JSON.stringify([op]));
}

test("every widget kind creates the right DOM element", () => {
  const { d, r, tag } = setup();
  const cases: Array<[string, number, string]> = [
    ["RNView", 1, "div"],
    ["SafeAreaView", 2, "div"],
    ["RNText", 3, "span"],
    ["RNInput", 4, "input"],
    ["RNSwitch", 5, "input"],
    ["Button", 6, "button"],
    ["RNButton", 7, "button"],
    ["ActivityIndicator", 8, "div"],
    ["StatusBar", 9, "div"],
    ["RefreshControl", 10, "div"],
    ["RNScroll", 11, "div"],
    ["FlatList", 12, "div"],
    ["Image", 13, "img"],
    ["ImageBackground", 14, "div"],
    ["RNSlider", 15, "input"],
    ["RNScene3D", 16, "canvas"],
  ];
  for (const [cls, id, expected] of cases) {
    rn(d, { new: cls, def: id });
    assert.strictEqual(tag(id), expected, `${cls} → <${expected}>`);
  }
  // input variants carry the right type
  const el = (id: number) => r.elementFor(id) as unknown as { getAttribute(n: string): string };
  assert.strictEqual(el(4).getAttribute("type"), "text", "TextInput → input[type=text]");
  assert.strictEqual(el(5).getAttribute("type"), "checkbox", "Switch → input[type=checkbox]");
  assert.strictEqual(el(15).getAttribute("type"), "range", "Slider → input[type=range]");
});

test("props map to DOM content, attributes and CSS (RN→CSS)", () => {
  const { d, r } = setup();
  rn(d, { new: "RNText", def: 1 });
  rn(d, { ref: 1, props: { text: "Hello", color: "#fff", fontSize: 18 } });
  const span = r.elementFor(1) as unknown as { textContent: string; style: Record<string, string> };
  assert.strictEqual(span.textContent, "Hello");
  assert.strictEqual(span.style.color, "rgb(255, 255, 255)"); // jsdom normalizes #fff
  assert.strictEqual(span.style.fontSize, "18px", "number → px");

  rn(d, { new: "RNView", def: 2 });
  rn(d, { ref: 2, props: { bg: "#111827", padding: 10, direction: "row", flex: 1 } });
  const div = r.elementFor(2) as unknown as { style: Record<string, string> };
  assert.strictEqual(div.style.display, "flex", "container is flex");
  assert.strictEqual(div.style.flexDirection, "row");
  assert.strictEqual(div.style.padding, "10px");
  // flex:1 → CSS shorthand "1 1 0%" (grow 1, shrink 1, basis 0%) — RN's flex:1.
  assert.strictEqual(div.style.flex, "1 1 0%", "flex is unitless (CSS shorthand)");
});

test("native DOM events fire back into the VM with the right arg", () => {
  const { d, r, fired, win } = setup();
  // Button press
  rn(d, { new: "RNButton", def: 1 });
  rn(d, { ref: 1, props: { title: "Tap", onPress: { cb: 100 } } });
  (r.elementFor(1) as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(
    new win.Event("click"),
  );
  assert.deepStrictEqual(fired.at(-1), [1, "press", null], "click → press");

  // TextInput changeText carries the value
  rn(d, { new: "RNInput", def: 2 });
  rn(d, { ref: 2, props: { onChangeText: { cb: 101 } } });
  const input = r.elementFor(2) as unknown as { value: string; dispatchEvent(e: Event): void };
  input.value = "bob";
  input.dispatchEvent(new win.Event("input"));
  assert.deepStrictEqual(fired.at(-1), [2, "changeText", "bob"], "input → changeText(value)");

  // Switch valueChange carries the checked state
  rn(d, { new: "RNSwitch", def: 3 });
  rn(d, { ref: 3, props: { onValueChange: { cb: 102 } } });
  const sw = r.elementFor(3) as unknown as { checked: boolean; dispatchEvent(e: Event): void };
  sw.checked = true;
  sw.dispatchEvent(new win.Event("change"));
  assert.deepStrictEqual(fired.at(-1), [3, "valueChange", true], "change → valueChange(checked)");
});

test("tree ops (add/insert/remove/clear) and root mount hit the real DOM", () => {
  const { d, r, win } = setup();
  rn(d, { new: "RNView", def: 1 });
  rn(d, { new: "RNText", def: 2 });
  rn(d, { new: "RNText", def: 3 });
  rn(d, { ref: 1, method: "add_child", args: [{ ref: 2 }] });
  rn(d, { ref: 1, method: "add_child", args: [{ ref: 3 }] });
  rn(d, { root: true, ref: 1 });

  const root = win.document.getElementById("root")!;
  assert.strictEqual(root.children.length, 1, "one root mounted");
  const view = root.children[0];
  assert.strictEqual(view.children.length, 2, "two children");
  assert.strictEqual(view.children[0].tagName.toLowerCase(), "span");

  rn(d, { ref: 1, method: "remove_child", args: [{ ref: 2 }] });
  assert.strictEqual(view.children.length, 1, "child removed from DOM");
  rn(d, { ref: 1, method: "clear_children", args: [] });
  assert.strictEqual(view.children.length, 0, "children cleared");
});

console.log(`\n${passed} dom-renderer tests passed.`);
