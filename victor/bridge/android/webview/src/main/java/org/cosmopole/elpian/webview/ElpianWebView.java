/*
 * ElpianWebView — Godot 4 Android plugin (v2) exposing the OS-native Android
 * System WebView as an in-app overlay, so Elpian guests (via VUI.webview in
 * victor's ui.js prelude) can open web content — video-conference rooms,
 * OAuth flows, docs — without bundling a browser engine.
 *
 * The overlay is pure platform UI layered over the Godot activity: a slim
 * dark title bar (title, OPEN IN BROWSER, CLOSE) above a full-bleed WebView.
 * Closing is handled natively (like the web export's DOM iframe path), so no
 * callback needs to cross back into the VM; a `webview_closed` signal is
 * emitted for guests that want to react.
 *
 * WebRTC pages (BigBlueButton et al) get camera/microphone through
 * WebChromeClient.onPermissionRequest, granted only for capture resources the
 * app itself holds; `open` requests the missing runtime permissions on first
 * use so a second join attempt succeeds after the user accepts. Screen
 * capture (getDisplayMedia) is not available in Android WebView.
 */
package org.cosmopole.elpian.webview;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.godotengine.godot.Godot;
import org.godotengine.godot.plugin.GodotPlugin;
import org.godotengine.godot.plugin.SignalInfo;
import org.godotengine.godot.plugin.UsedByGodot;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Set;

public class ElpianWebView extends GodotPlugin {

    private static final int PERMISSION_REQUEST_CODE = 0x0E1B;

    private FrameLayout overlay;
    private WebView webView;

    public ElpianWebView(Godot godot) {
        super(godot);
    }

    @Override
    public String getPluginName() {
        return "ElpianWebView";
    }

    @Override
    public Set<SignalInfo> getPluginSignals() {
        return Collections.singleton(new SignalInfo("webview_closed"));
    }

    /** Open `url` in a full-screen native webview overlay titled `title`. */
    @UsedByGodot
    public boolean open(final String url, final String title) {
        final Activity activity = getActivity();
        if (activity == null || url == null || url.isEmpty()) {
            return false;
        }
        requestMissingMediaPermissions(activity);
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                showOverlay(activity, url, title == null || title.isEmpty() ? url : title);
            }
        });
        return true;
    }

    /** Close the overlay if one is open. */
    @UsedByGodot
    public boolean close() {
        final Activity activity = getActivity();
        if (activity == null || overlay == null) {
            return false;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                removeOverlay();
            }
        });
        return true;
    }

    @UsedByGodot
    public boolean isOpen() {
        return overlay != null;
    }

    /* The webview page can only capture media the APP is allowed to capture:
     * ask for the missing runtime permissions up front so the in-page WebRTC
     * permission grant (onPermissionRequest below) has something to grant. */
    private void requestMissingMediaPermissions(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return;
        }
        ArrayList<String> missing = new ArrayList<String>();
        for (String permission : new String[] {
                android.Manifest.permission.CAMERA,
                android.Manifest.permission.RECORD_AUDIO }) {
            if (activity.checkSelfPermission(permission)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        if (!missing.isEmpty()) {
            activity.requestPermissions(missing.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
    }

    private boolean holdsPermission(Activity activity, String permission) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || activity.checkSelfPermission(permission)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private int dp(Activity activity, float value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics());
    }

    private void showOverlay(final Activity activity, final String url, final String title) {
        removeOverlay();

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0B0B10"));

        // Title bar: title | OPEN IN BROWSER | CLOSE.
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#15151D"));
        int pad = dp(activity, 10);
        bar.setPadding(pad, 0, pad, 0);

        TextView titleView = new TextView(activity);
        titleView.setText(title);
        titleView.setTextColor(Color.WHITE);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        bar.addView(titleView, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button browserButton = new Button(activity);
        browserButton.setText("OPEN IN BROWSER");
        browserButton.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                }
            }
        });
        bar.addView(browserButton);

        Button closeButton = new Button(activity);
        closeButton.setText("CLOSE");
        closeButton.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                removeOverlay();
            }
        });
        bar.addView(closeButton);

        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 48)));

        // The system WebView (Chromium), configured for WebRTC conference
        // frontends: JS, storage, and media autoplay without a user gesture.
        webView = new WebView(activity);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient()); // keep navigation in-view
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Grant the page only the capture resources the APP holds;
                // never forward grants the user has not given the app itself.
                ArrayList<String> grant = new ArrayList<String>();
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                            && holdsPermission(activity, android.Manifest.permission.CAMERA)) {
                        grant.add(resource);
                    } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                            && holdsPermission(activity, android.Manifest.permission.RECORD_AUDIO)) {
                        grant.add(resource);
                    }
                }
                if (grant.isEmpty()) {
                    request.deny();
                } else {
                    request.grant(grant.toArray(new String[0]));
                }
            }
        });
        webView.loadUrl(url);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        overlay = new FrameLayout(activity);
        overlay.addView(root, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        activity.addContentView(overlay, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void removeOverlay() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        if (overlay != null) {
            ViewGroup parent = (ViewGroup) overlay.getParent();
            if (parent != null) {
                parent.removeView(overlay);
            }
            overlay = null;
            emitSignal("webview_closed");
        }
    }
}
