/* elpian_capi.h — C ABI of the Elpian VM's Dart runtime (elpian-godot-capi).
 *
 * Mirrors the `#[no_mangle] extern "C"` surface of
 * `elpian/godot/capi/src/lib.rs` — keep the two in sync. Link against the
 * static (or shared) library produced by:
 *
 *     cargo build -p elpian-godot-capi --release
 *     # → target/release/libelpian_godot.a / .so / .dylib / elpian_godot.lib
 *
 * Threading contract: one runtime belongs to one thread (Godot's main thread).
 */
#ifndef ELPIAN_CAPI_H
#define ELPIAN_CAPI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handle over the whole VM TREE one node hosts: the root VM plus every
 * child VM the tree spawns via askHost("vm.spawn", ...). Lifecycle events
 * (__godotEvent) broadcast to all live VMs; namespaced callback dispatch
 * (__godotDispatch) routes to the owning VM; pump ticks the whole tree and
 * runs the hierarchy's aggregate-budget sweep. */
typedef struct ElpianGodotRuntime ElpianGodotRuntime;

/* Service one guest host call: (user, api_name, args_json) -> reply JSON.
 * Return NULL to decline (the guest sees `null`). The returned buffer is
 * released through the paired ElpianGodotHostFreeFn. */
typedef char *(*ElpianGodotHostFn)(void *user, const char *api_name, const char *args_json);

/* Release a buffer returned by ElpianGodotHostFn (same allocator). */
typedef void (*ElpianGodotHostFreeFn)(void *user, char *s);

/* Create a VM tree whose root runs guest_source. prepend_prelude != 0
 * composes the godot.dart prelude ahead of the program. max_host_calls /
 * max_bytes_moved bound the root's resource meter (0 = unbounded). NULL on
 * error — see elpian_godot_last_error(). */
ElpianGodotRuntime *elpian_godot_new(const char *guest_source, int prepend_prelude,
                                     uint64_t max_host_calls, uint64_t max_bytes_moved);

/* Register the host callback servicing the guest's godot.* calls. */
void elpian_godot_set_host(ElpianGodotRuntime *rt, ElpianGodotHostFn host_fn,
                           ElpianGodotHostFreeFn free_fn, void *user);

/* Run the guest's main() and drain its event loop. 0 = ok. */
int elpian_godot_run(ElpianGodotRuntime *rt);

/* Invoke a named guest function with one JSON argument (missing functions are
 * a no-op). Delivers lifecycle events (__godotEvent) and bridged signal
 * emissions (__godotDispatch). 0 = ok. */
int elpian_godot_invoke(ElpianGodotRuntime *rt, const char *fn_name, const char *json_arg);

/* Advance the guest clock by delta_ms (the engine frame delta) and fire the
 * timers/microtasks that became due — call once per engine frame. 0 = ok. */
int elpian_godot_pump(ElpianGodotRuntime *rt, uint64_t delta_ms);

/* New guest print/log lines since the last call — from every VM in the tree,
 * child lines prefixed "[vm<id>:<label>]" — as a JSON string array (caller
 * frees with elpian_godot_string_free). NULL when nothing new. */
char *elpian_godot_take_log(ElpianGodotRuntime *rt);

/* JSON snapshot of the whole VM tree (ids, labels, states, per-VM and
 * aggregate usage) for host-side dashboards. Caller frees with
 * elpian_godot_string_free. */
char *elpian_godot_stats_json(ElpianGodotRuntime *rt);

/* Last error for this thread ("" when none). Borrowed — do not free. */
const char *elpian_godot_last_error(void);

/* Free a string returned by this library. */
void elpian_godot_string_free(char *s);

/* Destroy the VM tree (terminating the root terminates every descendant). */
void elpian_godot_free(ElpianGodotRuntime *rt);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* ELPIAN_CAPI_H */
