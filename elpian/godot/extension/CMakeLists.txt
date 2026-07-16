# CMake build for the Elpian↔Godot GDExtension.
#
#   cmake -B build -DGODOT_CPP_PATH=/path/to/godot-cpp -DCMAKE_BUILD_TYPE=Release
#   cmake --build build -j
#
# Produces project/bin/libelpian_godot.<platform>.<arch>.<so|dylib|dll> — the
# path the bundled elpian_godot.gdextension expects. godot-cpp (godot-4.3+ )
# is consumed as a source checkout (submodule-style or via GODOT_CPP_PATH).
#
# The Rust half (elpian-godot-capi) is built automatically with cargo unless a
# prebuilt archive is supplied through -DELPIAN_CAPI_LIB=....

cmake_minimum_required(VERSION 3.19)
project(elpian-godot-extension LANGUAGES CXX)

set(GODOT_CPP_PATH "${CMAKE_CURRENT_SOURCE_DIR}/godot-cpp" CACHE PATH "Path to a godot-cpp checkout")
if(NOT EXISTS "${GODOT_CPP_PATH}/CMakeLists.txt")
    message(FATAL_ERROR "godot-cpp not found at '${GODOT_CPP_PATH}'. Clone https://github.com/godotengine/godot-cpp (branch godot-4.3-stable or newer) and pass -DGODOT_CPP_PATH=...")
endif()
add_subdirectory("${GODOT_CPP_PATH}" "${CMAKE_CURRENT_BINARY_DIR}/godot-cpp")

# ---- @GlobalScope constant table (generated from the engine's API dump) -----
find_package(Python3 COMPONENTS Interpreter REQUIRED)
set(GEN_DIR "${CMAKE_CURRENT_BINARY_DIR}/gen")
set(CONSTANTS_INC "${GEN_DIR}/gen/global_constants_map.inc")
add_custom_command(
    OUTPUT "${CONSTANTS_INC}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${GEN_DIR}/gen"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_global_constants.py"
            "${GODOT_CPP_PATH}/gdextension/extension_api.json" "${CONSTANTS_INC}"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_global_constants.py"
            "${GODOT_CPP_PATH}/gdextension/extension_api.json"
    COMMENT "Generating @GlobalScope constant table from extension_api.json")

# ---- the Rust C-ABI library (the embedded Elpian VM) -------------------------
set(ELPIAN_CAPI_LIB "" CACHE FILEPATH "Prebuilt libelpian_godot static library (skip cargo)")
if(ELPIAN_CAPI_LIB STREQUAL "")
    set(ELPIAN_WORKSPACE "${CMAKE_CURRENT_SOURCE_DIR}/../..")
    set(ELPIAN_CAPI_LIB
        "${ELPIAN_WORKSPACE}/target/release/${CMAKE_STATIC_LIBRARY_PREFIX}elpian_godot${CMAKE_STATIC_LIBRARY_SUFFIX}")
    add_custom_command(
        OUTPUT "${ELPIAN_CAPI_LIB}"
        COMMAND cargo build -p elpian-godot-capi --release
        WORKING_DIRECTORY "${ELPIAN_WORKSPACE}"
        COMMENT "cargo build -p elpian-godot-capi --release")
    add_custom_target(elpian_capi DEPENDS "${ELPIAN_CAPI_LIB}")
endif()

# ---- the extension library ---------------------------------------------------
add_library(elpian_godot_ext SHARED
    src/register_types.cpp
    src/elpian_vm_node.cpp
    src/godot_controller.cpp
    src/flutter_controller.cpp
    src/flutter_view.cpp
    "${CONSTANTS_INC}")
set_source_files_properties("${CONSTANTS_INC}" PROPERTIES GENERATED TRUE HEADER_FILE_ONLY TRUE)
target_include_directories(elpian_godot_ext PRIVATE src "${GEN_DIR}")
target_compile_features(elpian_godot_ext PRIVATE cxx_std_17)
target_link_libraries(elpian_godot_ext PRIVATE godot::cpp "${ELPIAN_CAPI_LIB}")
if(TARGET elpian_capi)
    add_dependencies(elpian_godot_ext elpian_capi)
endif()

# ---- optional: embed a real Flutter engine (the Flutter UI bridge) -----------
# Off by default: flutter_view.cpp then compiles as an inert placeholder and no
# libflutter is needed. Turn on with -DELPIAN_WITH_FLUTTER=ON and point
# -DFLUTTER_ENGINE_DIR=... at a directory holding the embedder header
# (flutter_embedder.h) and the engine library (libflutter_engine.so /
# .dylib / flutter_engine.dll). See godot/FLUTTER.md.
option(ELPIAN_WITH_FLUTTER "Embed a real Flutter engine for the FL UI bridge" OFF)
set(FLUTTER_ENGINE_DIR "" CACHE PATH "Directory with flutter_embedder.h and the engine library")
if(ELPIAN_WITH_FLUTTER)
    if(NOT EXISTS "${FLUTTER_ENGINE_DIR}/flutter_embedder.h")
        message(FATAL_ERROR "ELPIAN_WITH_FLUTTER=ON but flutter_embedder.h not found in FLUTTER_ENGINE_DIR='${FLUTTER_ENGINE_DIR}'. See godot/FLUTTER.md.")
    endif()
    target_compile_definitions(elpian_godot_ext PRIVATE ELPIAN_WITH_FLUTTER)
    target_include_directories(elpian_godot_ext PRIVATE "${FLUTTER_ENGINE_DIR}")
    find_library(FLUTTER_ENGINE_LIB NAMES flutter_engine flutter_engine.so libflutter_engine PATHS "${FLUTTER_ENGINE_DIR}")
    if(NOT FLUTTER_ENGINE_LIB)
        message(FATAL_ERROR "Could not find the Flutter engine library in '${FLUTTER_ENGINE_DIR}'.")
    endif()
    target_link_libraries(elpian_godot_ext PRIVATE "${FLUTTER_ENGINE_LIB}")
endif()

# System libraries the Rust staticlib expects.
if(UNIX AND NOT APPLE)
    target_link_libraries(elpian_godot_ext PRIVATE dl pthread m)
elseif(WIN32)
    target_link_libraries(elpian_godot_ext PRIVATE ws2_32 userenv bcrypt ntdll)
endif()

# Name/location the bundled .gdextension expects: project/bin/libelpian_godot.<os>.<arch>.<ext>
string(TOLOWER "${CMAKE_SYSTEM_NAME}" ELPIAN_OS)
if(ELPIAN_OS STREQUAL "darwin")
    set(ELPIAN_OS "macos")
endif()
string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" ELPIAN_ARCH)
if(ELPIAN_ARCH MATCHES "amd64|x64")
    set(ELPIAN_ARCH "x86_64")
elseif(ELPIAN_ARCH MATCHES "aarch64|arm64")
    set(ELPIAN_ARCH "arm64")
endif()
set_target_properties(elpian_godot_ext PROPERTIES
    OUTPUT_NAME "elpian_godot.${ELPIAN_OS}.${ELPIAN_ARCH}"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../project/bin"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../project/bin"
    POSITION_INDEPENDENT_CODE ON)
