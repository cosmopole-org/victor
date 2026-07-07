// main.dart — a Dart program (running on the Elpian VM, no JIT) driving a full
// 3D Godot scene end-to-end through the reflective bridge: environment (sky,
// fog, glow), lights with shadows, PBR materials, physics, a runtime glTF
// download (HTTPRequest -> GLTFDocument, all by name), signals, input, timers.
//
// Everything below is ordinary `godot.dart` prelude API — see
// elpian/godot/prelude/godot.dart. Scene construction batches into single
// host calls; per-frame work is plain game logic.
import 'godot.dart';

var MODEL_URL =
    "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb";

var elapsed = 0.0;
var camRig = null;
var helmet = null;
var statusLabel = null;
var spawned = 0;

// Shared meshes/materials (built once in main, reused by every instance).
var ballMesh = null;
var ballShape = null;
var ballColors = null;

void buildEnvironment() {
  GD.beginBatch();
  var worldEnv = GD.create("WorldEnvironment");
  var env = GD.create("Environment");
  var sky = GD.create("Sky");
  var skyMat = GD.create("ProceduralSkyMaterial");
  GD.endBatch();

  // A low sun over a hazy horizon: deep blue zenith, amber horizon band.
  skyMat.set("sky_top_color", Color(0.09, 0.13, 0.26, 1.0));
  skyMat.set("sky_horizon_color", Color(0.90, 0.55, 0.32, 1.0));
  skyMat.set("ground_bottom_color", Color(0.05, 0.05, 0.07, 1.0));
  skyMat.set("ground_horizon_color", Color(0.72, 0.44, 0.28, 1.0));
  sky.set("sky_material", skyMat);

  env.set("background_mode", GD.constant("Environment.BG_SKY"));
  env.set("sky", sky);
  env.set("ambient_light_source", GD.constant("Environment.AMBIENT_SOURCE_SKY"));
  env.set("ambient_light_energy", GFloat(1.1));
  env.set("tonemap_mode", GD.constant("Environment.TONE_MAPPER_ACES"));
  env.set("glow_enabled", true);
  env.set("glow_bloom", GFloat(0.15));
  env.set("fog_enabled", true);
  env.set("fog_light_color", Color(0.55, 0.42, 0.36, 1.0));
  env.set("fog_density", GFloat(0.012));
  worldEnv.set("environment", env);
  GD.mount(worldEnv);

  // The sun: warm, low over the horizon, casting real shadows.
  var sun = GD.create("DirectionalLight3D");
  sun.set("rotation", Vector3(-0.45, 0.75, 0.0));
  sun.set("light_color", Color(1.0, 0.82, 0.62, 1.0));
  sun.set("light_energy", GFloat(1.5));
  sun.set("shadow_enabled", true);
  GD.mount(sun);

  // A warm accent light hovering over the pedestal.
  var glow = GD.create("OmniLight3D");
  glow.set("position", Vector3(0.0, 4.5, 0.0));
  glow.set("light_color", Color(1.0, 0.75, 0.45, 1.0));
  glow.set("light_energy", GFloat(2.2));
  glow.set("omni_range", GFloat(10.0));
  GD.mount(glow);
}

void buildGround() {
  GD.beginBatch();
  var body = GD.create("StaticBody3D");
  var colShape = GD.create("CollisionShape3D");
  var box = GD.create("BoxShape3D");
  var meshInst = GD.create("MeshInstance3D");
  var plane = GD.create("PlaneMesh");
  var mat = GD.create("StandardMaterial3D");
  GD.endBatch();

  plane.set("size", Vector2(70.0, 70.0));
  mat.set("albedo_color", Color(0.23, 0.21, 0.19, 1.0));
  mat.set("roughness", GFloat(0.95));
  plane.set("material", mat);
  meshInst.set("mesh", plane);

  box.set("size", Vector3(70.0, 1.0, 70.0));
  colShape.set("shape", box);
  colShape.set("position", Vector3(0.0, -0.5, 0.0));

  body.call("add_child", [meshInst]);
  body.call("add_child", [colShape]);
  GD.mount(body);
}

