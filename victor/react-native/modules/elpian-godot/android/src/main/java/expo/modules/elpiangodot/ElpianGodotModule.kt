package expo.modules.elpiangodot

import android.util.Log
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Installs the JSI binding global.__ElpianGodot (see cpp/ElpianGodotJsi.cpp),
// which GodotScene3dEngineCore drives, and registers the ElpianGodotView that
// hosts the embedded engine. install() returns a status string so the app can
// report exactly what happened.
class ElpianGodotModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ElpianGodot")

    OnCreate { tryInstall() }

    Function("install") { tryInstall() }

    View(ElpianGodotView::class) {
      // The Scene3D surface has no props to forward yet; RN drives the 3D world
      // through the VM's op stream, not view props.
    }
  }

  private fun tryInstall(): String {
    try {
      System.loadLibrary("elpiangodot_jsi")
    } catch (t: Throwable) {
      Log.e(TAG, "loadLibrary failed", t)
      return "loadLibrary: ${t.message}"
    }
    val reactContext = appContext.reactContext as? ReactContext ?: return "no-react-context"
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
    private const val TAG = "ElpianGodotModule"
  }
}
