// main.dart — the multi-VM showcase: ONE Godot scene, a TREE of Elpian VMs.
//
// This program is the ROOT VM ("scene manager"): it owns the whole scene and
// the inter-VM space, builds the environment/camera/dashboard, then spawns
// three child VMs — each handed its own pod node and *sandboxed to it*:
//
//   root (scene manager, unrestricted)
//   ├─ orbiter   — spins a glowing ring inside its pod, and spawns its own
//   │  └─ satellite — grandchild VM confined to a sub-node of the pod
//   ├─ physics   — drops rigid bodies inside its pod on a timer; also PROBES
//   │              the sandbox (tries to grab the SceneTree and mutate a node
//   │              outside its pod) and reports the denials to the root
//   └─ rogue     — runs under a tight per-turn instruction budget, then hangs
//                  on purpose → the governor traps it and the root is notified
//
// Everything on screen is painted into the SAME scene, but each child can only
// touch its own node subtree (the parent can reach into children's — never the
// reverse). The dashboard shows live per-VM state and metered usage straight
// from the hierarchy (vm.state / vm.usage / vm.usageTree), plus lifecycle
// controls: pause/resume the orbiter branch, terminate the physics VM.
import 'godot.dart';

var elapsed = 0.0;
var camRig = null;

// Child controllers + their dashboard labels.
var orbiter = null;
var physics = null;
var rogue = null;
var vmLabels = {};
var probeLabel = null;
var treeLabel = null;
var orbiterPaused = false;
var pauseButton = null;

// ---------------------------------------------------------------------------
// child programs (each compiled into its own VM; the godot.dart prelude —
// GD/VMs/… — is composed ahead automatically). Child code uses single-quoted
// strings so it nests cleanly inside these double-quoted literals.
// ---------------------------------------------------------------------------

// Grandchild of the orbiter: a small counter-rotating golden cube. Note the
// nesting: this source lives INSIDE the orbiter's source string.
var orbiterSrc = ""
    + "var t = 0.0;\n"
    + "var ring = null;\n"
    + "var satelliteSrc = 'var t = 0.0; var m = null;\n"
    + "  void main() {\n"
    + "    m = GD.create(\"MeshInstance3D\");\n"
    + "    var box = GD.create(\"BoxMesh\");\n"
    + "    box.set(\"size\", Vector3(0.5, 0.5, 0.5));\n"
    + "    var mat = GD.create(\"StandardMaterial3D\");\n"
    + "    mat.set(\"albedo_color\", Color(1.0, 0.85, 0.3, 1.0));\n"
    + "    mat.set(\"emission_enabled\", true);\n"
    + "    mat.set(\"emission\", Color(1.0, 0.7, 0.2, 1.0));\n"
    + "    box.set(\"material\", mat);\n"
    + "    m.set(\"mesh\", box);\n"
    + "    GD.mount(m);\n"
    + "    GD.onProcess((d) { t = t + d; m.set(\"rotation\", Vector3(t * 2.0, 0.0, t * 2.0)); });\n"
    + "  }';\n"
    + "void main() {\n"
    + "  ring = GD.create('Node3D');\n"
    + "  var sphere = GD.create('SphereMesh');\n"
    + "  sphere.set('radius', GFloat(0.32));\n"
    + "  sphere.set('height', GFloat(0.64));\n"
    + "  var i = 0;\n"
    + "  while (i < 8) {\n"
    + "    var m = GD.create('MeshInstance3D');\n"
    + "    var mat = GD.create('StandardMaterial3D');\n"
    + "    var hue = i / 8.0;\n"
    + "    var col = Color(0.3 + 0.7 * hue, 0.5, 1.0 - 0.7 * hue, 1.0);\n"
    + "    mat.set('albedo_color', col);\n"
    + "    mat.set('emission_enabled', true);\n"
    + "    mat.set('emission', col);\n"
    + "    mat.set('emission_energy_multiplier', GFloat(1.6));\n"
    + "    m.set('material_override', mat);\n"
    + "    m.set('mesh', sphere);\n"
    + "    var ang = i * 0.7853981;\n"
    + "    m.set('position', Vector3(2.2 * cos(ang), 1.6, 2.2 * sin(ang)));\n"
    + "    ring.call('add_child', [m]);\n"
    + "    i = i + 1;\n"
    + "  }\n"
    + "  GD.mount(ring);\n"
    + "  var subPod = GD.create('Node3D');\n"
    + "  subPod.set('position', Vector3(0.0, 3.2, 0.0));\n"
    + "  GD.mount(subPod);\n"
    + "  VMs.spawn(satelliteSrc, subPod, {'label': 'satellite',\n"
    + "      'limits': {'instructionsPerTurn': 2000000}});\n"
    + "  GD.onProcess((d) { t = t + d; ring.set('rotation', Vector3(0.0, t * 0.9, 0.0)); });\n"
    + "}\n";

