// The example guest program embedded as a string so the Expo app can boot it
// without a filesystem read. It mirrors `assets/guest/app.js` verbatim; in a
// real app you either embed compiled bytecode or fetch the source. The host
// composes the `godot.js` + `reactnative.js` preludes ahead of it.

export const EXAMPLE_GUEST_SOURCE = String.raw`
import "godot.js";
import "reactnative.js";

var count = 0;
var label = null;

function main() {
  RN.begin();

  var page = RN.column({
    flex: 1,
    bg: "#0f172a",
    padding: 24,
    gap: 16,
    justify: "center",
  });

  var title = RN.text("Victor · React Native + Godot", {
    color: "#e2e8f0",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  });

  label = RN.text("Count: 0", { color: "#38bdf8", fontSize: 18, textAlign: "center" });

  var inc = RN.button({
    title: "Increment",
    onPress: function (e) {
      count = count + 1;
      label.set("text", "Count: " + count);
      RN.toast("tapped " + count);
    },
  });

  var scene = RN.scene3d({ height: 240, radius: 12, bg: "#020617" });
  if (scene.scene3d != null) {
    var mount = scene.scene3d;
    mount.call("add_child", [G3.environment({ bg: new Color(0.02, 0.03, 0.09, 1) })]);
    mount.call("add_child", [G3.dirLight({ energy: 1.3, rotation: [-50, -30, 0] })]);
    mount.call("add_child", [G3.camera({ position: [0, 2, 6], rotation: [-15, 0, 0] })]);
    mount.call("add_child", [
      G3.mesh("box", { color: new Color(0.3, 0.6, 1, 1), position: [0, 1, 0] }),
    ]);
  }

  page.add(title);
  page.add(label);
  page.add(inc);
  page.add(scene);

  RN.commit();
  RN.mount(page);

  print("victor react-native demo up");
}

main();
`;
