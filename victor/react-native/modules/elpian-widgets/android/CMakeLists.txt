cmake_minimum_required(VERSION 3.13)
project(elpianwidgets)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The JSI glue: installs global.__ElpianWidgets and owns the op/event queues the
# VictorSurfaceView controller drains via JNI. Links only RN's jsi.
find_package(ReactAndroid REQUIRED CONFIG)
if(TARGET ReactAndroid::jsi)
  set(RN_JSI ReactAndroid::jsi)
else()
  set(RN_JSI ReactAndroid::reactnative)
endif()

add_library(elpianwidgets_jsi SHARED src/main/cpp/ElpianWidgetsJsi.cpp)
find_library(LOG_LIB log)
target_link_libraries(elpianwidgets_jsi ${RN_JSI} android ${LOG_LIB})
