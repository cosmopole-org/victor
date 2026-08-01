// C ABI of the Elpian VM native library (libelpian_rn.so), built from
// victor/react-native/native/elpian-rn. Mirrors the `#[no_mangle] extern "C"`
// surface of that crate's src/lib.rs — keep the two in sync.
//
// Every string that crosses the boundary is a length-prefixed buffer:
// [u32 little-endian byte length][utf-8 bytes]. Buffers the library returns are
// freed with elpian_rn_free_buf; buffers we hand back from host_call are
// allocated with elpian_rn_alloc (the library frees them).
#ifndef ELPIAN_RN_CAPI_H
#define ELPIAN_RN_CAPI_H

#include <cstddef>
#include <cstdint>

extern "C" {

typedef struct RnRuntime RnRuntime;

// The native host callback the JSI layer registers via elpian_rn_set_host.
// Receives (name, args_json) as UTF-8 pointer/length pairs and returns a
// length-prefixed reply buffer (allocated with elpian_rn_alloc) or null.
typedef uint8_t *(*ElpianRnHostFn)(const uint8_t *name_ptr, size_t name_len,
                                   const uint8_t *args_ptr, size_t args_len);

uint8_t *elpian_rn_alloc(size_t len);
void elpian_rn_free_buf(uint8_t *ptr, size_t total);
void elpian_rn_set_host(ElpianRnHostFn cb);

RnRuntime *elpian_rn_new(const uint8_t *src_ptr, size_t src_len,
                         const uint8_t *lang_ptr, size_t lang_len, int32_t prepend);
int32_t elpian_rn_run(RnRuntime *rt);
int32_t elpian_rn_pump(RnRuntime *rt, uint64_t delta_ms);
int32_t elpian_rn_invoke(RnRuntime *rt, const uint8_t *fn_ptr, size_t fn_len,
                         const uint8_t *arg_ptr, size_t arg_len);
uint8_t *elpian_rn_take_log(RnRuntime *rt);
uint8_t *elpian_rn_stats(RnRuntime *rt);
uint8_t *elpian_rn_last_error(void);
void elpian_rn_free(RnRuntime *rt);

} // extern "C"

#endif // ELPIAN_RN_CAPI_H
