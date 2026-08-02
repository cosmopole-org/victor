package expo.modules.elpiangodot

import android.content.pm.ActivityInfo
import android.content.Context
import android.util.Log
import android.view.View
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

// The React Native view that hosts the embedded Godot viewport. RN sizes/places
// it where a <Scene3D/> renders; we attach an ElpianGodotFragment into it once
// it is in the window so Godot draws its 3D scene inside this box.
class ElpianGodotView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private var attached = false

  init {
    id = View.generateViewId()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (attached) return
    val activity = appContext.currentActivity as? FragmentActivity
    if (activity == null) {
      Log.w(TAG, "no FragmentActivity; cannot host Godot")
      return
    }
    attached = true
    try {
      activity.supportFragmentManager
        .beginTransaction()
        .replace(id, ElpianGodotFragment(), "elpian-godot")
        .commitAllowingStateLoss()
    } catch (t: Throwable) {
      Log.e(TAG, "failed to attach GodotFragment", t)
    }
    // Godot's engine startup forces the host activity to landscape (embedded mode
    // ignores the pck's handheld/orientation, confirmed on device). We can't stop
    // that call, so we out-last it: re-assert portrait across the whole init
    // window. Godot sets orientation only once at startup, so once these re-asserts
    // cover that moment, portrait sticks.
    for (delay in longArrayOf(0, 500, 1000, 2000, 3500, 5000, 8000)) {
      postDelayed({ appContext.currentActivity?.let { lockPortrait(it) } }, delay)
    }
  }

  private fun lockPortrait(activity: android.app.Activity) {
    try {
      if (activity.requestedOrientation != ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) {
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      }
    } catch (t: Throwable) {
      Log.w(TAG, "could not lock portrait", t)
    }
  }

  companion object {
    private const val TAG = "ElpianGodotView"
  }
}
