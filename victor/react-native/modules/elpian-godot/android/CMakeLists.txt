cmake_minimum_required(VERSION 3.13)
project(elpiangodot)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The JSI glue: installs global.__ElpianGodot and owns the op queue the Godot
# OpSink drains via JNI. It links only RN's jsi (no Godot linkage — the queue is
# shared with the Godot side purely through the JNI pollOps entry point).
find_package(ReactAndroid REQUIRED CONFIG)
if(TARGET ReactAndroid::jsi)
  set(RN_JSI ReactAndroid::jsi)
else()
  set(RN_JSI ReactAndroid::reactnative)
endif()

add_library(elpiangodot_jsi SHARED src/main/cpp/ElpianGodotJsi.cpp)
find_library(LOG_LIB log)
target_link_libraries(elpiangodot_jsi ${RN_JSI} android ${LOG_LIB})
