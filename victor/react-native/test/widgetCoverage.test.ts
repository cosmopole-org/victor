// Widget coverage + example-compatibility gate.
//
//   node --experimental-strip-types test/widgetCoverage.test.ts   (from react-native/)
//
// Enforces the "one widget set → native on every platform, complete by
// construction" guarantee:
//   1. every widget KIND in the catalog maps to a native widget on web + android
//      + ios (no widget can silently fall through a platform);
//   2. every class name (canonical + legacy alias) resolves to a covered kind;
//   3. the shipped example (assets/guest/showcase.js — what the RN APK workflow
//      builds) uses ONLY widgets/methods the prelude provides, and no
//      reply-consuming `.get()` in its build (so it renders under the async
//      native WidgetSink, not just the React path).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { RN_COMPONENTS, RN_ALIASES, specFor, type WidgetKind } from "../src/render/rnComponents.ts";
import { WIDGET_CATALOG } from "../src/render/widgetCatalog.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("every widget kind maps to a native widget on web + android + ios", () => {
  const kinds = new Set<WidgetKind>(Object.values(RN_COMPONENTS).map((s) => s.kind));
  for (const kind of kinds) {
    const m = WIDGET_CATALOG[kind];
    assert.ok(m, `kind "${kind}" has no WIDGET_CATALOG entry`);
    for (const platform of ["web", "android", "ios"] as const) {
      assert.ok(
        typeof m[platform] === "string" && m[platform].length > 0,
        `kind "${kind}" has no ${platform} widget mapping`,
      );
    }
  }
  // And the catalog has no orphan kinds beyond the component set's kinds.
  for (const kind of Object.keys(WIDGET_CATALOG) as WidgetKind[]) {
    assert.ok(kinds.has(kind), `WIDGET_CATALOG has an unused kind "${kind}"`);
  }
});

test("every class name (canonical + legacy alias) resolves to a covered kind", () => {
  const names = [...Object.keys(RN_COMPONENTS), ...Object.keys(RN_ALIASES)];
  for (const name of names) {
    const spec = specFor(name);
    assert.ok(spec, `class "${name}" does not resolve to a spec`);
    assert.ok(WIDGET_CATALOG[spec.kind], `class "${name}" (kind ${spec.kind}) is not covered`);
  }
});

test("the shipped example uses only prelude-provided widgets/methods", () => {
  const showcase = readFileSync("assets/guest/showcase.js", "utf8");
  const prelude = readFileSync("../bridge/prelude/reactnative.js", "utf8");

  // Every RN.<name> the prelude exposes (widget factories + begin/commit/…).
  const provided = new Set<string>();
  for (const m of prelude.matchAll(/static\s+([a-zA-Z0-9]+)\s*\(/g)) provided.add(m[1]);
  assert.ok(provided.size > 20, "sanity: found the prelude's RN.* methods");

  // Only real calls `RN.name(` — not `RN.Scene3D` mentioned in prose/comments.
  const used = new Set<string>();
  for (const m of showcase.matchAll(/\bRN\.([a-zA-Z0-9]+)\s*\(/g)) used.add(m[1]);
  assert.ok(used.size > 0, "sanity: found RN.* calls in the example");

  const missing = [...used].filter((name) => !provided.has(name));
  assert.deepStrictEqual(missing, [], `example calls RN.${missing.join(", RN.")} which the prelude does not provide`);
});

test("the example's build path uses no reply-consuming .get() ops", () => {
  const showcase = readFileSync("assets/guest/showcase.js", "utf8");
  // A widget-handle `.get("prop")` would need a synchronous native round-trip;
  // the example must not rely on it so it renders under the async native sink.
  assert.strictEqual(
    /\.get\(/.test(showcase),
    false,
    "example uses .get(); async native rendering can't service it synchronously",
  );
});

console.log(`\n${passed} widget-coverage tests passed.`);
