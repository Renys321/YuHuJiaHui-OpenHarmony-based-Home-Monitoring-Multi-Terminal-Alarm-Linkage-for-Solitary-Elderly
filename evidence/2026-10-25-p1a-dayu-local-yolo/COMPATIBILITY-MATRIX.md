# 兼容性矩阵（DAYU200，实机只读探测）

日期：2026-10-25；target：`450100445634303332012847942eca00`（USB，root shell）。

| 项目 | 实测值/命令 | 结论 |
|---|---|---|
| OpenHarmony 版本 | `param get const.product.software.version` → `OpenHarmony 7.0.0.38` | 实机版本 |
| API | `param get const.ohos.apiversion` → `26` | API 26 |
| 产品名/特性 | `const.product.name` → `OpenHarmony 3.2`；`const.build.characteristics` → `default` | 记录在案，不用于推断 |
| 内核 | `uname -a` → `Linux localhost 6.6.101 #1 SMP Fri Aug 21 19:15:22 CST 2026 aarch64 Toybox` | aarch64 内核 |
| 用户态 | `/lib/ld-musl-arm.so.1`、`/lib/libc++_shared.so`；`ls /lib` | **32-bit ARM musl**，不是 aarch64 用户态 |
| CPU | `/proc/cpuinfo`：4 个 `CPU part 0xd05`（Cortex-A55），`CPU architecture: 8`；`scaling_cur_freq=1992000`，governor=performance | 4×A55@1.992GHz，性能模式 |
| 内存 | `/proc/meminfo`：MemTotal 2,001,872 kB；MemAvailable 1,212,064 kB；SwapTotal 1,048,572 kB | 2GB 级，可运行 122MB RSS 候选 |
| 存储 | `df -h / /data`：`/` 1.9G 58%，`/data` 20G 6%（约 19G 可用） | 足够 |
| NPU 设备 | `/dev` 无 `rknpu`/`npu`；`/sys/class/devfreq` 仅 `fde60000.gpu`、`fdf40000.rkvenc`、`fdf80200.rkvdec`、`fe040000.vop`；`dmesg` 无 rknpu | **NPU 不可用** |
| NPU/推理库 | `find /system /vendor /usr /lib *rknn*` 无结果；仅 `libnnrt_stub_1.0/2.0/2.1.z.so`；无 onnxruntime/tflite/mnn/ncnn | 无可用推理后端 |
| MindSpore Lite | SDK `native/sysroot/usr/lib/arm-linux-ohos/libmindspore_lite_ndk.so`（34,812 B）与头文件；设备无运行时；SDK 无 `converter_lite`/benchmark | 本轮不采用 |
| 相机设备 | `/dev/video0` → `rkisp_mainpath`，`/dev/video1` → `rkisp_selfpath`；owner `camera_host:camera_host`，mode 660；`video2..9` 为 subdev | 不能由 shell 安全抢占 |
| 相机服务 | `camera_host` PID 512、`camera_service` PID 608 常驻 | 服务正常 |
| 相机帧通道 | `VisionFrameStreamer.ets`：250 ms 间隔向 `http://127.0.0.1:9200/v1/frames/dayu200-living` POST JPEG，超时 2500 ms；响应 `ok/personDetected/fall/...` | 设备本机可接收 |
| 相机权限 | 正式 APP 已声明 `ohos.permission.CAMERA`/`INTERNET`；测试由用户打开 APP | 无需改 APP |
| 编译工具链 | SDK `native/build/cmake/ohos.toolchain.cmake`；clang 15.0.4；cmake 3.28.2；ninja | 可交叉编译 |
| 目标 ABI | `OHOS_ARCH=armeabi-v7a`；ELF32 ARM PIE；依赖 `libc++_shared.so`、`libc.so` | 与设备用户态匹配 |
| NEON | OHOS 三元组下 `-march=armv7a -mfpu=neon` 不定义 `__ARM_NEON`；`-mcpu=cortex-a7 -mfloat-abi=softfp` 才启用 | 必须用后者；否则 155 s/帧 |
| 源码获取 | GitHub 超时；gitee `https://gitee.com/Tencent/ncnn` 可 clone；PyPI 可下载 pnnx/ncnn 包 | 使用 gitee + PyPI |
| 端口/P0 | `hdc fport ls`：仅 `tcp:9001→tcp:9000`；PC 9200 无监听 | 候选只绑设备 `127.0.0.1:9200` |
| root | `hdc -t ... shell id` → `uid=0(root)` | 可读设备/运行候选，但不滥用 |

## 结论

- 唯一可验证的路线是 **CPU_ONLY + arm32 ncnn 原生程序**，相机帧经正式 APP 既有 loopback HTTP 取帧。
- NPU 未经任何实测，不能称 `NPU_VERIFIED`；本任务也没有安装/修改驱动。
- 未触碰 P0 端口、进程、HAP、homemon。