// The physics child: shared resources, a drop timer — and the sandbox probe.
var physicsSrc = ""
    + "var mesh = null;\n"
    + "var shape = null;\n"
    + "var count = 0;\n"
    + "void probeSandbox() {\n"
    + "  var denials = 0;\n"
    + "  var r1 = GD.op({'tree': true, 'def': 900});\n"
    + "  if (r1 is Map) { denials = denials + 1; }\n"
    + "  var r2 = GD.op({'singleton': 'OS', 'def': 901});\n"
    + "  if (r2 is Map) { denials = denials + 1; }\n"
    + "  var outside = GD.host().call('get_parent', []);\n"
    + "  var r3 = GD.op({'ref': outside.id, 'set': 'visible', 'value': false});\n"
    + "  if (r3 is Map) { denials = denials + 1; }\n"
    + "  VMs.sendParent('probe:' + denials);\n"
    + "}\n"
    + "void drop() {\n"
    + "  if (count >= 24) { return; }\n"
    + "  GD.beginBatch();\n"
    + "  var body = GD.create('RigidBody3D');\n"
    + "  var col = GD.create('CollisionShape3D');\n"
    + "  var m = GD.create('MeshInstance3D');\n"
    + "  var mat = GD.create('StandardMaterial3D');\n"
    + "  GD.endBatch();\n"
    + "  var hue = (count % 6) / 6.0;\n"
    + "  mat.set('albedo_color', Color(0.9 - 0.5 * hue, 0.35 + 0.5 * hue, 0.4, 1.0));\n"
    + "  mat.set('metallic', GFloat(0.7));\n"
    + "  m.set('material_override', mat);\n"
    + "  m.set('mesh', mesh);\n"
    + "  col.set('shape', shape);\n"
    + "  body.call('add_child', [m]);\n"
    + "  body.call('add_child', [col]);\n"
    + "  var xi = (count * 7) % 5 - 2;\n"
    + "  var zi = (count * 3) % 5 - 2;\n"
    + "  body.set('position', Vector3(xi * 0.5, 7.0 + (count % 3), zi * 0.5));\n"
    + "  GD.mount(body);\n"
    + "  count = count + 1;\n"
    + "}\n"
    + "void main() {\n"
    + "  mesh = GD.create('SphereMesh');\n"
    + "  mesh.set('radius', GFloat(0.35));\n"
    + "  mesh.set('height', GFloat(0.7));\n"
    + "  shape = GD.create('SphereShape3D');\n"
    + "  shape.set('radius', GFloat(0.35));\n"
    + "  var floor = GD.create('StaticBody3D');\n"
    + "  var fcol = GD.create('CollisionShape3D');\n"
    + "  var fbox = GD.create('BoxShape3D');\n"
    + "  fbox.set('size', Vector3(5.0, 0.4, 5.0));\n"
    + "  fcol.set('shape', fbox);\n"
    + "  fcol.set('position', Vector3(0.0, -0.2, 0.0));\n"
    + "  floor.call('add_child', [fcol]);\n"
    + "  GD.mount(floor);\n"
    + "  probeSandbox();\n"
    + "  GTimer.periodic(1500, () { drop(); });\n"
    + "}\n";

