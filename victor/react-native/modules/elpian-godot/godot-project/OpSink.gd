# Op-sink: the embedded engine's content. Each frame it drains godot.op messages
# the React Native side queued (via the ElpianGodotBridge JNI singleton) and
# applies them to THIS live 3D scene through the reflective GodotController
# (ElpianScene3D.exec_op_json).
#
# ElpianScene3D owns ONLY the op interpreter — no Elpian VM. The single Elpian VM
# lives in the React Native app and drives everything; Godot is just the 3D
# widget servicing its ops. (Using the full ElpianVM node here would embed a
# second, redundant VM inside Godot.)
extends Node3D

var _sink
var _bridge
var _seeded := {}
const SELF_HANDLE := 1

func _ready() -> void:
	if not ClassDB.class_exists("ElpianScene3D"):
		push_error("ElpianScene3D (elpian_godot GDExtension) not loaded")
		return
	_sink = ClassDB.instantiate("ElpianScene3D")
	add_child(_sink)                                  # in-tree → its children render
	_sink.call("exec_op_json", JSON.stringify({"self": true, "def": SELF_HANDLE}))
	if Engine.has_singleton("ElpianGodotBridge"):
		_bridge = Engine.get_singleton("ElpianGodotBridge")

func _process(_dt: float) -> void:
	if _bridge == null or _sink == null:
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
			_sink.call("exec_op_json", JSON.stringify({"new": "Node3D", "def": h}))
			_sink.call("exec_op_json", JSON.stringify({"ref": SELF_HANDLE, "method": "add_child", "args": [{"ref": h}]}))
	elif m.has("op"):
		_sink.call("exec_op_json", JSON.stringify(m["op"]))
