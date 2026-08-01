# Op-sink: the embedded engine's content. Each frame it drains godot.op messages
# the React Native side queued (via the ElpianGodotBridge JNI singleton) and
# applies them to THIS live 3D scene through the reflective GodotController
# (ElpianVM.exec_op_json) — so the guest's Scene3D builds and renders here. The
# same op-servicing is proven headless in bridge/project/headless_replay_*.
extends Node3D

var _vm
var _bridge
var _seeded := {}
const SELF_HANDLE := 1

func _ready() -> void:
	if not ClassDB.class_exists("ElpianVM"):
		push_error("ElpianVM (elpian_godot GDExtension) not loaded")
		return
	_vm = ClassDB.instantiate("ElpianVM")
	_vm.set("language", "js")
	_vm.set("prepend_prelude", true)
	_vm.set("guest_source", "function main(){}\nmain();")
	_vm.set("autostart", true)
	add_child(_vm)                                   # in-tree → its children render
	_vm.call("exec_op_json", JSON.stringify({"self": true, "def": SELF_HANDLE}))
	if Engine.has_singleton("ElpianGodotBridge"):
		_bridge = Engine.get_singleton("ElpianGodotBridge")

func _process(_dt: float) -> void:
	if _bridge == null or _vm == null:
		return
	var json: String = _bridge.pollOps()
	if json.is_empty():
		return
	var msgs = JSON.parse_string(json)
	if typeof(msgs) != TYPE_ARRAY:
		return
	for m in msgs:
		_apply(m)

# A message is either a raw op {"op": {...}} or a surface mount
# {"mount": <godot-handle>} the host establishes for a Scene3D viewport.
func _apply(m: Dictionary) -> void:
	if m.has("mount"):
		var h := int(m["mount"])
		if not _seeded.has(h):
			_seeded[h] = true
			_vm.call("exec_op_json", JSON.stringify({"new": "Node3D", "def": h}))
			_vm.call("exec_op_json", JSON.stringify({"ref": SELF_HANDLE, "method": "add_child", "args": [{"ref": h}]}))
	elif m.has("op"):
		_vm.call("exec_op_json", JSON.stringify(m["op"]))