// The rogue child: a pulsing red beacon… that deliberately hangs after 6s.
// Its per-turn instruction budget traps the hang; the root gets notified.
var rogueSrc = ""
    + "var t = 0.0;\n"
    + "var beacon = null;\n"
    + "var light = null;\n"
    + "void main() {\n"
    + "  beacon = GD.create('MeshInstance3D');\n"
    + "  var sphere = GD.create('SphereMesh');\n"
    + "  sphere.set('radius', GFloat(0.6));\n"
    + "  sphere.set('height', GFloat(1.2));\n"
    + "  var mat = GD.create('StandardMaterial3D');\n"
    + "  mat.set('albedo_color', Color(0.9, 0.15, 0.1, 1.0));\n"
    + "  mat.set('emission_enabled', true);\n"
    + "  mat.set('emission', Color(1.0, 0.2, 0.1, 1.0));\n"
    + "  sphere.set('material', mat);\n"
    + "  beacon.set('mesh', sphere);\n"
    + "  beacon.set('position', Vector3(0.0, 1.6, 0.0));\n"
    + "  GD.mount(beacon);\n"
    + "  light = GD.create('OmniLight3D');\n"
    + "  light.set('position', Vector3(0.0, 1.6, 0.0));\n"
    + "  light.set('light_color', Color(1.0, 0.25, 0.15, 1.0));\n"
    + "  light.set('omni_range', GFloat(6.0));\n"
    + "  GD.mount(light);\n"
    + "  GD.onProcess((d) {\n"
    + "    t = t + d;\n"
    + "    var pulse = 1.0 + 0.8 * sin(t * 5.0);\n"
    + "    light.set('light_energy', GFloat(pulse * 2.0));\n"
    + "  });\n"
    + "  GTimer.after(6000, () {\n"
    + "    print('rogue: going into an infinite loop now…');\n"
    + "    var i = 0;\n"
    + "    while (true) { i = i + 1; }\n"
    + "  });\n"
    + "}\n";

// ---------------------------------------------------------------------------
// the root scene
// ---------------------------------------------------------------------------

void buildEnvironment() {
  GD.beginBatch();
  var worldEnv = GD.create("WorldEnvironment");
  var env = GD.create("Environment");
  var sky = GD.create("Sky");
  var skyMat = GD.create("ProceduralSkyMaterial");
  GD.endBatch();

  skyMat.set("sky_top_color", Color(0.07, 0.10, 0.22, 1.0));
  skyMat.set("sky_horizon_color", Color(0.55, 0.40, 0.45, 1.0));
  skyMat.set("ground_bottom_color", Color(0.04, 0.04, 0.06, 1.0));
  skyMat.set("ground_horizon_color", Color(0.40, 0.30, 0.35, 1.0));
  sky.set("sky_material", skyMat);

  env.set("background_mode", GD.constant("Environment.BG_SKY"));
  env.set("sky", sky);
  env.set("ambient_light_source", GD.constant("Environment.AMBIENT_SOURCE_SKY"));
  env.set("ambient_light_energy", GFloat(1.0));
  env.set("tonemap_mode", GD.constant("Environment.TONE_MAPPER_ACES"));
  env.set("glow_enabled", true);
  env.set("glow_bloom", GFloat(0.2));
  worldEnv.set("environment", env);
  GD.mount(worldEnv);

  var sun = GD.create("DirectionalLight3D");
  sun.set("rotation", Vector3(-0.55, 0.6, 0.0));
  sun.set("light_color", Color(0.95, 0.85, 0.75, 1.0));
  sun.set("light_energy", GFloat(1.2));
  sun.set("shadow_enabled", true);
  GD.mount(sun);
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

  plane.set("size", Vector2(60.0, 60.0));
  mat.set("albedo_color", Color(0.16, 0.16, 0.19, 1.0));
  mat.set("roughness", GFloat(0.9));
  plane.set("material", mat);
  meshInst.set("mesh", plane);
  box.set("size", Vector3(60.0, 1.0, 60.0));
  colShape.set("shape", box);
  colShape.set("position", Vector3(0.0, -0.5, 0.0));
  body.call("add_child", [meshInst]);
  body.call("add_child", [colShape]);
  GD.mount(body);
}

void buildCamera() {
  var cam = GD.create("Camera3D");
  camRig = GD.create("Node3D");
  cam.set("position", Vector3(0.0, 6.5, 14.0));
  cam.set("rotation", Vector3(-0.32, 0.0, 0.0));
  camRig.call("add_child", [cam]);
  GD.mount(camRig);
  cam.set("current", true);
}