// One stone pillar (base slab + column + cap) at (x, z); meshes are shared.
void buildPillar(baseMesh, columnMesh, capMesh, double x, double z) {
  GD.beginBatch();
  var root = GD.create("Node3D");
  var base = GD.create("MeshInstance3D");
  var column = GD.create("MeshInstance3D");
  var cap = GD.create("MeshInstance3D");
  var body = GD.create("StaticBody3D");
  var colShape = GD.create("CollisionShape3D");
  var colBox = GD.create("BoxShape3D");
  GD.endBatch();

  base.set("mesh", baseMesh);
  base.set("position", Vector3(0.0, 0.3, 0.0));
  column.set("mesh", columnMesh);
  column.set("position", Vector3(0.0, 2.6, 0.0));
  cap.set("mesh", capMesh);
  cap.set("position", Vector3(0.0, 4.9, 0.0));

  colBox.set("size", Vector3(1.4, 5.4, 1.4));
  colShape.set("shape", colBox);
  colShape.set("position", Vector3(0.0, 2.7, 0.0));
  body.call("add_child", [colShape]);

  root.call("add_child", [base]);
  root.call("add_child", [column]);
  root.call("add_child", [cap]);
  root.call("add_child", [body]);
  root.set("position", Vector3(x, 0.0, z));
  GD.mount(root);
}

void buildPlaza() {
  GD.beginBatch();
  var stoneMat = GD.create("StandardMaterial3D");
  var baseMesh = GD.create("BoxMesh");
  var columnMesh = GD.create("CylinderMesh");
  var capMesh = GD.create("BoxMesh");
  var pedestal = GD.create("MeshInstance3D");
  var pedestalMesh = GD.create("CylinderMesh");
  var pedestalMat = GD.create("StandardMaterial3D");
  var pedestalBody = GD.create("StaticBody3D");
  var pedestalCol = GD.create("CollisionShape3D");
  var pedestalShape = GD.create("CylinderShape3D");
  GD.endBatch();

  stoneMat.set("albedo_color", Color(0.62, 0.60, 0.56, 1.0));
  stoneMat.set("roughness", GFloat(0.7));

  baseMesh.set("size", Vector3(2.2, 0.6, 2.2));
  baseMesh.set("material", stoneMat);
  columnMesh.set("top_radius", GFloat(0.45));
  columnMesh.set("bottom_radius", GFloat(0.55));
  columnMesh.set("height", GFloat(4.0));
  columnMesh.set("material", stoneMat);
  capMesh.set("size", Vector3(1.8, 0.5, 1.8));
  capMesh.set("material", stoneMat);

  var positions = [
    [16.0, 0.0], [-16.0, 0.0], [0.0, 16.0], [0.0, -16.0],
    [11.5, 11.5], [11.5, -11.5], [-11.5, 11.5], [-11.5, -11.5],
  ];
  for (var p in positions) {
    buildPillar(baseMesh, columnMesh, capMesh, p[0], p[1]);
  }

  // The pedestal the downloaded model floats above.
  pedestalMesh.set("top_radius", GFloat(1.1));
  pedestalMesh.set("bottom_radius", GFloat(1.5));
  pedestalMesh.set("height", GFloat(1.6));
  pedestalMat.set("albedo_color", Color(0.15, 0.15, 0.17, 1.0));
  pedestalMat.set("metallic", GFloat(0.6));
  pedestalMat.set("roughness", GFloat(0.35));
  pedestalMesh.set("material", pedestalMat);
  pedestal.set("mesh", pedestalMesh);
  pedestal.set("position", Vector3(0.0, 0.8, 0.0));
  GD.mount(pedestal);

  pedestalShape.set("radius", GFloat(1.5));
  pedestalShape.set("height", GFloat(1.6));
  pedestalCol.set("shape", pedestalShape);
  pedestalCol.set("position", Vector3(0.0, 0.8, 0.0));
  pedestalBody.call("add_child", [pedestalCol]);
  GD.mount(pedestalBody);
}

void buildCamera() {
  var cam = GD.create("Camera3D");
  camRig = GD.create("Node3D");
  cam.set("position", Vector3(0.0, 4.2, 11.0));
  cam.set("rotation", Vector3(-0.22, 0.0, 0.0));
  camRig.call("add_child", [cam]);
  GD.mount(camRig);
  cam.set("current", true);
}

void buildGui() {
  var canvas = GD.create("CanvasLayer");
  GD.mount(canvas);

  statusLabel = GD.create("Label");
  statusLabel.set("text", "downloading model...");
  statusLabel.set("position", Vector2(24.0, 24.0));
  statusLabel.set("theme_override_font_sizes/font_size", GInt(30));
  canvas.call("add_child", [statusLabel]);

  var button = GD.create("Button");
  button.set("text", "Drop a sphere");
  button.set("position", Vector2(24.0, 76.0));
  button.set("custom_minimum_size", Vector2(240.0, 64.0));
  canvas.call("add_child", [button]);
  button.connect("pressed", (args) {
    spawnBall();
  });
}

