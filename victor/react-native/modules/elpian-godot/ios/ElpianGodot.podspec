# CocoaPods spec for the iOS embedded-Godot module. Compiles the shared,
# platform-agnostic JSI/queue code (cpp/ElpianGodotJsi.cpp — the same file
# Android builds; its JNI is #if'd out on iOS) plus the iOS ObjC++/Swift glue.
# The Godot iOS runtime itself (libgodot.ios + the elpian_godot GDExtension for
# iOS) is a binary build artifact linked separately — see ios/README.md; until
# then ElpianGodotView shows the placeholder, exactly like a partial install.

Pod::Spec.new do |s|
  s.name           = 'ElpianGodot'
  s.version        = '0.1.0'
  s.summary        = 'Embedded Godot Scene3D (JSI) for iOS'
  s.description    = 'Installs global.__ElpianGodot; hosts the Godot viewport view.'
  s.license        = 'MIT'
  s.author         = 'Victor'
  s.homepage       = 'https://github.com/cosmopole-org/victor'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'React-jsi'
  s.dependency 'React-Core'

  s.source_files = '*.{h,m,mm,swift}',
                   '../android/src/main/cpp/ElpianGodotJsi.cpp'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'DEFINES_MODULE' => 'YES',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fexceptions -frtti',
  }
end
