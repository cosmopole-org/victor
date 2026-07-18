# Godot Android plugin (v2) export hook for ElpianWebView — the OS-native
# Android WebView overlay VUI.webview uses on mobile. At Android export time
# this contributes the plugin AAR to the gradle build; the AAR's manifest
# carries the camera/microphone permissions and the plugin registration
# meta-data. Non-Android exports are untouched.
#
# The AAR is NOT committed: build it with
#   gradle -p ../android/webview assembleRelease
# and copy build/outputs/aar/webview-release.aar to
#   res://addons/elpian_webview_android/bin/ElpianWebView.release.aar
# (.github/workflows/android-apk.yml does exactly this in CI).
@tool
extends EditorPlugin

var export_plugin: AndroidExportPlugin


func _enter_tree() -> void:
	export_plugin = AndroidExportPlugin.new()
	add_export_plugin(export_plugin)


func _exit_tree() -> void:
	remove_export_plugin(export_plugin)
	export_plugin = null


class AndroidExportPlugin extends EditorExportPlugin:
	const PLUGIN_NAME := "ElpianWebView"
	# Relative to res://addons/ (the EditorExportPlugin convention).
	const AAR_PATH := "elpian_webview_android/bin/ElpianWebView.release.aar"

	func _supports_platform(platform: EditorExportPlatform) -> bool:
		return platform is EditorExportPlatformAndroid

	func _get_android_libraries(platform: EditorExportPlatform, debug: bool) -> PackedStringArray:
		if not FileAccess.file_exists("res://addons/" + AAR_PATH):
			push_warning("ElpianWebView AAR missing (res://addons/%s) — the export will not include the native webview; build it from bridge/android/webview." % AAR_PATH)
			return PackedStringArray()
		return PackedStringArray([AAR_PATH])

	func _get_name() -> String:
		return PLUGIN_NAME
