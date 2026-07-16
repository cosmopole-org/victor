/* flutter_controller.cpp — see flutter_controller.h. */

#include "flutter_controller.h"

#include <godot_cpp/classes/json.hpp>
#include <godot_cpp/classes/control.hpp>
#include <godot_cpp/core/memory.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include "flutter_view.h"
#include "godot_controller.h"

using namespace godot;

namespace elpian {

static Variant dart_error(const String &msg) {
	Dictionary d;
	d["__dart_error__"] = msg;
	return d;
}

FlutterController::FlutterController(Node *host_node_, GodotController *godot_ctl_) :
		host_node(host_node_), godot_ctl(godot_ctl_) {}

FlutterController::~FlutterController() {
	for (auto &kv : views) {
		if (kv.second != nullptr) {
			kv.second->shutdown();
			kv.second->queue_free();
		}
	}
	views.clear();
}

/* ---- host-call entry ------------------------------------------------------- */

String FlutterController::service(const String &api_name, const String &args_json) {
	Ref<godot::JSON> json;
	json.instantiate();
	if (json->parse(args_json) != OK) {
		return JSON::stringify(dart_error("flutter: bad args JSON"));
	}
	const Variant parsed = json->get_data();
	if (parsed.get_type() != Variant::ARRAY) {
		return JSON::stringify(dart_error("flutter: args must be an array"));
	}
	const Array args = parsed;

	if (api_name == "flutter.op") {
		const Variant op = args.size() > 0 ? args[0] : Variant();
		if (op.get_type() != Variant::DICTIONARY) {
			return JSON::stringify(dart_error("flutter.op: op must be an object"));
		}
		return JSON::stringify(exec_op((Dictionary)op));
	}
	if (api_name == "flutter.batch") {
		const Variant list = args.size() > 0 ? args[0] : Variant();
		if (list.get_type() != Variant::ARRAY) {
			return JSON::stringify(dart_error("flutter.batch: expected an array of ops"));
		}
		const Array ops = list;
		Array results;
		for (int i = 0; i < ops.size(); i++) {
			if (ops[i].get_type() == Variant::DICTIONARY) {
				results.push_back(exec_op((Dictionary)ops[i]));
			} else {
				results.push_back(dart_error("flutter.batch: op must be an object"));
			}
		}
		return JSON::stringify(results);
	}
	return JSON::stringify(Variant());
}

Variant FlutterController::exec_op(const Dictionary &op) {
	if (op.has("newview")) {
		return op_newview(op);
	}
	if (op.has("render")) {
		return op_render(op);
	}
	if (op.has("call")) {
		return op_call(op);
	}
	if (op.has("resize")) {
		return op_resize(op);
	}
	if (op.has("disposeview")) {
		return op_dispose(op);
	}
	return dart_error("flutter: unknown op");
}

/* ---- ops ------------------------------------------------------------------- */

Variant FlutterController::op_newview(const Dictionary &op) {
	const int64_t id = (int64_t)op.get("def", 0);
	if (id == 0) {
		return dart_error("flutter newview: missing def id");
	}
	if (views.count(id) != 0) {
		return dart_error("flutter newview: id already in use");
	}

	/* Resolve the Godot node the surface mounts under, honouring the sandbox. */
	Node *parent = host_node;
	const Variant pref = op.get("parent", Variant());
	if (pref.get_type() == Variant::DICTIONARY) {
		const Dictionary pd = pref;
		if (pd.has("ref")) {
			const int64_t handle = (int64_t)pd["ref"];
			const int64_t sbx = op.has("__sbx") ? (int64_t)op["__sbx"] : 0;
			String err;
			Object *obj = godot_ctl->resolve_handle_checked(handle, sbx, &err);
			Node *n = Object::cast_to<Node>(obj);
			if (n == nullptr) {
				return dart_error(String("flutter newview: parent ") + (err.is_empty() ? String("is not a Node") : err));
			}
			parent = n;
		}
	}

	FlutterView *view = memnew(FlutterView);
	view->set_name(String("FlutterView_") + String::num_int64(id));
	/* Fill the parent when it is a Control; otherwise sit at origin sized by the
	 * guest via resize(). */
	view->set_anchors_preset(Control::PRESET_FULL_RECT);
	parent->add_child(view);

	/* Route widget events back through the SAME queue bridged Godot signals use,
	 * so the ElpianVM node's existing flush delivers them via __godotDispatch to
	 * the owning VM. `cb_id` is already VM-namespaced by the Rust manager. */
	GodotController *gc = godot_ctl;
	view->set_event_sink([gc](const FlutterWidgetEvent &ev) {
		Ref<godot::JSON> json;
		json.instantiate();
		Array args;
		if (json->parse(ev.args_json) == OK && json->get_data().get_type() == Variant::ARRAY) {
			args = json->get_data();
		}
		gc->queue_callback(ev.cb_id, args);
	});

	const String opts = JSON::stringify(op.get("opts", Dictionary()));
	if (!view->start_engine(opts)) {
		view->queue_free();
		return dart_error("flutter newview: engine failed to start (see log)");
	}
	views[id] = view;
	return id;
}

FlutterView *FlutterController::view_of(const Dictionary &op, const char *key) {
	const int64_t id = (int64_t)op.get(key, 0);
	auto it = views.find(id);
	return it == views.end() ? nullptr : it->second;
}

Variant FlutterController::op_render(const Dictionary &op) {
	FlutterView *view = view_of(op, "render");
	if (view == nullptr) {
		return dart_error("flutter render: unknown view");
	}
	view->send_widget_tree(JSON::stringify(op.get("tree", Dictionary())));
	return Variant();
}

Variant FlutterController::op_call(const Dictionary &op) {
	FlutterView *view = view_of(op, "call");
	if (view == nullptr) {
		return dart_error("flutter call: unknown view");
	}
	const String channel = op.get("channel", "");
	view->send_platform_message(channel, JSON::stringify(op.get("msg", Variant())));
	return Variant();
}

Variant FlutterController::op_resize(const Dictionary &op) {
	FlutterView *view = view_of(op, "resize");
	if (view == nullptr) {
		return dart_error("flutter resize: unknown view");
	}
	const Array size = op.get("size", Array());
	const double dpr = (double)op.get("dpr", 1.0);
	if (size.size() >= 2) {
		view->set_metrics((double)size[0], (double)size[1], dpr <= 0 ? 1.0 : dpr);
	}
	return Variant();
}

Variant FlutterController::op_dispose(const Dictionary &op) {
	const int64_t id = (int64_t)op.get("disposeview", 0);
	auto it = views.find(id);
	if (it == views.end()) {
		return Variant();
	}
	if (it->second != nullptr) {
		it->second->shutdown();
		it->second->queue_free();
	}
	views.erase(it);
	return Variant();
}

} // namespace elpian