// A pod: the node a child VM is sandboxed to — dais + label color ring.
dynamic buildPod(double x, double z, Color accent) {
  GD.beginBatch();
  var pod = GD.create("Node3D");
  var dais = GD.create("MeshInstance3D");
  var daisMesh = GD.create("CylinderMesh");
  var daisMat = GD.create("StandardMaterial3D");
  GD.endBatch();

  daisMesh.set("top_radius", GFloat(2.6));
  daisMesh.set("bottom_radius", GFloat(3.0));
  daisMesh.set("height", GFloat(0.5));
  daisMat.set("albedo_color", Color(0.12, 0.12, 0.15, 1.0));
  daisMat.set("metallic", GFloat(0.5));
  daisMat.set("emission_enabled", true);
  daisMat.set("emission", accent);
  daisMat.set("emission_energy_multiplier", GFloat(0.35));
  daisMesh.set("material", daisMat);
  dais.set("mesh", daisMesh);
  dais.set("position", Vector3(0.0, 0.25, 0.0));
  pod.call("add_child", [dais]);
  pod.set("position", Vector3(x, 0.0, z));
  GD.mount(pod);
  return pod;
}

dynamic addLabel(canvas, double y, int size, Color color) {
  var l = GD.create("Label");
  l.set("position", Vector2(24.0, y));
  l.set("theme_override_font_sizes/font_size", GInt(size));
  l.set("theme_override_colors/font_color", color);
  canvas.call("add_child", [l]);
  return l;
}

dynamic addButton(canvas, String text, double x, double y) {
  var b = GD.create("Button");
  b.set("text", text);
  b.set("position", Vector2(x, y));
  b.set("custom_minimum_size", Vector2(300.0, 72.0));
  b.set("theme_override_font_sizes/font_size", GInt(26));
  canvas.call("add_child", [b]);
  return b;
}

void buildDashboard() {
  var canvas = GD.create("CanvasLayer");
  GD.mount(canvas);

  var title = addLabel(canvas, 20.0, 32, Color(1.0, 1.0, 1.0, 1.0));
  title.set("text", "Elpian multi-VM — one scene, a tree of VMs");

  vmLabels["root"] = addLabel(canvas, 70.0, 24, Color(0.8, 0.9, 1.0, 1.0));
  vmLabels["orbiter"] = addLabel(canvas, 104.0, 24, Color(0.55, 0.75, 1.0, 1.0));
  vmLabels["satellite"] = addLabel(canvas, 138.0, 24, Color(1.0, 0.85, 0.4, 1.0));
  vmLabels["physics"] = addLabel(canvas, 172.0, 24, Color(0.6, 1.0, 0.65, 1.0));
  vmLabels["rogue"] = addLabel(canvas, 206.0, 24, Color(1.0, 0.5, 0.45, 1.0));
  probeLabel = addLabel(canvas, 240.0, 24, Color(0.85, 0.85, 0.85, 1.0));
  probeLabel.set("text", "sandbox probe: waiting…");
  treeLabel = addLabel(canvas, 274.0, 24, Color(0.7, 0.7, 0.8, 1.0));

  pauseButton = addButton(canvas, "Pause orbiter branch", 24.0, 320.0);
  pauseButton.connect("pressed", (args) {
    togglePauseOrbiter();
  });
  var killButton = addButton(canvas, "Terminate physics VM", 24.0, 404.0);
  killButton.connect("pressed", (args) {
    if (physics != null) {
      physics.terminate();
      physics = null;
    }
  });
}

void togglePauseOrbiter() {
  if (orbiter == null) {
    return;
  }
  if (orbiterPaused) {
    orbiter.resume();
    orbiterPaused = false;
    pauseButton.set("text", "Pause orbiter branch");
  } else {
    // Pauses the WHOLE branch: orbiter and its satellite grandchild freeze.
    orbiter.pause();
    orbiterPaused = true;
    pauseButton.set("text", "Resume orbiter branch");
  }
}

