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
    // Godot's engine startup calls setRequestedOrientation on the host activity
    // from its embed project's handheld/orientation setting. Belt-and-suspenders:
    // re-assert portrait after Godot has initialized (it flips orientation a beat
    // after attach), so the app never gets stuck in landscape even if the pck
    // setting is ignored in embedded mode.
    lockPortrait(activity)
    postDelayed({ appContext.currentActivity?.let { lockPortrait(it) } }, 2000)
  }

  private fun lockPortrait(activity: android.app.Activity) {
    try {
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    } catch (t: Throwable) {
      Log.w(TAG, "could not lock portrait", t)
    }
  }

  companion object {
    private const val TAG = "ElpianGodotView"
  }
}
