# CocoaPods spec for the iOS Elpian VM JSI module. Compiles the shared,
# platform-agnostic JSI installer (cpp/ElpianRnJsi.cpp — the same file Android
# builds; its JNI is #if'd out on iOS) plus the iOS ObjC++/Swift glue, and links
# the Rust VM static library built for iOS (libelpian_rn.a, a build artifact —
# see ios/README.md; the iOS twin of the Android jniLibs/*.so).

Pod::Spec.new do |s|
  s.name           = 'ElpianRn'
  s.version        = '0.1.0'
  s.summary        = 'Native Elpian VM (JSI) for iOS'
  s.description    = 'Installs global.__ElpianRN over the Rust libelpian_rn C ABI.'
  s.license        = 'MIT'
  s.author         = 'Victor'
  s.homepage       = 'https://github.com/cosmopole-org/victor'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'React-jsi'
  s.dependency 'React-Core'

  # The shared C++ installer lives under android/ (built by both platforms); the
  # iOS glue lives here. Header search path reaches the shared C ABI header.
  s.source_files = 'ElpianRn*.{h,m,mm,swift}',
                   '../android/src/main/cpp/ElpianRnJsi.cpp',
                   '../android/src/main/cpp/elpian_rn_capi.h'

  # The Rust VM, cross-compiled for iOS (arm64 device + sim) into this xcframework.
  s.vendored_frameworks = 'libelpian_rn.xcframework'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/../android/src/main/cpp"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited)',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fexceptions -frtti',
  }
end
