package expo.modules.elpianrn

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Installs the synchronous JSI binding `global.__ElpianRN` (see
// cpp/ElpianRnJsi.cpp) that NativeVmBackend drives. The binding calls straight
// into the Rust VM (libelpian_rn.so) and calls back into JS in-line for each
// host call — the synchronous seam Hermes needs since it has no WebAssembly.
class ElpianRnModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ElpianRn")

    OnCreate {
      try {
        // Load the Rust VM first so the dynamic linker resolves it when the JSI
        // glue (which imports its C ABI) loads.
        System.loadLibrary("elpian_rn")
        System.loadLibrary("elpianrn_jsi")
      } catch (t: Throwable) {
        Log.e(TAG, "failed to load native libraries", t)
        return@OnCreate
      }
      val jsiPtr = appContext.reactContext?.javaScriptContextHolder?.get() ?: 0L
      if (jsiPtr == 0L) {
        // Bridgeless startup can hand us the runtime late; JS retries via
        // install() once it is up (see the module's index.ts).
        Log.w(TAG, "JS runtime not ready at OnCreate; awaiting install()")
        return@OnCreate
      }
      nativeInstall(jsiPtr)
    }

    // Fallback the JS side calls if the OnCreate install was too early: returns
    // true once __ElpianRN is installed.
    Function("install") {
      val jsiPtr = appContext.reactContext?.javaScriptContextHolder?.get() ?: 0L
      if (jsiPtr != 0L) {
        nativeInstall(jsiPtr)
        true
      } else {
        false
      }
    }
  }

  private external fun nativeInstall(jsiPtr: Long)

  companion object {
    private const val TAG = "ElpianRnModule"
  }
}
