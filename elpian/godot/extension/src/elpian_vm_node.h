/* elpian_vm_node.h — the ElpianVM scene node: drop it anywhere in a Godot
 * scene and point it at a Dart program; the program then drives the whole
 * engine through the reflective GodotController.
 *
 *   ElpianVM (Node)
 *     ├─ owns the Elpian VM instance (via the elpian-godot-capi C ABI)
 *     ├─ owns the GodotController servicing the guest's godot.* host calls
 *     ├─ per frame: flush bridged signal queue -> _process event -> VM pump
 *     └─ forwards _ready/_physics_process/_input/_unhandled_input/
 *        _notification/_exit_tree into the guest's GD.on* handlers
 *
 * The node is also scriptable from GDScript: exec_op_json() runs raw bridge
 * ops, invoke_guest() calls any guest function, audit_json() runs the ClassDB
 * coverage audit, and the `guest_log` / `vm_error` signals surface guest
 * output.
 */
#ifndef ELPIAN_VM_NODE_H
#define ELPIAN_VM_NODE_H

#include <godot_cpp/classes/input_event.hpp>
#include <godot_cpp/classes/node.hpp>
#include <godot_cpp/variant/string.hpp>

#include <memory>

#include "elpian_capi.h"
#include "godot_controller.h"

namespace elpian {

class ElpianVM : public godot::Node {
	GDCLASS(ElpianVM, godot::Node)

public:
	ElpianVM() = default;
	~ElpianVM() override;

	/* lifecycle -------------------------------------------------------- */
	void _ready() override;
	void _process(double delta) override;
	void _physics_process(double delta) override;
	void _input(const godot::Ref<godot::InputEvent> &event) override;
	void _unhandled_input(const godot::Ref<godot::InputEvent> &event) override;
	void _exit_tree() override;

	/* scripting surface -------------------------------------------------- */
	void start();
	void stop();
	void restart();
	bool is_running() const { return rt != nullptr; }
	godot::String exec_op_json(const godot::String &op_json);
	void invoke_guest(const godot::String &fn_name, const godot::String &json_arg);
	godot::String audit_json();

	/* properties ---------------------------------------------------------- */
	void set_script_path(const godot::String &p) { script_path = p; }
	godot::String get_script_path() const { return script_path; }
	void set_dart_source(const godot::String &s) { dart_source = s; }
	godot::String get_dart_source() const { return dart_source; }
	void set_autostart(bool v) { autostart = v; }
	bool get_autostart() const { return autostart; }
	void set_prepend_prelude(bool v) { prepend_prelude = v; }
	bool get_prepend_prelude() const { return prepend_prelude; }
	void set_max_host_calls(int64_t v) { max_host_calls = v; }
	int64_t get_max_host_calls() const { return max_host_calls; }
	void set_max_bytes_moved(int64_t v) { max_bytes_moved = v; }
	int64_t get_max_bytes_moved() const { return max_bytes_moved; }

protected:
	static void _bind_methods();
	void _notification(int p_what);

private:
	/* res:// path of the .dart program (preferred), or inline source below. */
	godot::String script_path;
	godot::String dart_source;
	bool autostart = true;
	bool prepend_prelude = true;
	/* Resource-governor bounds handed to the VM's meter (0 = unbounded). */
	int64_t max_host_calls = 0;
	int64_t max_bytes_moved = 0;

	ElpianGodotRuntime *rt = nullptr;
	std::unique_ptr<GodotController> controller;

	static char *host_trampoline(void *user, const char *api_name, const char *args_json);
	static void host_free_fn(void *user, char *s);

	void dispatch_event(const godot::String &name, const godot::Variant &payload_wire);
	void flush_callbacks();
	void drain_log();
	void fail(const godot::String &msg);
};

} // namespace elpian

#endif /* ELPIAN_VM_NODE_H */
