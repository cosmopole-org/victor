// JSI bridge for the native widget toolkit. Installs global.__ElpianWidgets
// (which NativeWidgetRenderer drives): the VM enqueues widget ops on the JS
// thread; the native VictorSurfaceView controller drains them on the UI thread
// (JNI nativePollOps) and builds android.view.View trees. Widget events flow the
// other way — the controller enqueues them (JNI nativePushEvent) and the JS side
// drains them each frame (pollEvents) — so there is no native→JS cross-thread
// call. Two mutex-guarded queues are the only shared state.

#include <jsi/jsi.h>

#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#if defined(__ANDROID__)
#include <jni.h>
#endif

using namespace facebook;

namespace {

// Per-mini-app queues: appId → messages. Each mini app (isolated VM) drives its
// own VictorSurface, so ops/events are routed by appId and one mini app's poll
// never drains another's. A lone app uses appId "main".
std::mutex g_op_mutex;
std::map<std::string, std::vector<std::string>> g_ops; // JS → controller (widget ops)
std::mutex g_ev_mutex;
std::map<std::string, std::vector<std::string>> g_events; // controller → JS (widget events)

std::string join_array(std::vector<std::string> &items) {
  std::string out;
  out.reserve(items.size() * 48 + 2);
  out.push_back('[');
  for (size_t i = 0; i < items.size(); ++i) {
    if (i) out.push_back(',');
    out += items[i];
  }
  out.push_back(']');
  return out;
}

std::string utf8(jsi::Runtime &rt, const jsi::Value &v) {
  return v.isString() ? v.getString(rt).utf8(rt) : std::string();
}

} // namespace

namespace elpianwidgets {

void install(jsi::Runtime &rt) {
  jsi::Object api(rt);

  // op(appId, json): enqueue one widget op for appId's UI-thread controller.
  api.setProperty(
      rt, "op",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "op"), 2,
          [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) -> jsi::Value {
            if (n >= 2) {
              std::string app = utf8(rt, args[0]);
              std::lock_guard<std::mutex> lock(g_op_mutex);
              g_ops[app].push_back(utf8(rt, args[1]));
            }
            return jsi::Value::undefined();
          }));

  // pollEvents(appId): drain appId's queued widget events as a JSON array (or ""
  // when none).
  api.setProperty(
      rt, "pollEvents",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "pollEvents"), 1,
          [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) -> jsi::Value {
            std::string out;
            {
              std::string app = n >= 1 ? utf8(rt, args[0]) : std::string("main");
              std::lock_guard<std::mutex> lock(g_ev_mutex);
              auto it = g_events.find(app);
              if (it == g_events.end() || it->second.empty())
                return jsi::String::createFromAscii(rt, "");
              out = join_array(it->second);
              it->second.clear();
            }
            return jsi::String::createFromUtf8(rt, out);
          }));

  api.setProperty(rt, "viewName", jsi::String::createFromAscii(rt, "VictorSurfaceView"));
  rt.global().setProperty(rt, "__ElpianWidgets", api);
}

// Platform-agnostic queue accessors the host surface (Android VictorSurfaceView
// over JNI; iOS VictorSurface over ObjC++) calls to drain ops / enqueue events
// for one mini app. The op/pollEvents *JSI* side above is shared verbatim.
std::string drain_ops(const std::string &app) {
  std::lock_guard<std::mutex> lock(g_op_mutex);
  auto it = g_ops.find(app);
  if (it == g_ops.end() || it->second.empty()) return {};
  std::string out = join_array(it->second);
  it->second.clear();
  return out;
}

void push_event(const std::string &app, int id, const std::string &event,
                const char *argJson) {
  std::string elem = "[" + std::to_string(id) + ",\"" + event + "\"," +
                     std::string(argJson && argJson[0] ? argJson : "null") + "]";
  std::lock_guard<std::mutex> lock(g_ev_mutex);
  g_events[app].push_back(std::move(elem));
}

} // namespace elpianwidgets

#if defined(__ANDROID__)
// Android: the Kotlin module hands us the JSI runtime pointer, and the
// VictorSurfaceView drains ops / pushes events over JNI (→ shared accessors).
extern "C" JNIEXPORT void JNICALL
Java_expo_modules_elpianwidgets_ElpianWidgetsModule_nativeInstall(JNIEnv *, jobject, jlong jsiPtr) {
  if (jsiPtr != 0) {
    elpianwidgets::install(*reinterpret_cast<jsi::Runtime *>(jsiPtr));
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_elpianwidgets_VictorSurfaceView_nativePollOps(JNIEnv *env, jobject, jstring appId) {
  const char *app = env->GetStringUTFChars(appId, nullptr);
  std::string out = elpianwidgets::drain_ops(app);
  env->ReleaseStringUTFChars(appId, app);
  return env->NewStringUTF(out.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_elpianwidgets_VictorSurfaceView_nativePushEvent(
    JNIEnv *env, jobject, jstring appId, jint id, jstring event, jstring argJson) {
  const char *app = env->GetStringUTFChars(appId, nullptr);
  const char *e = env->GetStringUTFChars(event, nullptr);
  const char *a = argJson ? env->GetStringUTFChars(argJson, nullptr) : nullptr;
  elpianwidgets::push_event(app, id, e, a);
  env->ReleaseStringUTFChars(event, e);
  if (argJson) env->ReleaseStringUTFChars(argJson, a);
  env->ReleaseStringUTFChars(appId, app);
}
#endif // __ANDROID__

// iOS: the ObjC++ module resolves the runtime and calls these plain-C entries
// (no JNI). Same shared install / queue accessors on both platforms.
extern "C" void ElpianWidgetsInstall(void *jsiRuntimePtr) {
  if (jsiRuntimePtr != nullptr) {
    elpianwidgets::install(*reinterpret_cast<jsi::Runtime *>(jsiRuntimePtr));
  }
}

// Returns a malloc'd C string (JSON array, or "" when none) the caller frees.
extern "C" const char *ElpianWidgetsDrainOps(const char *appId) {
  std::string out = elpianwidgets::drain_ops(appId ? appId : "main");
  char *buf = static_cast<char *>(malloc(out.size() + 1));
  std::memcpy(buf, out.c_str(), out.size() + 1);
  return buf;
}

extern "C" void ElpianWidgetsPushEvent(const char *appId, int id, const char *event,
                                       const char *argJson) {
  elpianwidgets::push_event(appId ? appId : "main", id, event ? event : "", argJson);
}
