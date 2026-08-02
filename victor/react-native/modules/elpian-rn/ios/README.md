# iOS Elpian VM module

The iOS twin of the Android VM module. It installs `global.__ElpianRN` from the
**same** shared C++ (`../android/src/main/cpp/ElpianRnJsi.cpp` — its JNI is
`#if defined(__ANDROID__)`-guarded, and an `ElpianRnInstall(void*)` plain-C entry
serves iOS) and links the Rust VM built for iOS.

## Files

- `ElpianRnModule.swift` — the Expo module (Name "ElpianRn", `install()` status).
- `ElpianRnInstaller.{h,mm}` — ObjC++ that forwards the JSI runtime pointer to
  the shared `ElpianRnInstall`.
- `ElpianRn.podspec` — compiles the shared cpp + iOS glue, vendors the Rust lib.

## Building the Rust VM for iOS (a build artifact, like the Android .so)

`libelpian_rn` is the same crate the Android job cross-compiles; for iOS build an
xcframework covering the device + simulator slices:

```sh
cd victor/react-native/native/elpian-rn
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
# combine into libelpian_rn.xcframework the podspec vendors:
xcodebuild -create-xcframework \
  -library ../../target/aarch64-apple-ios/release/libelpian_rn.a \
  -library ../../target/aarch64-apple-ios-sim/release/libelpian_rn.a \
  -output ../modules/elpian-rn/ios/libelpian_rn.xcframework
```

The crate already builds a static lib for these targets (the `crate-type`
includes `staticlib`); no SONAME step is needed on Apple platforms.

## One line to verify

`ElpianRnModule.swift` reads the JSI runtime via `appContext?.runtime?.pointer`
(Expo SDK 52). If a future expo-modules-core moves that accessor, that single
line is the only thing to adjust — everything below it is shared with Android.
