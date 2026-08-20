//go:build wasip1

// Test-only reactor ABI over the real generated creature `process()`. Copied
// next to an unmodified creature main.go and built with
//   GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared
// so the integration test can drive the REAL tools registry creature from JS
// with a fake Caspar `hostCall` (getJson/putJson) shim. Not part of any deploy.
package main

import "unsafe"

var hin [1 << 18]byte
var hout [1 << 18]byte
var hres [1 << 18]byte

//go:wasmexport hinptr
func hinptr() uint32 { return uint32(uintptr(unsafe.Pointer(&hin[0]))) }

//go:wasmexport houtptr
func houtptr() uint32 { return uint32(uintptr(unsafe.Pointer(&hout[0]))) }

//go:wasmexport hresptr
func hresptr() uint32 { return uint32(uintptr(unsafe.Pointer(&hres[0]))) }

// handle runs the creature's real process() over the request bytes staged in
// `hin` and stages the reply JSON in `hout`, returning its length.
//
//go:wasmexport handle
func handle(n uint32) uint32 {
	out := process(string(hin[:n]))
	copy(hout[:], out)
	return uint32(len(out))
}
