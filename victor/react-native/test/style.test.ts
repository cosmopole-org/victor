// Style-translation tests — the prop → React Native style mapping is pure and
// framework-agnostic, so it runs under Node's type stripping.
//
//   node --experimental-strip-types test/style.test.ts

import assert from "node:assert";
import { toStyle } from "../src/render/style.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("maps convenience props to RN style keys", () => {
  const s = toStyle({ bg: "#000", color: "#fff", padding: 12, radius: 8 });
  assert.strictEqual(s.backgroundColor, "#000");
  assert.strictEqual(s.color, "#fff");
  assert.strictEqual(s.padding, 12);
  assert.strictEqual(s.borderRadius, 8);
});

test("direction becomes flexDirection", () => {
  assert.strictEqual(toStyle({ direction: "row" }).flexDirection, "row");
  assert.strictEqual(toStyle({ direction: "column" }).flexDirection, "column");
  assert.strictEqual(toStyle({ direction: "bogus" }).flexDirection, undefined);
});

test("raw style object merges last and wins", () => {
  const s = toStyle({ bg: "#000", style: { backgroundColor: "#123", elevation: 4 } });
  assert.strictEqual(s.backgroundColor, "#123");
  assert.strictEqual(s.elevation, 4);
});

test("unknown props are ignored", () => {
  const s = toStyle({ mysteryProp: 5, width: 100 });
  assert.strictEqual((s as Record<string, unknown>).mysteryProp, undefined);
  assert.strictEqual(s.width, 100);
});

console.log(`\n${passed} style tests passed.`);