void spawnBall() {
  if (spawned >= 60) {
    return; // keep the physics load bounded on mobile
  }
  GD.beginBatch();
  var body = GD.create("RigidBody3D");
  var colShape = GD.create("CollisionShape3D");
  var meshInst = GD.create("MeshInstance3D");
  var mat = GD.create("StandardMaterial3D");
  GD.endBatch();

  mat.set("albedo_color", ballColors[spawned % 5]);
  mat.set("metallic", GFloat(0.8));
  mat.set("roughness", GFloat(0.2));
  meshInst.set("mesh", ballMesh);
  meshInst.set("material_override", mat);
  colShape.set("shape", ballShape);
  body.call("add_child", [meshInst]);
  body.call("add_child", [colShape]);

  // Deterministic scatter around the pedestal (no RNG needed).
  var xi = (spawned * 7) % 11 - 5;
  var zi = (spawned * 5) % 9 - 4;
  body.set("position", Vector3(xi * 0.9, 10.0 + (spawned % 3) * 1.5, zi * 0.9));
  GD.mount(body);
  spawned = spawned + 1;
}

void downloadModel() {
  var http = GD.create("HTTPRequest");
  GD.mount(http);
  // Save server-side of the seam: bytes go to a file, never through the VM.
  http.set("download_file", "user://model.glb");
  http.connect("request_completed", (args) {
    var result = args[0];
    var code = args[1];
    if (result == 0 && code == 200) {
      loadModel();
    } else {
      statusLabel.set("text", "model download failed (http " + code + ")");
    }
  });
  http.call("request", [MODEL_URL]);
}

void loadModel() {
  var doc = GD.create("GLTFDocument");
  var state = GD.create("GLTFState");
  var err = doc.call("append_from_file", ["user://model.glb", state]);
  if (err != 0) {
    statusLabel.set("text", "glTF parse failed (err " + err + ")");
    return;
  }
  helmet = doc.call("generate_scene", [state]);
  helmet.set("position", Vector3(0.0, 3.0, 0.0));
  helmet.set("scale", Vector3(1.8, 1.8, 1.8));
  GD.mount(helmet);
  statusLabel.set("text", "model loaded — tap to drop spheres");
}

void main() {
  buildEnvironment();
  buildGround();
  buildPlaza();
  buildCamera();
  buildGui();

  // Shared sphere resources for every spawned ball.
  GD.beginBatch();
  ballMesh = GD.create("SphereMesh");
  ballShape = GD.create("SphereShape3D");
  GD.endBatch();
  ballMesh.set("radius", GFloat(0.5));
  ballMesh.set("height", GFloat(1.0));
  ballShape.set("radius", GFloat(0.5));
  ballColors = [
    Color(0.85, 0.30, 0.25, 1.0),
    Color(0.25, 0.60, 0.85, 1.0),
    Color(0.90, 0.75, 0.30, 1.0),
    Color(0.35, 0.75, 0.45, 1.0),
    Color(0.75, 0.45, 0.85, 1.0),
  ];

  downloadModel();

  // Reflection: prove the whole surface is addressable, from Dart, at runtime.
  var report = GD.audit();
  print("ClassDB audit: " + report["classes"] + " classes, " +
      report["methods"] + " methods, " + report["signals"] + " signals, " +
      report["unreachable"].length + " unreachable");

  var escape = GD.constant("KEY_ESCAPE");
  var leftButton = GD.constant("MOUSE_BUTTON_LEFT");

  // Input layer: taps/clicks drop spheres; ESC quits on desktop. Unhandled
  // input only, so presses the GUI consumes (the button) don't double-spawn;
  // touches arrive here as emulated mouse events, one per tap.
  GD.onUnhandledInput((event) {
    if (event.cls == "InputEventMouseButton") {
      if (event.get("pressed") == true && event.get("button_index") == leftButton) {
        spawnBall();
      }
    }
    if (event.cls == "InputEventKey") {
      if (event.call("is_pressed", []) == true) {
        if (event.get("keycode") == escape) {
          GD.tree().call("quit", []);
        }
      }
    }
  });

  // Frame loop: orbit the camera; spin the downloaded model.
  GD.onProcess((delta) {
    elapsed = elapsed + delta;
    camRig.set("rotation", Vector3(0.0, elapsed * 0.22, 0.0));
    if (helmet != null) {
      helmet.set("rotation", Vector3(0.0, elapsed * 0.8, 0.0));
    }
  });

  // Ambient activity: a sphere drops in every couple of seconds.
  GTimer.periodic(2000, () {
    spawnBall();
  });
}
