# Replay the SHOWCASE app's real 3D op stream into a real headless Godot and
# prove it builds the actual Godot 3D scene. The op stream in
# res://showcase_ops.json is captured from the shipped assets/guest/showcase.js
# running on the real Elpian VM (see native/elpian-rn/examples/capture_godot_ops.rs)
# — the exact godot.op calls a React Native <Scene3D/> forwards on device.
#
#   godot --headless --path . --script res://headless_replay_showcase3d.gd
#
# Handles are guest-allocated, so the stream is deterministic. The Scene3D mount
# node is host-established (never created by a `new` op), so we seed it as a
# Node3D under the ElpianVM node, then replay every op through the reflective
# GodotController (exec_op_json) and assert the real 3D node hierarchy appears.
extends SceneTree

const OPS_PATH := "res://showcase_ops.json"
const SELF_HANDLE := 1  # our seed handle for the ElpianVM node itself

var _vm
var _ops: Array = []
var _frames := 0
var _replayed := false

func _initialize() -> void:
	if not ClassDB.class_exists("ElpianVM"):
		push_error("ElpianVM class is not registered — the GDExtension did not load")
		quit(2)
		return

	var text := FileAccess.get_file_as_string(OPS_PATH)
	if text.is_empty():
		push_error("could not read " + OPS_PATH)
		quit(2)
		return
	var data: Dictionary = JSON.parse_string(text)
	var ops: Array = data.get("ops", [])
	if ops.is_empty():
		push_error("no ops to replay")
		quit(2)
		return

	_ops = ops
	_vm = ClassDB.instantiate("ElpianVM")
	# A trivial guest so start() builds the GodotController (exec_op_json is a
	# no-op until it exists); we then drive that controller directly with the
	# captured ops, the same reflective seam a device Scene3D uses.
	_vm.set("language", "js")
	_vm.set("prepend_prelude", true)
	_vm.set("guest_source", "function main(){}\nmain();")
	_vm.set("autostart", true)
	get_root().add_child(_vm)  # _ready() -> start() -> controller ready (next frame)

func _replay() -> void:
	var ops: Array = _ops
	# Handles created by the stream (anything carrying a `def`).
	var created := {}
	for op in ops:
		if op.has("def"):
			created[int(op["def"])] = true

	# Mount nodes = add_child parents the stream never created — the viewport
	# roots the RN host establishes on device. Seed each as a real Node3D under
	# the ElpianVM node so the replayed add_child calls have somewhere to attach.
	_exec({"self": true, "def": SELF_HANDLE})
	var seeded := {}
	for op in ops:
		if op.get("method", "") == "add_child" and op.has("ref"):
			var parent := int(op["ref"])
			if not created.has(parent) and not seeded.has(parent):
				seeded[parent] = true
				_exec({"new": "Node3D", "def": parent})
				_exec({"ref": SELF_HANDLE, "method": "add_child", "args": [{"ref": parent}]})

	# Replay the real op stream in order.
	for op in ops:
		_exec(op)

	print("seeded mount handles: ", seeded.keys())

func _exec(op: Dictionary) -> void:
	_vm.call("exec_op_json", JSON.stringify(op))

func _process(_delta: float) -> bool:
	_frames += 1
	# Frame 1: the node has run _ready()/start(), so the controller exists —
	# replay the captured stream now. Then let a couple of frames settle.
	if not _replayed:
		if not _vm.call("is_running"):
			return false
		_replay()
		_replayed = true
		return false
	if _frames < 4:
		return false

	var found := {}
	_collect_classes(_vm, found)
	print("SceneTree classes under ElpianVM after replay: ", found.keys())

	# The showcase's real 3D scene: a lit, camera'd world with a ground plane and
	# a grouped box — all under the Scene3D mount.
	var required := [
		"Node3D", "MeshInstance3D", "Camera3D", "DirectionalLight3D", "WorldEnvironment",
	]
	var missing := []
	for cls in required:
		if not found.has(cls):
			missing.append(cls)

	# Count meshes: the plane + the grouped box = at least two MeshInstance3D.
	var mesh_count := _count_class(_vm, "MeshInstance3D")

	if missing.is_empty() and mesh_count >= 2:
		print("HEADLESS_REPLAY_RESULT: PASS — showcase's real godot.op stream built a live 3D scene (",
			mesh_count, " meshes)")
		quit(0)
	else:
		push_error("HEADLESS_REPLAY_RESULT: FAIL — missing " + str(missing) +
			", mesh_count=" + str(mesh_count))
		quit(1)
	return true

func _collect_classes(node: Object, acc: Dictionary) -> void:
	if node == null:
		return
	for child in node.get_children():
		acc[child.get_class()] = true
		_collect_classes(child, acc)

func _count_class(node: Object, cls: String) -> int:
	var n := 0
	if node == null:
		return 0
	for child in node.get_children():
		if child.get_class() == cls:
			n += 1
		n += _count_class(child, cls)
	return n
