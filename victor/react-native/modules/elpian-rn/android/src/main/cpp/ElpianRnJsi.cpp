// JSI bridge for the native Elpian VM. Installs `global.__ElpianRN` — the
// synchronous binding NativeVmBackend (src/vm/nativeBackend.ts) drives — over
// the C ABI of libelpian_rn.so. The whole point of JSI here is synchronicity:
// the guest blocks on each host call's reply (e.g. a godot.op returns a node
// handle), so host_call must call back into JS in-line, which the async React
// Native bridge cannot do.
//
// Threading: everything runs on the JS thread. `create` stores the JS host
// function and registers a C shim with the VM; while `run`/`pump`/`invoke`
// execute, the VM calls that shim, which calls the stored JS function and hands
// its JSON reply back to Rust — all on this one thread — so the globals below
// are safe without locking.

#include <jni.h>
#include <jsi/jsi.h>

#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>

#include "elpian_rn_capi.h"

using namespace facebook;

namespace {

// The live JS-thread state the C host shim reaches (single JS thread — see file
// header). g_host is the JS callback passed to the current create().
jsi::Runtime *g_runtime = nullptr;
std::shared_ptr<jsi::Function> g_host;

// Opaque runtime handles handed to JS as small ints (a pointer would not fit a
// JS number safely).
std::unordered_map<int32_t, RnRuntime *> g_runtimes;
int32_t g_next_id = 1;

RnRuntime *lookup(int32_t id) {
  auto it = g_runtimes.find(id);
  return it == g_runtimes.end() ? nullptr : it->second;
}

// Read a library-owned length-prefixed buffer ([u32 LE len][bytes]) into a
// std::string and free it through the library's allocator.
std::string read_prefixed(uint8_t *ptr) {
  if (ptr == nullptr) return {};
  uint32_t len;
  std::memcpy(&len, ptr, 4);
  std::string out(reinterpret_cast<char *>(ptr + 4), len);
  elpian_rn_free_buf(ptr, 4 + len);
  return out;
}

// Build a library-owned length-prefixed reply buffer from a std::string.
uint8_t *emit_prefixed(const std::string &s) {
  const uint32_t len = static_cast<uint32_t>(s.size());
  uint8_t *ptr = elpian_rn_alloc(4 + len);
  std::memcpy(ptr, &len, 4);
  std::memcpy(ptr + 4, s.data(), len);
  return ptr;
}

// The C host shim the VM calls for every forwarded guest host call. Calls the
// stored JS host function synchronously and marshals its reply back to Rust.
uint8_t *host_shim(const uint8_t *name_ptr, size_t name_len,
                   const uint8_t *args_ptr, size_t args_len) {
  if (g_runtime == nullptr || !g_host) return nullptr;
  jsi::Runtime &rt = *g_runtime;
  try {
    jsi::String name = jsi::String::createFromUtf8(rt, name_ptr, name_len);
    jsi::String args = jsi::String::createFromUtf8(rt, args_ptr, args_len);
    jsi::Value reply = g_host->call(rt, name, args);
    if (reply.isString()) {
      return emit_prefixed(reply.getString(rt).utf8(rt));
    }
    return nullptr; // null/undefined → guest sees null
  } catch (const std::exception &) {
    return nullptr;
  }
}

std::string utf8(jsi::Runtime &rt, const jsi::Value &v) {
  return v.isString() ? v.getString(rt).utf8(rt) : std::string();
}

jsi::Value make_host_fn(jsi::Runtime &rt, const char *name, int argc,
                        jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, name), argc, std::move(fn));
}

} // namespace

