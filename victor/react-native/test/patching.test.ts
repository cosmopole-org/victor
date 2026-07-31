// Targeted-patching tests — prove that a change re-renders only the widget(s)
// it touched, never the whole tree. The store's per-node revisions + per-node
// subscriptions are what the renderer's memoized `<WidgetView/>` rides on, so
// asserting them here is asserting the render behavior, framework-free:
//
//   node --experimental-strip-types test/patching.test.ts

import assert from "node:assert";
import { WidgetStore } from "../src/core/widgetStore.ts";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// A per-node render counter: how many times each node's subscribers fire.
function watch(store: WidgetStore, ids: number[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const id of ids) {
    counts[id] = 0;
    store.subscribeNode(id, () => {
      counts[id]++;
    });
  }
  return counts;
}

test("a prop change patches only that widget, not its siblings or the app", () => {
  const store = new WidgetStore();
  store.create(1, "RNView", 0);
  store.create(2, "RNText", 0);
  store.create(3, "RNText", 0);
  store.addChild(1, 2);
  store.addChild(1, 3);
  store.setRoot(1);
  store.flush(); // consume the initial mount

  let appRenders = 0;
  store.subscribe(() => appRenders++);
  const c = watch(store, [1, 2, 3]);

  // Change ONE prop on node 2.
  store.setProp(2, "text", "hello");
  store.flush();

  assert.strictEqual(c[2], 1, "the changed widget re-rendered once");
  assert.strictEqual(c[3], 0, "the sibling did NOT re-render");
  assert.strictEqual(c[1], 0, "the parent did NOT re-render (only a child prop changed)");
  assert.strictEqual(appRenders, 0, "the app root did NOT re-render for a leaf prop change");
});

test("a child-list edit patches only the parent, not the moved subtree", () => {
  const store = new WidgetStore();
  store.create(1, "RNView", 0);
  store.create(2, "RNText", 0);
  store.setRoot(1);
  store.flush();

  const c = watch(store, [1, 2]);
  store.addChild(1, 2); // structural: parent's child list changes
  store.flush();

  assert.strictEqual(c[1], 1, "the parent re-rendered for the structural change");
  assert.strictEqual(c[2], 0, "the child's own subtree was untouched (reused as-is)");
});

test("per-node revision only advances for touched nodes", () => {
  const store = new WidgetStore();
  store.create(10, "RNView", 0);
  store.create(11, "RNText", 0);
  store.flush();

  const before10 = store.nodeVersion(10);
  const before11 = store.nodeVersion(11);
  store.setProp(11, "text", "x");
  store.flush();

  assert.strictEqual(store.nodeVersion(10), before10, "untouched node keeps its revision");
  assert.strictEqual(store.nodeVersion(11), before11 + 1, "touched node advances one revision");
});

test("coalescing: many prop writes in one frame = one re-render per node", () => {
  const store = new WidgetStore();
  store.create(1, "RNText", 0);
  store.flush();
  const c = watch(store, [1]);

  store.setProp(1, "text", "a");
  store.setProp(1, "text", "b");
  store.setProp(1, "color", "#fff");
  store.flush(); // one flush for the whole burst

  assert.strictEqual(c[1], 1, "three writes coalesced into a single re-render");
});

test("end-to-end via the dispatcher: patching one label bumps only its node", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  const rn = (op: object) => d.handle("rn.op", JSON.stringify([op]));
  rn({ new: "RNView", def: 1 });
  rn({ new: "RNText", def: 2 });
  rn({ new: "RNText", def: 3 });
  rn({ ref: 1, method: "add_child", args: [{ ref: 2 }] });
  rn({ ref: 1, method: "add_child", args: [{ ref: 3 }] });
  rn({ root: true, ref: 1 });

  const c = watch(d.store, [1, 2, 3]);
  const v3 = d.store.nodeVersion(3);
  rn({ ref: 2, set: "text", value: "Count: 1" }); // dispatcher.commit() flushes

  assert.strictEqual(c[2], 1, "only the edited label node re-rendered");
  assert.strictEqual(c[3], 0, "the other label did not");
  assert.strictEqual(d.store.nodeVersion(3), v3, "the other label's revision is unchanged");
});

console.log(`\n${passed} targeted-patching tests passed.`);
