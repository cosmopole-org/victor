package expo.modules.elpiangodot

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
  }

  companion object {
    private const val TAG = "ElpianGodotView"
  }
}
