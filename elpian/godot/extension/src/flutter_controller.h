/* flutter_controller.h — services the guest's `flutter.*` host calls.
 *
 * The twin of GodotController, on the same host-call seam: the ElpianVM node's
 * trampoline routes `flutter.op` / `flutter.batch` here (everything else goes to
 * GodotController). This interprets the small declarative widget-op protocol the
 * `FL` guest facade (`prelude/flutter.js`) speaks and drives one embedded
 * Flutter engine per view (a `FlutterView` node), plus routes widget events back
 * into the *same* callback queue bridged Godot signals use — so one dispatch
 * path (`__godotDispatch`) and one VM sandbox model serve both UIs.
 *
 *   {"newview": true, "def": id, "parent": {"ref": h}, "opts": {…}}
 *        create a FlutterView under the Godot node `h` (resolved, and sandbox-
 *        checked, through the GodotController), boot its engine, return `id`.
 *   {"render": viewId, "tree": <serialized widget tree>}
 *        ship the tree to the view's engine as a platform message.
 *   {"call": viewId, "channel": s, "msg": v}   raw platform message
 *   {"resize": viewId, "size": [w,h], "dpr": r} drive window metrics
 *   {"disposeview": viewId}                    shut the engine + free the node
 *
 * Handles: the guest chooses positive view ids (already namespaced per-VM by the
 * Rust VmManager, exactly like Godot handles), the host may mint negatives; both
 * index the same table. `"__sbx"` on an op is honoured for the parent-node
 * resolve so a sandboxed VM can only mount a surface inside its own subtree.
 */
#ifndef ELPIAN_FLUTTER_CONTROLLER_H
#define ELPIAN_FLUTTER_CONTROLLER_H

#include <godot_cpp/classes/node.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include <godot_cpp/variant/string.hpp>
#include <godot_cpp/variant/variant.hpp>

#include <unordered_map>

namespace elpian {

class GodotController;
class FlutterView;

class FlutterController {
public:
	/* `host_node` is the ElpianVM node (Flutter views are added under it or under
	 * the op's resolved parent). `godot_ctl` resolves `{"ref": h}` parent handles
	 * and receives widget events into its callback queue. */
	FlutterController(godot::Node *host_node, GodotController *godot_ctl);
	~FlutterController();

	/* Service one host call: api_name ∈ {flutter.op, flutter.batch}. */
	godot::String service(const godot::String &api_name, const godot::String &args_json);

	/* Execute one already-parsed op; errors return {"__dart_error__": …}. */
	godot::Variant exec_op(const godot::Dictionary &op);

private:
	godot::Node *host_node = nullptr;
	GodotController *godot_ctl = nullptr;

	std::unordered_map<int64_t, FlutterView *> views;
	int64_t next_host_id = -1;

	godot::Variant op_newview(const godot::Dictionary &op);
	godot::Variant op_render(const godot::Dictionary &op);
	godot::Variant op_call(const godot::Dictionary &op);
	godot::Variant op_resize(const godot::Dictionary &op);
	godot::Variant op_dispose(const godot::Dictionary &op);

	FlutterView *view_of(const godot::Dictionary &op, const char *key);
};

} // namespace elpian

#endif /* ELPIAN_FLUTTER_CONTROLLER_H */
