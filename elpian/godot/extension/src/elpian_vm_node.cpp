/* elpian_vm_node.cpp — see elpian_vm_node.h. */

#include "elpian_vm_node.h"

#include <godot_cpp/classes/engine.hpp>
#include <godot_cpp/classes/file_access.hpp>
#include <godot_cpp/classes/json.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <cstdlib>
#include <cstring>

using namespace godot;

namespace elpian {

/* Node notifications already delivered through dedicated hooks; forwarding
 * them again through _notification would double per-frame VM calls. */
static bool is_redundant_notification(int what) {
	return what == Node::NOTIFICATION_PROCESS || what == Node::NOTIFICATION_PHYSICS_PROCESS ||
			what == Node::NOTIFICATION_INTERNAL_PROCESS ||
			what == Node::NOTIFICATION_INTERNAL_PHYSICS_PROCESS;
}

ElpianVM::~ElpianVM() {
	if (rt != nullptr) {
		elpian_godot_free(rt);
		rt = nullptr;
	}
}

void ElpianVM::_bind_methods() {
	godot::ClassDB::bind_method(D_METHOD("start"), &ElpianVM::start);
	godot::ClassDB::bind_method(D_METHOD("stop"), &ElpianVM::stop);
	godot::ClassDB::bind_method(D_METHOD("restart"), &ElpianVM::restart);
	godot::ClassDB::bind_method(D_METHOD("is_running"), &ElpianVM::is_running);
	godot::ClassDB::bind_method(D_METHOD("exec_op_json", "op_json"), &ElpianVM::exec_op_json);
	godot::ClassDB::bind_method(D_METHOD("invoke_guest", "fn_name", "json_arg"),
			&ElpianVM::invoke_guest);
	godot::ClassDB::bind_method(D_METHOD("audit_json"), &ElpianVM::audit_json);

	godot::ClassDB::bind_method(D_METHOD("set_script_path", "path"), &ElpianVM::set_script_path);
	godot::ClassDB::bind_method(D_METHOD("get_script_path"), &ElpianVM::get_script_path);
	godot::ClassDB::bind_method(D_METHOD("set_dart_source", "source"), &ElpianVM::set_dart_source);
	godot::ClassDB::bind_method(D_METHOD("get_dart_source"), &ElpianVM::get_dart_source);
	godot::ClassDB::bind_method(D_METHOD("set_autostart", "value"), &ElpianVM::set_autostart);
	godot::ClassDB::bind_method(D_METHOD("get_autostart"), &ElpianVM::get_autostart);
	godot::ClassDB::bind_method(D_METHOD("set_prepend_prelude", "value"),
			&ElpianVM::set_prepend_prelude);
	godot::ClassDB::bind_method(D_METHOD("get_prepend_prelude"), &ElpianVM::get_prepend_prelude);
	godot::ClassDB::bind_method(D_METHOD("set_max_host_calls", "value"),
			&ElpianVM::set_max_host_calls);
	godot::ClassDB::bind_method(D_METHOD("get_max_host_calls"), &ElpianVM::get_max_host_calls);
	godot::ClassDB::bind_method(D_METHOD("set_max_bytes_moved", "value"),
			&ElpianVM::set_max_bytes_moved);
	godot::ClassDB::bind_method(D_METHOD("get_max_bytes_moved"), &ElpianVM::get_max_bytes_moved);

	ADD_PROPERTY(PropertyInfo(Variant::STRING, "script_path",
						 PROPERTY_HINT_FILE, "*.dart"),
			"set_script_path", "get_script_path");
	ADD_PROPERTY(PropertyInfo(Variant::STRING, "dart_source",
						 PROPERTY_HINT_MULTILINE_TEXT),
			"set_dart_source", "get_dart_source");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "autostart"), "set_autostart", "get_autostart");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "prepend_prelude"), "set_prepend_prelude",
			"get_prepend_prelude");
	ADD_PROPERTY(PropertyInfo(Variant::INT, "max_host_calls"), "set_max_host_calls",
			"get_max_host_calls");
	ADD_PROPERTY(PropertyInfo(Variant::INT, "max_bytes_moved"), "set_max_bytes_moved",
			"get_max_bytes_moved");

	ADD_SIGNAL(MethodInfo("guest_log", PropertyInfo(Variant::STRING, "line")));
	ADD_SIGNAL(MethodInfo("vm_error", PropertyInfo(Variant::STRING, "message")));
}

