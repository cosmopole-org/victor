cmake_minimum_required(VERSION 3.13)
project(elpianrn)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The prebuilt Rust VM (libelpian_rn.so) is cross-compiled by CI into
# src/main/jniLibs/<abi>/ before this build runs. Import it so the JSI glue can
# link against its C ABI; Gradle packages it into the APK from jniLibs.
add_library(elpian_rn SHARED IMPORTED)
set_target_properties(elpian_rn PROPERTIES
  IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI}/libelpian_rn.so")

# React Native's JSI, from the react-android prefab.
find_package(ReactAndroid REQUIRED CONFIG)

add_library(elpianrn_jsi SHARED src/main/cpp/ElpianRnJsi.cpp)
target_include_directories(elpianrn_jsi PRIVATE src/main/cpp)

# jsi target name differs across RN versions; prefer the dedicated ::jsi target,
# fall back to the umbrella reactnative target.
if(TARGET ReactAndroid::jsi)
  set(RN_JSI ReactAndroid::jsi)
else()
  set(RN_JSI ReactAndroid::reactnative)
endif()

find_library(LOG_LIB log)
target_link_libraries(elpianrn_jsi
  elpian_rn
  ${RN_JSI}
  android
  ${LOG_LIB})
