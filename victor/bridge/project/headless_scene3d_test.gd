# Headless engine-side proof for Victor's Scene3D: boot the real `ElpianVM`
# GDExtension node with a tiny JS guest that builds a 3D scene through the
# `godot.js` / G3 prelude (a Node3D group holding a MeshInstance3D box, a
# Camera3D and a DirectionalLight3D) and mounts it under the node — then walk
# the live SceneTree and assert those real Godot 3D nodes exist.
#
#   godot --headless --path . --script res://headless_scene3d_test.gd
#
# This exercises the exact path a React Native `Scene3D` uses on device: the VM
# emits `godot.op` calls, the reflective GodotController services them against
# Godot's ClassDB, and a real 3D SceneTree is constructed. It runs without a GPU
# or display (headless), so it validates the Godot integration here in CI.
extends SceneTree

const GUEST := """
function main() {
  var root = G3.node({});
  var cube = G3.mesh('box', {});
  root.call('add_child', [cube]);
  var cam = G3.camera({});
  root.call('add_child', [cam]);
  var light = G3.dirLight({});
  root.call('add_child', [light]);
  GD.mount(root);
  print('scene3d guest built its 3D tree');
}
main();
"""

var _vm
var _frames := 0

func _initialize() -> void:
	if not ClassDB.class_exists("ElpianVM"):
		push_error("ElpianVM class is not registered — the GDExtension did not load")
		quit(2)
		return
	_vm = ClassDB.instantiate("ElpianVM")
	_vm.set("language", "js")
	_vm.set("prepend_prelude", true)
	_vm.set("guest_source", GUEST)
	_vm.set("autostart", true)
	# Adding to the tree triggers _ready(), which autostarts the guest; the guest
	# builds and mounts its 3D nodes synchronously under _vm.
	get_root().add_child(_vm)

func _process(_delta: float) -> bool:
	# Give the node a couple of idle frames to settle, then inspect and quit.
	_frames += 1
	if _frames < 3:
		return false

	var found := {}
	_collect_classes(_vm, found)
	print("SceneTree classes under ElpianVM: ", found.keys())

	var required := ["Node3D", "MeshInstance3D", "Camera3D", "DirectionalLight3D"]
	var missing := []
	for cls in required:
		if not found.has(cls):
			missing.append(cls)

	if missing.is_empty():
		print("HEADLESS_SCENE3D_RESULT: PASS — real Godot 3D nodes built from godot.op")
		quit(0)
	else:
		push_error("HEADLESS_SCENE3D_RESULT: FAIL — missing 3D node types: " + str(missing))
		quit(1)
	return true

func _collect_classes(node: Object, acc: Dictionary) -> void:
	if node == null:
		return
	for child in node.get_children():
		acc[child.get_class()] = true
		_collect_classes(child, acc)
