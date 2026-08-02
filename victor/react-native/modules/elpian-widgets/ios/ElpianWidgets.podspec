# CocoaPods spec for the iOS native widget toolkit. Compiles the shared,
# platform-agnostic JSI/queue code (cpp/ElpianWidgetsJsi.cpp — the same file
# Android builds; its JNI is #if'd out on iOS) plus the iOS ObjC++/Swift glue
# (the UIKit WidgetController + VictorSurfaceView). Pure UIKit, no React below the
# host view — the iOS twin of the Android FlexboxLayout controller.

Pod::Spec.new do |s|
  s.name           = 'ElpianWidgets'
  s.version        = '0.1.0'
  s.summary        = 'VM-driven native UIView toolkit (JSI) for iOS'
  s.description    = 'Builds a real UIView tree from the VM rn.op stream; no React.'
  s.license        = 'MIT'
  s.author         = 'Victor'
  s.homepage       = 'https://github.com/cosmopole-org/victor'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'React-jsi'
  s.dependency 'React-Core'

  # The shared C++ (op queue + JSI install) lives under android/; the iOS glue
  # (Swift UIKit controller + ObjC++ bridge) lives here.
  s.source_files = '*.{h,m,mm,swift}',
                   '../android/src/main/cpp/ElpianWidgetsJsi.cpp'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'DEFINES_MODULE' => 'YES',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fexceptions -frtti',
  }
end
