package expo.modules.elpianwidgets

import android.content.Context
import android.view.Choreographer
import android.view.ViewGroup
import com.google.android.flexbox.FlexboxLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray

// The React Native view that hosts the VM-driven native widget tree. RN mounts
// ONE of these (no React below it); each frame it drains the widget ops the VM
// queued (nativePollOps) and applies them to a real android.view.View tree via
// WidgetController. Widget events are pushed back (nativePushEvent) for the JS
// side to poll into the VM.
class VictorSurfaceView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private val root = FlexboxLayout(context)
  private val controller = WidgetController(context, root, this)
  private var frameCb: Choreographer.FrameCallback? = null

  // The mini-app scope this surface hosts (matches NativeWidgetRenderer's appId).
  // Ops/events are routed by it so many mini apps can share the one JSI binding.
  // A lone app (the showcase) uses "main".
  var appId: String = "main"

  init {
    addView(
      root,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    startLoop()
  }

  override fun onDetachedFromWindow() {
    frameCb?.let { Choreographer.getInstance().removeFrameCallback(it) }
    frameCb = null
    super.onDetachedFromWindow()
  }

  private fun startLoop() {
    val cb = object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        drainOps()
        if (frameCb != null) Choreographer.getInstance().postFrameCallback(this)
      }
    }
    frameCb = cb
    Choreographer.getInstance().postFrameCallback(cb)
  }

  private fun drainOps() {
    val json = nativePollOps(appId)
    if (json.isEmpty()) return
    try {
      val arr = JSONArray(json)
      for (i in 0 until arr.length()) controller.apply(arr.getJSONObject(i))
    } catch (_: Throwable) {
      /* malformed batch — skip */
    }
  }

  /** Called by WidgetController on a widget event; queued for this app's JS poll. */
  fun pushEvent(id: Int, event: String, argJson: String?) = nativePushEvent(appId, id, event, argJson)

  private external fun nativePollOps(appId: String): String
  private external fun nativePushEvent(appId: String, id: Int, event: String, argJson: String?)

  companion object {
    init {
      System.loadLibrary("elpianwidgets_jsi")
    }
  }
}
