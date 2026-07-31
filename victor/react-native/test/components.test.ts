// Coverage test — proves the renderer's component set is the *entire* React
// Native element surface, with nothing missing. It checks the framework-agnostic
// registry (`rnComponents.ts`), so it runs without react-native installed:
//
//   node --experimental-strip-types test/components.test.ts

import assert from "node:assert";
import {
  RN_COMPONENTS,
  RN_ALIASES,
  specFor,
  canonicalName,
  type WidgetKind,
} from "../src/render/rnComponents.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The complete public React Native component set (every element in the RN docs'
// "Core Components and APIs" component list), plus the Animated.* host views.
const REQUIRED_RN_COMPONENTS = [
  // core components
  "View",
  "Text",
  "Image",
  "ImageBackground",
  "TextInput",
  "ScrollView",
  "FlatList",
  "SectionList",
  "VirtualizedList",
  "VirtualizedSectionList",
  "Switch",
  "Button",
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "TouchableNativeFeedback",
  "ActivityIndicator",
  "Modal",
  "RefreshControl",
  "SafeAreaView",
  "KeyboardAvoidingView",
  "StatusBar",
  "DrawerLayoutAndroid",
  "InputAccessoryView",
  // Animated host views
  "Animated.View",
  "Animated.Text",
  "Animated.Image",
  "Animated.ScrollView",
  "Animated.FlatList",
  "Animated.SectionList",
];

const VALID_KINDS: WidgetKind[] = [
  "view",
  "text",
  "scroll",
  "list",
  "image",
  "imageBackground",
  "input",
  "switch",
  "button",
  "activity",
  "status",
  "refresh",
  "slider",
  "scene3d",
  "victorButton",
];

test("every React Native element is registered — no exception", () => {
  for (const name of REQUIRED_RN_COMPONENTS) {
    const spec = RN_COMPONENTS[name];
    assert.ok(spec, `missing React Native component: ${name}`);
    assert.ok(
      VALID_KINDS.includes(spec.kind),
      `component ${name} has invalid kind ${spec.kind}`,
    );
  }
});

test("every registered spec has a valid render kind", () => {
  for (const name of Object.keys(RN_COMPONENTS)) {
    assert.ok(
      VALID_KINDS.includes(RN_COMPONENTS[name].kind),
      `${name}: bad kind ${RN_COMPONENTS[name].kind}`,
    );
  }
});

test("legacy RN-prefixed class names all resolve to a spec", () => {
  for (const alias of Object.keys(RN_ALIASES)) {
    const spec = specFor(alias);
    assert.ok(spec, `alias ${alias} did not resolve`);
    assert.ok(RN_COMPONENTS[canonicalName(alias)], `alias ${alias} canon missing`);
  }
  // The classes the existing prelude/tests emit must keep working.
  for (const cls of ["RNView", "RNText", "RNButton", "RNInput", "RNScene3D"]) {
    assert.ok(specFor(cls), `prelude class ${cls} must resolve`);
  }
});

test("Victor specials are present (Scene3D, ergonomic Button, Slider)", () => {
  assert.strictEqual(specFor("RNScene3D")!.kind, "scene3d");
  assert.strictEqual(RN_COMPONENTS.RNButton.kind, "victorButton");
  assert.strictEqual(RN_COMPONENTS.RNSlider.kind, "slider");
});

console.log(`\n${passed} component-coverage tests passed.`);