/* ---- the C callback pair handed to the Rust runtime ----------------------- */

char *ElpianVM::host_trampoline(void *user, const char *api_name, const char *args_json) {
	ElpianVM *self = static_cast<ElpianVM *>(user);
	if (self == nullptr || self->controller == nullptr) {
		return nullptr;
	}
	const String reply = self->controller->service(String::utf8(api_name), String::utf8(args_json));
	const CharString utf8 = reply.utf8();
	char *buf = static_cast<char *>(std::malloc(utf8.length() + 1));
	if (buf == nullptr) {
		return nullptr;
	}
	std::memcpy(buf, utf8.get_data(), utf8.length() + 1);
	return buf;
}

void ElpianVM::host_free_fn(void *, char *s) {
	std::free(s);
}

/* ---- lifecycle ------------------------------------------------------------- */

void ElpianVM::_ready() {
	if (Engine::get_singleton()->is_editor_hint()) {
		return; /* never execute guest code inside the editor */
	}
	set_process(true);
	set_physics_process(true);
	set_process_input(true);
	set_process_unhandled_input(true);
	if (autostart) {
		start();
	}
}

void ElpianVM::start() {
	if (rt != nullptr) {
		return;
	}
	String source = dart_source;
	if (!script_path.is_empty()) {
		source = FileAccess::get_file_as_string(script_path);
		if (source.is_empty()) {
			fail(String("could not read Dart program at ") + script_path);
			return;
		}
	}
	if (source.is_empty()) {
		fail("no Dart program: set script_path or dart_source");
		return;
	}

	controller = std::make_unique<GodotController>(this);
	const CharString utf8 = source.utf8();
	rt = elpian_godot_new(utf8.get_data(), prepend_prelude ? 1 : 0,
			(uint64_t)max_host_calls, (uint64_t)max_bytes_moved);
	if (rt == nullptr) {
		fail(String("Elpian VM boot failed: ") + String::utf8(elpian_godot_last_error()));
		controller.reset();
		return;
	}
	elpian_godot_set_host(rt, &ElpianVM::host_trampoline, &ElpianVM::host_free_fn, this);

	if (elpian_godot_run(rt) != 0) {
		fail(String("guest main() failed: ") + String::utf8(elpian_godot_last_error()));
	}
	drain_log();
	flush_callbacks();
	dispatch_event("_ready", Variant());
	flush_callbacks();
	drain_log();
}

void ElpianVM::stop() {
	if (rt == nullptr) {
		return;
	}
	dispatch_event("_exit_tree", Variant());
	elpian_godot_free(rt);
	rt = nullptr;
	controller.reset();
}

void ElpianVM::restart() {
	stop();
	start();
}

void ElpianVM::_exit_tree() {
	stop();
}

void ElpianVM::_process(double delta) {
	if (rt == nullptr) {
		return;
	}
	flush_callbacks(); /* bridged signals queued since last frame */
	dispatch_event("_process", delta);
	/* Advance the guest clock by the real frame delta so guest Timers / Future
	 * continuations fire on elapsed time (delta is seconds; the VM clock is ms). */
	elpian_godot_pump(rt, (uint64_t)(delta * 1000.0));
	flush_callbacks();
	drain_log();
}

void ElpianVM::_physics_process(double delta) {
	if (rt == nullptr) {
		return;
	}
	dispatch_event("_physics_process", delta);
}

