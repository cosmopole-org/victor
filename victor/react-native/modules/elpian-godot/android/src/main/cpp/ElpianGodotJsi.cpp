// JSI bridge for the embedded Godot engine. Installs `global.__ElpianGodot`
// (which GodotScene3dEngineCore drives) and a JNI drain the Godot-side OpSink
// polls. The RN side enqueues 3D ops here fire-and-forget; the embedded Godot
// engine (on its own render thread) drains the queue each frame and applies the
// ops through the reflective GodotController — so no synchronous cross-thread
// call into Godot is needed. The queue is the one shared point between the JS
// thread (push) and the Godot thread (poll), guarded by a mutex.

#include <jni.h>
#include <jsi/jsi.h>

#include <mutex>
#include <string>
#include <vector>

using namespace facebook;

namespace {

std::mutex g_mutex;
std::vector<std::string> g_queue; // each entry is one JSON message object
jsi::Runtime *g_runtime = nullptr;

void enqueue(std::string message) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_queue.push_back(std::move(message));
}

std::string utf8(jsi::Runtime &rt, const jsi::Value &v) {
  return v.isString() ? v.getString(rt).utf8(rt) : std::string();
}

jsi::Value host_fn(jsi::Runtime &rt, const char *name, int argc,
                   jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, name), argc, std::move(fn));
}

} // namespace

namespace elpiangodot {

void install(jsi::Runtime &rt) {
  g_runtime = &rt;
  jsi::Object api(rt);

  // op(opJson): enqueue the op wrapped as { "op": <op> } for the engine.
  api.setProperty(
      rt, "op",
      host_fn(rt, "op", 1,
              [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
                 size_t count) -> jsi::Value {
                if (count >= 1) enqueue("{\"op\":" + utf8(rt, args[0]) + "}");
                return jsi::Value::undefined();
              }));

  // mountSurface(surfaceId, mountNode): the host establishes a viewport root;
  // the engine seeds a Node3D under the scene for that handle.
  api.setProperty(
      rt, "mountSurface",
      host_fn(rt, "mountSurface", 2,
              [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args,
                 size_t count) -> jsi::Value {
                if (count >= 2) {
                  long node = static_cast<long>(args[1].asNumber());
                  enqueue("{\"mount\":" + std::to_string(node) + "}");
                }
                return jsi::Value::undefined();
              }));

  api.setProperty(
      rt, "releaseSurface",
      host_fn(rt, "releaseSurface", 1,
              [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args,
                 size_t count) -> jsi::Value {
                if (count >= 1) {
                  long s = static_cast<long>(args[0].asNumber());
                  enqueue("{\"release\":" + std::to_string(s) + "}");
                }
                return jsi::Value::undefined();
              }));

  // The registered native view component that shows the Godot viewport.
  api.setProperty(rt, "viewName", jsi::String::createFromAscii(rt, "ElpianGodotView"));

  rt.global().setProperty(rt, "__ElpianGodot", api);
}

} // namespace elpiangodot

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_elpiangodot_ElpianGodotModule_nativeInstall(JNIEnv *, jobject, jlong jsiPtr) {
  if (jsiPtr != 0) {
    elpiangodot::install(*reinterpret_cast<jsi::Runtime *>(jsiPtr));
  }
}

// Drain the op queue for the Godot-side OpSink (ElpianGodotBridge.pollOps).
// Returns a JSON array string of the pending messages, or "" when none.
extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_elpiangodot_ElpianGodotBridge_nativePollOps(JNIEnv *env, jobject) {
  std::string out;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_queue.empty()) {
      return env->NewStringUTF("");
    }
    out.reserve(g_queue.size() * 32 + 2);
    out.push_back('[');
    for (size_t i = 0; i < g_queue.size(); ++i) {
      if (i) out.push_back(',');
      out += g_queue[i];
    }
    out.push_back(']');
    g_queue.clear();
  }
  return env->NewStringUTF(out.c_str());
}
