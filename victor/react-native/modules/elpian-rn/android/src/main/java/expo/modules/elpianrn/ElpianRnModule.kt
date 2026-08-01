package expo.modules.elpianrn

import android.util.Log
import com.facebook.react.bridge.ReactContext
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
      // Best-effort early install; JS calls install() again once the runtime is
      // definitely up (bridgeless can hand it to us late). Ignore the result.
      tryInstall()
    }

    // JS-callable install: loads the native libs and installs global.__ElpianRN,
    // returning a status string so the app can surface exactly what happened.
    // "ok" = installed; anything else is the reason it did not.
    Function("install") { tryInstall() }
  }

  private fun tryInstall(): String {
    try {
      System.loadLibrary("elpian_rn")
      System.loadLibrary("elpianrn_jsi")
    } catch (t: Throwable) {
      Log.e(TAG, "loadLibrary failed", t)
      return "loadLibrary: ${t.message}"
    }
    val reactContext = appContext.reactContext as? ReactContext
      ?: return "no-react-context"
    val jsiPtr = reactContext.javaScriptContextHolder?.get() ?: 0L
    if (jsiPtr == 0L) return "no-runtime-pointer(bridgeless=${reactContext.isBridgeless})"
    return try {
      nativeInstall(jsiPtr)
      "ok"
    } catch (t: Throwable) {
      Log.e(TAG, "nativeInstall failed", t)
      "nativeInstall: ${t.message}"
    }
  }

  private external fun nativeInstall(jsiPtr: Long)

  companion object {
    private const val TAG = "ElpianRnModule"
  }
}