namespace elpianrn {

void install(jsi::Runtime &rt) {
  g_runtime = &rt;
  jsi::Object api(rt);

  // create(source, lang, prepend, host) -> runtime id (0 on failure)
  api.setProperty(
      rt, "create",
      make_host_fn(rt, "create", 4,
                   [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     if (count < 4 || !args[3].isObject() ||
                         !args[3].getObject(rt).isFunction(rt)) {
                       return jsi::Value(0);
                     }
                     const std::string source = utf8(rt, args[0]);
                     const std::string lang = utf8(rt, args[1]);
                     const bool prepend = args[2].isBool() && args[2].getBool();
                     g_host = std::make_shared<jsi::Function>(
                         args[3].getObject(rt).getFunction(rt));
                     elpian_rn_set_host(host_shim);
                     RnRuntime *h = elpian_rn_new(
                         reinterpret_cast<const uint8_t *>(source.data()), source.size(),
                         reinterpret_cast<const uint8_t *>(lang.data()), lang.size(),
                         prepend ? 1 : 0);
                     if (h == nullptr) return jsi::Value(0);
                     int32_t id = g_next_id++;
                     g_runtimes[id] = h;
                     return jsi::Value(id);
                   }));

  api.setProperty(
      rt, "run",
      make_host_fn(rt, "run", 1,
                   [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     if (count >= 1) {
                       if (RnRuntime *h = lookup(static_cast<int32_t>(args[0].asNumber())))
                         elpian_rn_run(h);
                     }
                     return jsi::Value::undefined();
                   }));

  api.setProperty(
      rt, "pump",
      make_host_fn(rt, "pump", 2,
                   [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     if (count >= 2) {
                       if (RnRuntime *h = lookup(static_cast<int32_t>(args[0].asNumber())))
                         elpian_rn_pump(h, static_cast<uint64_t>(args[1].asNumber()));
                     }
                     return jsi::Value::undefined();
                   }));

  api.setProperty(
      rt, "invoke",
      make_host_fn(rt, "invoke", 3,
                   [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     if (count >= 3) {
                       RnRuntime *h = lookup(static_cast<int32_t>(args[0].asNumber()));
                       if (h != nullptr) {
                         const std::string fn = utf8(rt, args[1]);
                         const std::string arg = utf8(rt, args[2]);
                         elpian_rn_invoke(
                             h, reinterpret_cast<const uint8_t *>(fn.data()), fn.size(),
                             reinterpret_cast<const uint8_t *>(arg.data()), arg.size());
                       }
                     }
                     return jsi::Value::undefined();
                   }));

  // takeLog/stats/lastError return JSON strings ("" when none); JS parses them.
  api.setProperty(
      rt, "takeLog",
      make_host_fn(rt, "takeLog", 1,
                   [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     RnRuntime *h = count >= 1 ? lookup(static_cast<int32_t>(args[0].asNumber())) : nullptr;
                     std::string s = h ? read_prefixed(elpian_rn_take_log(h)) : std::string();
                     return jsi::String::createFromUtf8(rt, s);
                   }));

  api.setProperty(
      rt, "stats",
      make_host_fn(rt, "stats", 1,
                   [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     RnRuntime *h = count >= 1 ? lookup(static_cast<int32_t>(args[0].asNumber())) : nullptr;
                     std::string s = h ? read_prefixed(elpian_rn_stats(h)) : std::string();
                     return jsi::String::createFromUtf8(rt, s);
                   }));

  api.setProperty(
      rt, "lastError",
      make_host_fn(rt, "lastError", 1,
                   [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *,
                      size_t) -> jsi::Value {
                     return jsi::String::createFromUtf8(rt, read_prefixed(elpian_rn_last_error()));
                   }));

  api.setProperty(
      rt, "free",
      make_host_fn(rt, "free", 1,
                   [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args,
                      size_t count) -> jsi::Value {
                     if (count >= 1) {
                       int32_t id = static_cast<int32_t>(args[0].asNumber());
                       if (RnRuntime *h = lookup(id)) {
                         elpian_rn_free(h);
                         g_runtimes.erase(id);
                       }
                     }
                     return jsi::Value::undefined();
                   }));

  rt.global().setProperty(rt, "__ElpianRN", api);
}

} // namespace elpianrn

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_elpianrn_ElpianRnModule_nativeInstall(JNIEnv *, jobject, jlong jsiPtr) {
  if (jsiPtr != 0) {
    elpianrn::install(*reinterpret_cast<jsi::Runtime *>(jsiPtr));
  }
}
