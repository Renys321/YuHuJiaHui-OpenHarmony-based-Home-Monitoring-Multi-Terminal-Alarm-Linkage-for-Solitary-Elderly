cmake_minimum_required(VERSION 3.10)
project(dayu_local_fall CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Reuse the P1-A ncnn arm32 static build (do not modify it).
set(NCNN_ROOT "D:/OpenHarmony/competition/vision/dayu-local")
set(NCNN_SRC "${NCNN_ROOT}/third_party/ncnn/src" CACHE PATH "ncnn source dir")
set(NCNN_BUILD "${NCNN_ROOT}/build-arm-neon2" CACHE PATH "ncnn arm32 build dir")

add_executable(dayu_local_fall
  dayu_local_fall.cpp
  fall_core.cpp
  selftest.cpp
)
target_include_directories(dayu_local_fall PRIVATE "${NCNN_SRC}" "${NCNN_BUILD}/src" "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(dayu_local_fall PRIVATE -O3 -fPIE)
target_link_options(dayu_local_fall PRIVATE -pie)
find_package(Threads REQUIRED)
target_link_libraries(dayu_local_fall PRIVATE "${NCNN_BUILD}/src/libncnn.a" Threads::Threads m)
