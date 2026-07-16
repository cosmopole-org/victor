/* flutter_view.cpp — see flutter_view.h.
 *
 * The engine-facing code targets the stable Flutter Embedder C API
 * (`flutter_embedder.h`). It is compiled only under ELPIAN_WITH_FLUTTER; the
 * default build keeps an inert placeholder so the extension links without the
 * libflutter artifact. See godot/FLUTTER.md for how to obtain the engine
 * library, the ICU data, and the AOT snapshot of bridge/flutter_host, and how to
 * point the build at them.
 */

#include "flutter_view.h"

#include <godot_cpp/classes/engine.hpp>
#include <godot_cpp/classes/json.hpp>
#include <godot_cpp/classes/project_settings.hpp>
#include <godot_cpp/classes/time.hpp>
#include <godot_cpp/classes/window.hpp>
#include <godot_cpp/classes/input_event_mouse_button.hpp>
#include <godot_cpp/classes/input_event_mouse_motion.hpp>
#include <godot_cpp/classes/input_event_screen_touch.hpp>
#include <godot_cpp/classes/input_event_screen_drag.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <cstring>
#include <thread>

using namespace godot;

namespace elpian {

/* Platform-message channel names shared with the AOT host app
 * (bridge/flutter_host/lib/main.dart). */
static const char *CHANNEL_WIDGETS = "elpian/widgets"; /* host -> app: render */
static const char *CHANNEL_EVENTS = "elpian/events"; /* app -> host: widget fired */

FlutterView::~FlutterView() {
	shutdown();
}

/* ---- texture / metrics (renderer-agnostic) --------------------------------- */

void FlutterView::ensure_texture(int w, int h) {
	if (w <= 0 || h <= 0) {
		return;
	}
	if (image.is_valid() && surface_w == w && surface_h == h) {
		return;
	}
	surface_w = w;
	surface_h = h;
	back_buffer.assign((size_t)w * (size_t)h * 4, 0);
	image = Image::create_empty(w, h, false, Image::FORMAT_RGBA8);
	texture = ImageTexture::create_from_image(image);
	set_texture(texture);
}

void FlutterView::push_metrics() {
#ifdef ELPIAN_WITH_FLUTTER
	if (engine == nullptr) {
		return;
	}
	FlutterWindowMetricsEvent m = {};
	m.struct_size = sizeof(FlutterWindowMetricsEvent);
	m.width = (size_t)surface_w;
	m.height = (size_t)surface_h;
	m.pixel_ratio = device_pixel_ratio;
	FlutterEngineSendWindowMetricsEvent(engine, &m);
#endif
}

void FlutterView::set_metrics(double width, double height, double pixel_ratio) {
	device_pixel_ratio = pixel_ratio > 0.0 ? pixel_ratio : 1.0;
	ensure_texture((int)(width * device_pixel_ratio), (int)(height * device_pixel_ratio));
	push_metrics();
}

bool FlutterView::is_live() const {
#ifdef ELPIAN_WITH_FLUTTER
	return engine != nullptr;
#else
	return false;
#endif
}

/* =========================================================================== */
#ifndef ELPIAN_WITH_FLUTTER
/* -------- placeholder build: Flutter not compiled in ----------------------- */

bool FlutterView::start_engine(const String &) {
	UtilityFunctions::push_error(
			"[elpian] FlutterView: this build has no Flutter engine "
			"(rebuild with ELPIAN_WITH_FLUTTER and a libflutter artifact — see godot/FLUTTER.md).");
	return false;
}
void FlutterView::send_widget_tree(const String &) {}
void FlutterView::send_platform_message(const String &, const String &) {}
void FlutterView::shutdown() {}
void FlutterView::_process(double) {}
void FlutterView::_gui_input(const Ref<InputEvent> &) {}
void FlutterView::_notification(int) {}

#else
/* -------- real build: drive libflutter ------------------------------------- */

/* The main (platform) thread id, captured when the engine boots; the engine's
 * task runner asks whether it is currently on that thread. */
static std::thread::id g_main_thread;

bool FlutterView::start_engine(const String &opts_json) {
	if (engine != nullptr) {
		return true;
	}
	g_main_thread = std::this_thread::get_id();

	/* Parse the size we should render at. The guest passes a design space; we
	 * render at the node's own pixel size and let Flutter scale. Fall back to a
	 * reasonable default until the first resize notification. */
	const Vector2 sz = get_size();
	double w = sz.x > 0 ? sz.x : 720.0;
	double h = sz.y > 0 ? sz.y : 1280.0;
	device_pixel_ratio = get_window() ? get_window()->get_content_scale_factor() : 1.0;
	if (device_pixel_ratio <= 0.0) {
		device_pixel_ratio = 1.0;
	}
	ensure_texture((int)(w * device_pixel_ratio), (int)(h * device_pixel_ratio));

	/* Asset / ICU / AOT locations. These are project settings so a game can point
	 * at wherever it staged the engine bundle; sane res:// defaults otherwise. */
	ProjectSettings *ps = ProjectSettings::get_singleton();
	auto setting = [&](const char *key, const char *def) -> CharString {
		String v = ps->has_setting(key) ? (String)ps->get_setting(key) : String(def);
		return ps->globalize_path(v).utf8();
	};
	CharString assets = setting("elpian/flutter/assets_path", "res://flutter/flutter_assets");
	CharString icu = setting("elpian/flutter/icu_data_path", "res://flutter/icudtl.dat");
	CharString aot = setting("elpian/flutter/aot_library_path", "res://flutter/app.so");

	FlutterRendererConfig renderer = {};
	renderer.type = kSoftware;
	renderer.software.struct_size = sizeof(FlutterSoftwareRendererConfig);
	renderer.software.surface_present_callback = &FlutterView::present_thunk;

	/* Run every platform task on Godot's main thread via our queue, so the
	 * platform-message callback (which touches the scene) is always main-thread. */
	platform_runner = {};
	platform_runner.struct_size = sizeof(FlutterTaskRunnerDescription);
	platform_runner.user_data = this;
	platform_runner.runs_task_on_current_thread_callback = &FlutterView::runs_on_current_thread_thunk;
	platform_runner.post_task_callback = &FlutterView::post_task_thunk;
	custom_runners = {};
	custom_runners.struct_size = sizeof(FlutterCustomTaskRunners);
	custom_runners.platform_task_runner = &platform_runner;

	FlutterProjectArgs args = {};
	args.struct_size = sizeof(FlutterProjectArgs);
	args.assets_path = assets.get_data();
	args.icu_data_path = icu.get_data();
	args.platform_message_callback = &FlutterView::platform_message_thunk;
	args.custom_task_runners = &custom_runners;

	if (FlutterEngineRunsAOTCompiledDartCode()) {
		FlutterEngineAOTDataSource src = {};
		src.type = kFlutterEngineAOTDataSourceTypeElfPath;
		src.elf_path = aot.get_data();
		if (FlutterEngineCreateAOTData(&src, &aot_data) != kSuccess) {
			UtilityFunctions::push_error("[elpian] FlutterView: failed to load AOT data at " + String(aot.get_data()));
			return false;
		}
		args.aot_data = aot_data;
	}

	const FlutterEngineResult r =
			FlutterEngineRun(FLUTTER_ENGINE_VERSION, &renderer, &args, this, &engine);
	if (r != kSuccess || engine == nullptr) {
		UtilityFunctions::push_error("[elpian] FlutterView: FlutterEngineRun failed (code " + itos((int)r) + ")");
		engine = nullptr;
		if (aot_data != nullptr) {
			FlutterEngineCollectAOTData(aot_data);
			aot_data = nullptr;
		}
		return false;
	}
	push_metrics();
	return true;
}

void FlutterView::shutdown() {
	if (engine != nullptr) {
		FlutterEngineShutdown(engine);
		engine = nullptr;
	}
	if (aot_data != nullptr) {
		FlutterEngineCollectAOTData(aot_data);
		aot_data = nullptr;
	}
	{
		std::lock_guard<std::mutex> lock(task_mutex);
		tasks.clear();
	}
}

/* ---- platform-message send (host -> app) ---------------------------------- */

void FlutterView::send_widget_tree(const String &tree_json) {
	send_platform_message(String(CHANNEL_WIDGETS), tree_json);
}

void FlutterView::send_platform_message(const String &channel, const String &msg_json) {
	if (engine == nullptr) {
		return;
	}
	const CharString ch = channel.utf8();
	const CharString body = msg_json.utf8();
	FlutterPlatformMessage msg = {};
	msg.struct_size = sizeof(FlutterPlatformMessage);
	msg.channel = ch.get_data();
	msg.message = reinterpret_cast<const uint8_t *>(body.get_data());
	msg.message_size = (size_t)body.length();
	msg.response_handle = nullptr;
	FlutterEngineSendPlatformMessage(engine, &msg);
}

/* ---- platform-message receive (app -> host) ------------------------------- */

void FlutterView::platform_message_thunk(const FlutterPlatformMessage *message, void *user) {
	static_cast<FlutterView *>(user)->on_platform_message(message);
}

void FlutterView::on_platform_message(const FlutterPlatformMessage *message) {
	if (message == nullptr) {
		return;
	}
	const String channel = String::utf8(message->channel);
	if (channel == CHANNEL_EVENTS && event_sink) {
		/* The app posts one widget event as JSON: {"cb": <id>, "args": [ … ]}.
		 * `cb` is already the VM-namespaced id the FL facade tagged the handler
		 * with, so it routes straight back to the owning VM. */
		const String body = String::utf8(reinterpret_cast<const char *>(message->message), (int)message->message_size);
		Ref<godot::JSON> json;
		json.instantiate();
		if (json->parse(body) == OK && json->get_data().get_type() == Variant::DICTIONARY) {
			const Dictionary d = json->get_data();
			FlutterWidgetEvent ev;
			ev.cb_id = (int64_t)d.get("cb", 0);
			const Variant a = d.get("args", Array());
			ev.args_json = godot::JSON::stringify(a);
			event_sink(ev);
		}
	}
	/* Always release the app's response handle so its channel future completes. */
	complete_message(message->response_handle);
}

void FlutterView::complete_message(const FlutterPlatformMessageResponseHandle *handle) {
	if (engine == nullptr || handle == nullptr) {
		return;
	}
	FlutterEngineSendPlatformMessageResponse(engine, handle, nullptr, 0);
}

/* ---- software present (raster thread) ------------------------------------- */

bool FlutterView::present_thunk(void *user, const void *allocation, size_t row_bytes, size_t height) {
	return static_cast<FlutterView *>(user)->present(allocation, row_bytes, height);
}

bool FlutterView::present(const void *allocation, size_t row_bytes, size_t height) {
	/* Runs on the engine raster thread. Copy into the staging buffer under the
	 * lock; `_process` uploads it to the texture on the main thread. The software
	 * renderer hands us tightly-or-loosely packed 32-bit pixels; we repack to a
	 * tight RGBA8 buffer honoring `row_bytes`. (If a given engine build presents
	 * BGRA, swap R/B here — see FLUTTER.md; kept as a straight copy by default.) */
	std::lock_guard<std::mutex> lock(frame_mutex);
	const int w = surface_w;
	const int h = (int)height;
	if (w <= 0 || h <= 0) {
		return false;
	}
	back_buffer.resize((size_t)w * (size_t)h * 4);
	const uint8_t *src = static_cast<const uint8_t *>(allocation);
	const size_t tight = (size_t)w * 4;
	for (int y = 0; y < h; y++) {
		std::memcpy(&back_buffer[(size_t)y * tight], src + (size_t)y * row_bytes, tight);
	}
	frame_dirty = true;
	return true;
}

/* ---- per-frame: drain tasks, upload frame (main thread) -------------------- */

void FlutterView::run_due_tasks() {
	const uint64_t now = FlutterEngineGetCurrentTime();
	std::vector<PendingTask> due;
	{
		std::lock_guard<std::mutex> lock(task_mutex);
		std::vector<PendingTask> keep;
		for (const PendingTask &t : tasks) {
			if (t.target_time_nanos <= now) {
				due.push_back(t);
			} else {
				keep.push_back(t);
			}
		}
		tasks.swap(keep);
	}
	for (const PendingTask &t : due) {
		if (engine != nullptr) {
			FlutterEngineRunTask(engine, &t.task);
		}
	}
}

void FlutterView::post_task_thunk(FlutterTask task, uint64_t target_time_nanos, void *user) {
	FlutterView *self = static_cast<FlutterView *>(user);
	std::lock_guard<std::mutex> lock(self->task_mutex);
	self->tasks.push_back({ target_time_nanos, task });
}

bool FlutterView::runs_on_current_thread_thunk(void *) {
	return std::this_thread::get_id() == g_main_thread;
}

void FlutterView::_process(double) {
	if (engine == nullptr) {
		return;
	}
	run_due_tasks();
	std::lock_guard<std::mutex> lock(frame_mutex);
	if (frame_dirty && image.is_valid() && (int)back_buffer.size() == surface_w * surface_h * 4) {
		PackedByteArray pba;
		pba.resize(back_buffer.size());
		std::memcpy(pba.ptrw(), back_buffer.data(), back_buffer.size());
		image->set_data(surface_w, surface_h, false, Image::FORMAT_RGBA8, pba);
		texture->update(image);
		frame_dirty = false;
	}
}

/* ---- input forwarding ------------------------------------------------------ */

void FlutterView::_gui_input(const Ref<InputEvent> &event) {
	if (engine == nullptr || event.is_null()) {
		return;
	}
	FlutterPointerEvent p = {};
	p.struct_size = sizeof(FlutterPointerEvent);
	p.timestamp = (size_t)(FlutterEngineGetCurrentTime() / 1000); /* micros */
	bool send = false;

	Ref<InputEventMouseButton> mb = event;
	Ref<InputEventMouseMotion> mm = event;
	Ref<InputEventScreenTouch> st = event;
	Ref<InputEventScreenDrag> sd = event;
	if (mb.is_valid()) {
		const Vector2 pos = mb->get_position();
		p.x = pos.x * device_pixel_ratio;
		p.y = pos.y * device_pixel_ratio;
		p.device_kind = kFlutterPointerDeviceKindMouse;
		p.buttons = kFlutterPointerButtonMousePrimary;
		p.phase = mb->is_pressed() ? kDown : kUp;
		send = true;
	} else if (mm.is_valid()) {
		const Vector2 pos = mm->get_position();
		p.x = pos.x * device_pixel_ratio;
		p.y = pos.y * device_pixel_ratio;
		p.device_kind = kFlutterPointerDeviceKindMouse;
		const bool down = mm->get_button_mask().has_flag(MOUSE_BUTTON_MASK_LEFT);
		p.buttons = down ? kFlutterPointerButtonMousePrimary : 0;
		p.phase = down ? kMove : kHover;
		send = true;
	} else if (st.is_valid()) {
		const Vector2 pos = st->get_position();
		p.x = pos.x * device_pixel_ratio;
		p.y = pos.y * device_pixel_ratio;
		p.device_kind = kFlutterPointerDeviceKindTouch;
		p.device = st->get_index();
		p.phase = st->is_pressed() ? kDown : kUp;
		send = true;
	} else if (sd.is_valid()) {
		const Vector2 pos = sd->get_position();
		p.x = pos.x * device_pixel_ratio;
		p.y = pos.y * device_pixel_ratio;
		p.device_kind = kFlutterPointerDeviceKindTouch;
		p.device = sd->get_index();
		p.phase = kMove;
		send = true;
	}
	if (send) {
		FlutterEngineSendPointerEvent(engine, &p, 1);
		accept_event();
	}
}

void FlutterView::_notification(int what) {
	if (what == NOTIFICATION_RESIZED) {
		const Vector2 sz = get_size();
		set_metrics(sz.x, sz.y, device_pixel_ratio);
	}
}

#endif /* ELPIAN_WITH_FLUTTER */

} // namespace elpian
