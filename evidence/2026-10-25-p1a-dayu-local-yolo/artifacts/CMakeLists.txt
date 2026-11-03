cmake_minimum_required(VERSION 3.10)
project(dayu_local_yolo CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED NCNN_SRC)
  set(NCNN_SRC "${CMAKE_CURRENT_SOURCE_DIR}/third_party/ncnn/src")
endif()
if(NOT DEFINED NCNN_BUILD)
  set(NCNN_BUILD "${CMAKE_CURRENT_SOURCE_DIR}/build-arm")
endif()

add_executable(dayu_local_yolo src/dayu_local_yolo.cpp)
target_include_directories(dayu_local_yolo PRIVATE "${NCNN_SRC}" "${NCNN_BUILD}/src")
target_compile_options(dayu_local_yolo PRIVATE -O3 -fPIE)
target_link_options(dayu_local_yolo PRIVATE -pie)
find_package(Threads REQUIRED)
target_link_libraries(dayu_local_yolo PRIVATE "${NCNN_BUILD}/src/libncnn.a" Threads::Threads m)
