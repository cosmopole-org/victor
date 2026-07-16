/* flutter_view.h — a Godot node that embeds a real Flutter engine and paints it
 * into the scene.
 *
 *   FlutterView (TextureRect)
 *     ├─ owns a FlutterEngine instance (the Flutter Embedder C API, embedder.h)
 *     ├─ runs a FIXED, AOT-compiled Flutter "interpreter app" (bridge/flutter_host)
 *     │  that turns declarative widget-tree messages into real Flutter widgets
 *     ├─ software compositor: the engine rasterizes each frame into a CPU
 *     │  buffer → an Image → this TextureRect's ImageTexture (works on every
 *     │  Godot renderer + platform; a GPU zero-copy path is planned, see below)
 *     ├─ forwards Godot input (_gui_input) → FlutterEngineSendPointerEvent
 *     ├─ reports size / DPI  → FlutterEngineSendWindowMetricsEvent
 *     └─ bridges platform messages both ways on the "elpian/widgets"
 *        (host→app: render this tree) and "elpian/events" (app→host: a widget
 *        fired) channels.
 *
 * This is the native half of the **Flutter UI bridge** (the guest half is
 * `victor/bridge/prelude/flutter.js`, the `FL` facade). It is the twin of the
 * GodotController, but where that drives ClassDB reflectively, this drives a
 * Flutter engine over a small declarative widget protocol — because Flutter's
 * widget framework is AOT Dart with no runtime reflection surface to address by
 * name (see godot/FLUTTER.md, "Why a registry and not reflection").
 *
 * No-JIT contract: the Flutter side is AOT-compiled (App-Store-legal); all
 * dynamic program code stays on the Elpian VM. The engine only ever receives
 * *data* (serialized widget trees), never code.
 *
 * ## Build gating
 *
 * Everything that touches `embedder.h` is compiled only when ELPIAN_WITH_FLUTTER
 * is defined (and the libflutter engine artifact + the AOT snapshot of
 * bridge/flutter_host are available — see CMakeLists.txt / SConstruct). Without
 * it the class still registers and behaves as an inert placeholder, so the
 * extension builds and runs unchanged on targets that do not ship Flutter.
 */
#ifndef ELPIAN_FLUTTER_VIEW_H
#define ELPIAN_FLUTTER_VIEW_H

#include <godot_cpp/classes/image.hpp>
#include <godot_cpp/classes/image_texture.hpp>
#include <godot_cpp/classes/input_event.hpp>
#include <godot_cpp/classes/texture_rect.hpp>
#include <godot_cpp/variant/string.hpp>

#include <cstdint>
#include <functional>
#include <mutex>
#include <vector>

#ifdef ELPIAN_WITH_FLUTTER
#include "flutter_embedder.h"
#endif

namespace elpian {

/* One widget event coming back from the embedded app: the guest callback id the
 * `FL` facade tagged the handler with (already namespaced into the owning VM's
 * id space by the Rust VmManager on the way in) and its JSON argument list. The
 * FlutterController hands these to the GodotController's callback queue so the
 * ElpianVM node dispatches them through the very same `__godotDispatch` path as
 * bridged Godot signals. */
struct FlutterWidgetEvent {
	int64_t cb_id = 0;
	godot::String args_json; /* a JSON array */
};

class FlutterView : public godot::TextureRect {
	GDCLASS(FlutterView, godot::TextureRect)

public:
	FlutterView() = default;
	~FlutterView() override;

	/* Sink for widget events; the controller installs one that forwards into the
	 * GodotController queue. Called on the platform (main) thread. */
	using EventSink = std::function<void(const FlutterWidgetEvent &)>;
	void set_event_sink(EventSink sink) { event_sink = std::move(sink); }

	/* Boot the engine with `opts_json` ({design:[w,h], transparent, gpu, …}).
	 * Returns false (and pushes an error) if Flutter is unavailable or the engine
	 * failed to start. */
	bool start_engine(const godot::String &opts_json);

	/* Ship one serialized widget tree to the app (the "render" op). */
	void send_widget_tree(const godot::String &tree_json);

	/* Send a raw platform message on `channel` (the "call" op escape hatch). */
	void send_platform_message(const godot::String &channel, const godot::String &msg_json);

	/* Explicit metrics override (the "resize" op); normally driven automatically
	 * from the node's own size / DPI. */
	void set_metrics(double width, double height, double pixel_ratio);

	void shutdown();
	bool is_live() const;

	/* lifecycle / input ------------------------------------------------------ */
	void _process(double delta) override;
	void _gui_input(const godot::Ref<godot::InputEvent> &event) override;
	void _notification(int what);

protected:
	static void _bind_methods() {}

private:
	EventSink event_sink;

	/* The design space the guest laid the UI out in; the engine renders at the
	 * node's pixel size and Flutter's own MediaQuery/one-logical-pixel scaling
	 * plus this ratio map the design space to the surface. */
	double device_pixel_ratio = 1.0;
	int64_t surface_w = 0;
	int64_t surface_h = 0;

	/* Software-compositor staging. The engine's present callback (on the render
	 * task-runner thread) writes `back_buffer` under `frame_mutex`; `_process`
	 * (main thread) uploads it into `texture`. `frame_dirty` gates the upload. */
	std::mutex frame_mutex;
	std::vector<uint8_t> back_buffer; /* RGBA8, surface_w*surface_h*4 */
	bool frame_dirty = false;
	godot::Ref<godot::Image> image;
	godot::Ref<godot::ImageTexture> texture;

	void ensure_texture(int w, int h);
	void push_metrics();

#ifdef ELPIAN_WITH_FLUTTER
	FlutterEngine engine = nullptr;
	FlutterEngineAOTData aot_data = nullptr;
	/* Kept as members: the embedder reads these during FlutterEngineRun and they
	 * must remain valid for the duration of the call. */
	FlutterTaskRunnerDescription platform_runner{};
	FlutterCustomTaskRunners custom_runners{};

	/* Custom task runner: the engine posts platform-thread tasks here and
	 * `_process` runs the ones now due, so all engine callbacks that touch this
	 * node happen on Godot's main thread. */
	struct PendingTask {
		uint64_t target_time_nanos = 0;
		FlutterTask task{};
	};
	std::mutex task_mutex;
	std::vector<PendingTask> tasks;
	void run_due_tasks();

	/* embedder.h C callbacks (static thunks → instance methods). */
	static bool present_thunk(void *user, const void *allocation, size_t row_bytes, size_t height);
	static void platform_message_thunk(const FlutterPlatformMessage *message, void *user);
	static void post_task_thunk(FlutterTask task, uint64_t target_time_nanos, void *user);
	static bool runs_on_current_thread_thunk(void *user);

	bool present(const void *allocation, size_t row_bytes, size_t height);
	void on_platform_message(const FlutterPlatformMessage *message);

	/* Reply to (or drop) an engine platform-message handle. */
	void complete_message(const FlutterPlatformMessageResponseHandle *handle);
#endif
};

} // namespace elpian

#endif /* ELPIAN_FLUTTER_VIEW_H */
