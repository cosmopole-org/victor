/* elpian_scene3d.h — a Scene3D op-sink node that owns ONLY the reflective
 * GodotController, no Elpian VM.
 *
 * This is the node the React Native host embeds: the single Elpian VM lives in
 * the React Native app and drives everything; Godot is just a 3D widget that
 * services the guest's `godot.*` ops. So on the Godot side we need the op
 * interpreter (GodotController) but NOT another VM — instantiating the full
 * `ElpianVM` node here would embed a second, redundant VM inside Godot (a VM
 * wrapped by Godot wrapped by React Native), which is exactly the topology the
 * architecture avoids.
 *
 *   React Native (owns the Elpian VM) --godot.op--> ElpianScene3D.exec_op_json
 *                                                    --> GodotController --> 3D
 */
#ifndef ELPIAN_SCENE3D_H
#define ELPIAN_SCENE3D_H

#include <godot_cpp/classes/node.hpp>
#include <godot_cpp/variant/string.hpp>

#include <memory>

#include "godot_controller.h"

namespace elpian {

class ElpianScene3D : public godot::Node {
	GDCLASS(ElpianScene3D, godot::Node)

public:
	ElpianScene3D() = default;
	~ElpianScene3D() override = default;

	void _ready() override;

	/* Service one bridge op (the same JSON op vocabulary the VM emits over
	 * `godot.op`) against this node's subtree, returning its JSON reply. */
	godot::String exec_op_json(const godot::String &op_json);

protected:
	static void _bind_methods();

private:
	std::unique_ptr<GodotController> controller;
	GodotController *ensure_controller();
};

} // namespace elpian

#endif // ELPIAN_SCENE3D_H