void ElpianVM::_input(const Ref<InputEvent> &event) {
	if (rt == nullptr || event.is_null() || controller == nullptr) {
		return;
	}
	dispatch_event("_input", controller->to_wire(Variant(event)));
	flush_callbacks();
}

void ElpianVM::_unhandled_input(const Ref<InputEvent> &event) {
	if (rt == nullptr || event.is_null() || controller == nullptr) {
		return;
	}
	dispatch_event("_unhandled_input", controller->to_wire(Variant(event)));
	flush_callbacks();
}

void ElpianVM::_notification(int p_what) {
	if (rt == nullptr || is_redundant_notification(p_what)) {
		return;
	}
	dispatch_event("_notification", (int64_t)p_what);
}

/* ---- guest dispatch --------------------------------------------------------- */

void ElpianVM::dispatch_event(const String &name, const Variant &payload_wire) {
	if (rt == nullptr) {
		return;
	}
	Array arg;
	arg.push_back(name);
	arg.push_back(payload_wire);
	const CharString fn = String("__godotEvent").utf8();
	const CharString json = JSON::stringify(arg).utf8();
	elpian_godot_invoke(rt, fn.get_data(), json.get_data());
}

void ElpianVM::flush_callbacks() {
	if (rt == nullptr || controller == nullptr) {
		return;
	}
	/* Bound the drain: a guest callback may synchronously trigger engine calls
	 * that queue further callbacks; a pathological loop must not hang the
	 * frame (mirrors the VM's own pump budget). */
	int budget = 10000;
	while (controller != nullptr && controller->has_queued() && budget-- > 0) {
		std::deque<QueuedCallback> events = controller->take_queue();
		for (const QueuedCallback &ev : events) {
			if (rt == nullptr || controller == nullptr) {
				return;
			}
			Array arg;
			arg.push_back(ev.cb_id);
			arg.push_back(controller->to_wire(ev.args));
			const CharString fn = String("__godotDispatch").utf8();
			const CharString json = JSON::stringify(arg).utf8();
			elpian_godot_invoke(rt, fn.get_data(), json.get_data());
		}
	}
}

void ElpianVM::drain_log() {
	if (rt == nullptr) {
		return;
	}
	char *log_json = elpian_godot_take_log(rt);
	if (log_json == nullptr) {
		return;
	}
	const Variant parsed = JSON::parse_string(String::utf8(log_json));
	elpian_godot_string_free(log_json);
	if (parsed.get_type() != Variant::ARRAY) {
		return;
	}
	const Array lines = parsed;
	for (int i = 0; i < lines.size(); i++) {
		const String line = lines[i];
		UtilityFunctions::print(String("[elpian] ") + line);
		emit_signal("guest_log", line);
	}
}

void ElpianVM::fail(const String &msg) {
	UtilityFunctions::push_error(String("[elpian] ") + msg);
	emit_signal("vm_error", msg);
}

/* ---- scripting surface -------------------------------------------------------- */

String ElpianVM::exec_op_json(const String &op_json) {
	if (controller == nullptr) {
		return "null";
	}
	const Variant parsed = JSON::parse_string(op_json);
	if (parsed.get_type() != Variant::DICTIONARY) {
		return "null";
	}
	return JSON::stringify(controller->exec_op((Dictionary)parsed));
}

void ElpianVM::invoke_guest(const String &fn_name, const String &json_arg) {
	if (rt == nullptr) {
		return;
	}
	const CharString fn = fn_name.utf8();
	const CharString json = json_arg.utf8();
	elpian_godot_invoke(rt, fn.get_data(), json.get_data());
	flush_callbacks();
	drain_log();
}

String ElpianVM::audit_json() {
	if (controller == nullptr) {
		/* The audit needs no VM — allow it on a stopped node too. */
		GodotController tmp(this);
		return JSON::stringify(tmp.audit());
	}
	return JSON::stringify(controller->audit());
}

} // namespace elpian