// One dashboard line: label, lifecycle state, own metered instruction count.
void refreshLine(String name, controller) {
  var label = vmLabels[name];
  if (controller == null) {
    label.set("text", name + ": terminated");
    return;
  }
  var s = controller.state();
  if (!(s is Map)) {
    label.set("text", name + ": ?");
    return;
  }
  var line = name + ": " + s["state"];
  if (s["paused"] == true) {
    line = line + " (paused)";
  }
  if (s["trap"] != "") {
    line = line + " TRAPPED: " + s["trap"];
  }
  var u = controller.usage();
  if (u is Map) {
    line = line + "  instr " + u["instructions"];
  }
  label.set("text", line);
}

void refreshDashboard() {
  var me = VMs.info();
  var mine = VMs.of(me["id"]);
  var own = mine.usage();
  var agg = mine.usageTree();
  if (own is Map) {
    if (agg is Map) {
      vmLabels["root"].set("text", "root: running  instr " + own["instructions"]);
      treeLabel.set("text",
          "whole tree: " + agg["instructions"] + " instr, " +
          agg["memoryBytes"] + " B heap (aggregate)");
    }
  }
  refreshLine("orbiter", orbiter);
  refreshLine("physics", physics);
  refreshLine("rogue", rogue);
  // The satellite is the ORBITER's child, not ours — list the orbiter's
  // children to find it (the tree is visible to every ancestor).
  var label = vmLabels["satellite"];
  if (orbiter == null) {
    label.set("text", "satellite: terminated (with orbiter branch)");
  } else {
    var kids = orbiter.children();
    var shown = false;
    if (kids is List) {
      if (kids.length > 0) {
        var sat = VMs.of(kids[0]["id"]);
        refreshLine("satellite", sat);
        shown = true;
      }
    }
    if (!shown) {
      label.set("text", "satellite: …");
    }
  }
}

void spawnChildren() {
  // Each child gets its own pod node — the whole world from its point of
  // view — plus a label, resource limits and (deniable) permissions.
  var podA = buildPod(-4.5, 0.0, Color(0.3, 0.55, 1.0, 1.0));
  orbiter = VMs.spawn(orbiterSrc, podA, {
    "label": "orbiter",
    "limits": {"instructionsPerTurn": 4000000},
  });

  var podB = buildPod(4.5, 0.0, Color(0.3, 1.0, 0.5, 1.0));
  physics = VMs.spawn(physicsSrc, podB, {
    "label": "physics",
    "limits": {"instructionsPerTurn": 4000000},
    "maxHostCalls": 100000,
  });

  var podC = buildPod(0.0, -5.5, Color(1.0, 0.3, 0.25, 1.0));
  rogue = VMs.spawn(rogueSrc, podC, {
    "label": "rogue",
    // Tight per-turn budget: the deliberate hang is cut off by the governor.
    "limits": {"instructionsPerTurn": 250000},
    // A rogue shouldn't manage VMs of its own.
    "permissions": {"vm_manage": false},
  });
}

void main() {
  buildEnvironment();
  buildGround();
  buildCamera();
  buildDashboard();
  spawnChildren();

  // Child notifications: the hierarchy reports traps and removals upward.
  VMs.onChildTrapped((kind, vmId, detail) {
    print("root: child vm " + vmId + " trapped -> " + detail);
    refreshDashboard();
  });
  VMs.onChildTerminated((kind, vmId, detail) {
    print("root: child vm " + vmId + " terminated (" + detail + ")");
  });

  // The physics child reports its sandbox probe results here.
  VMs.onMessage((sender, msg) {
    if (msg is String) {
      // "probe:3" = all three escape attempts were denied.
      probeLabel.set("text", "sandbox probe (vm " + sender + "): " +
          msg + " of 3 escapes denied");
    }
  });

  // Live dashboard straight off the hierarchy's metering.
  GTimer.periodic(1000, () {
    refreshDashboard();
  });

  var escape = GD.constant("KEY_ESCAPE");
  GD.onUnhandledInput((event) {
    if (event.cls == "InputEventKey") {
      if (event.call("is_pressed", []) == true) {
        if (event.get("keycode") == escape) {
          GD.tree().call("quit", []);
        }
      }
    }
  });

  // Frame loop: slow orbit around the three pods.
  GD.onProcess((delta) {
    elapsed = elapsed + delta;
    camRig.set("rotation", Vector3(0.0, elapsed * 0.15, 0.0));
  });

  print("multi-VM demo up: root + orbiter(+satellite) + physics + rogue");
}
