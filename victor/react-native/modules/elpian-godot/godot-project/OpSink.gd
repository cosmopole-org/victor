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
var _frame := 0
var _first := ""   # raw first op batch (to inspect actual device handles)
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
	if not json.is_empty():
		if _first == "":
			_first = json.substr(0, 220)
		var msgs = JSON.parse_string(json)
		if typeof(msgs) == TYPE_ARRAY:
			for m in msgs:
				_apply(m)
	# The guest's G3.camera sets current=true BEFORE add_child, which can fail to
	# register the active camera once it enters the tree — leaving the viewport
	# with no camera (renders grey). Force the first camera current each frame.
	_ensure_camera()
	# Report the built scene back to the RN overlay ~1x/sec (diagnostics). Call
	# report() directly: Godot Android plugin methods are callable but has_method()
	# returns false for them, so a has_method guard silently skips the call.
	_frame += 1
	if _frame % 60 == 0:
		_bridge.call("report", _summarize())

func _ensure_camera() -> void:
	var cam = _find_camera(_sink)
	if cam != null and not cam.current:
		cam.make_current()

func _find_camera(n: Node):
	if n is Camera3D:
		return n
	for c in n.get_children():
		var r = _find_camera(c)
		if r != null:
			return r
	return null

func _summarize() -> String:
	var total := 0
	var cams := 0
	var cur := 0
	var meshes := 0
	var envs := 0
	var campos := "-"
	var stack: Array = [_sink]
	while not stack.is_empty():
		var n = stack.pop_back()
		total += 1
		if n is Camera3D:
			cams += 1
			if n.current:
				cur += 1
				campos = str(n.global_position)
		if n is MeshInstance3D:
			meshes += 1
		if n is WorldEnvironment:
			envs += 1
		for c in n.get_children():
			stack.push_back(c)
	var vp = get_viewport().get_visible_rect().size if get_viewport() != null else Vector2.ZERO
	return "nodes=%d cam=%d/%d mesh=%d env=%d vp=%s mounts=%s first=%s" % [total, cur, cams, meshes, envs, str(vp), str(_seeded.keys()), _first]

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
