// main.dart — a Dart program (running on the Elpian VM, no JIT) driving the
// Godot engine end-to-end through the reflective bridge: rendering, GUI,
// physics, signals, input, tweens, timers, and the servers, all by name.
//
// Everything below is ordinary `godot.dart` prelude API — see
// elpian/godot/prelude/godot.dart. Scene construction batches into single
// host calls; per-frame work is plain game logic.
import 'godot.dart';

var score = 0;
var scoreLabel = null;
var spinner = null;
var elapsed = 0.0;

void buildGui() {
  // Any Control node, any property, any layout — by name.
  var canvas = GD.create("CanvasLayer");
  GD.mount(canvas);

  scoreLabel = GD.create("Label");
  scoreLabel.set("text", "score: 0");
  scoreLabel.set("position", Vector2(24.0, 24.0));
  scoreLabel.set("theme_override_font_sizes/font_size", GInt(28));
  canvas.call("add_child", [scoreLabel]);

  var button = GD.create("Button");
  button.set("text", "Spawn box");
  button.set("position", Vector2(24.0, 72.0));
  canvas.call("add_child", [button]);

  // Any signal -> a Dart closure.
  button.connect("pressed", (args) {
    score = score + 1;
    scoreLabel.set("text", "score: " + score);
    spawnBox(120.0 + score * 40.0);
  });
}

void spawnBox(double x) {
  // Physics layer: a falling RigidBody2D with a visible polygon + collider.
  GD.beginBatch();
  var body = GD.create("RigidBody2D");
  var shape = GD.create("CollisionShape2D");
  var rect = GD.create("RectangleShape2D");
  var poly = GD.create("Polygon2D");
  GD.endBatch();

  rect.set("size", Vector2(36.0, 36.0));
  shape.set("shape", rect);
  poly.set("polygon", Packed.vector2s([-18.0, -18.0, 18.0, -18.0, 18.0, 18.0, -18.0, 18.0]));
  poly.set("color", Color(0.30, 0.69, 0.31, 1.0));
  body.call("add_child", [shape]);
  body.call("add_child", [poly]);
  body.set("position", Vector2(x, 40.0));
  GD.mount(body);
}

void buildFloor() {
  var floor = GD.create("StaticBody2D");
  var shape = GD.create("CollisionShape2D");
  var rect = GD.create("RectangleShape2D");
  rect.set("size", Vector2(1200.0, 40.0));
  shape.set("shape", rect);
  var visual = GD.create("Polygon2D");
  visual.set("polygon", Packed.vector2s([-600.0, -20.0, 600.0, -20.0, 600.0, 20.0, -600.0, 20.0]));
  visual.set("color", Color(0.35, 0.35, 0.42, 1.0));
  floor.call("add_child", [shape]);
  floor.call("add_child", [visual]);
  floor.set("position", Vector2(576.0, 620.0));
  GD.mount(floor);
}

void buildSpinner() {
  // Rendering layer via a plain node; rotated every frame from _process.
  spinner = GD.create("Polygon2D");
  spinner.set("polygon", Packed.vector2s([0.0, -40.0, 35.0, 20.0, -35.0, 20.0]));
  spinner.set("color", Color(0.13, 0.59, 0.95, 1.0));
  spinner.set("position", Vector2(576.0, 180.0));
  GD.mount(spinner);
}

void main() {
  // Servers: any singleton, any method.
  GD.renderingServer().call("set_default_clear_color", [Color(0.08, 0.09, 0.12, 1.0)]);

  buildGui();
  buildFloor();
  buildSpinner();

  // Reflection: prove the whole surface is addressable, from Dart, at runtime.
  var report = GD.audit();
  print("ClassDB audit: " + report["classes"] + " classes, " +
      report["methods"] + " methods, " + report["signals"] + " signals, " +
      report["unreachable"].length + " unreachable");

  // Any constant / enum by name.
  var escape = GD.constant("KEY_ESCAPE");

  // Input layer: raw InputEvent objects arrive as proxies.
  GD.onInput((event) {
    if (event.call("is_pressed", []) == true) {
      var key = event.get("keycode");
      if (key == escape) {
        GD.tree().call("quit", []);
      }
    }
  });

  // Frame loop: plain game logic; Godot renders the retained scene.
  GD.onProcess((delta) {
    elapsed = elapsed + delta;
    spinner.set("rotation", elapsed * 1.5);
  });

  // Dart timers ride the VM event loop, pumped once per engine frame.
  GTimer.periodic(2000, () {
    spawnBox(200.0 + (score % 5) * 150.0);
  });
}
