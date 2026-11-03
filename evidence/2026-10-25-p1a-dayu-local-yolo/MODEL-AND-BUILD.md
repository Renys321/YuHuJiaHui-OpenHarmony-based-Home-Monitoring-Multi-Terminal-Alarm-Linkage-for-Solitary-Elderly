# 模型、转换与可复现构建

## 1. 模型来源与许可证

- 文件：`<WORKSPACE>\competition\vision\yolo11n-pose.pt`
- 大小/SHA-256：6,255,593 B / `869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0`
- 任务/数据集：Ultralytics YOLO11n-pose；COCO-pose（`metadata.yaml`：`task: pose`、`names: {0: person}`、`kpt_shape: [17,3]`、`imgsz: [640,640]`）
- 许可证：模型元数据为 `AGPL-3.0 License (https://ultralytics.com/license)`；ncnn 为 BSD-3-Clause；使用/分发前需按 AGPL 评估。

## 2. 输入/输出契约

- 输入：`1×3×640×640`，RGB；letterbox 到 640×640（保持比例，pad=114），`/255` 归一化。
- 输出：单 blob `out0`，ncnn 形状 `w=8400`（anchors）× `h=56`（features）：
  - 0–3：`cx,cy,w,h`（640 padded 像素）
  - 4：person 类别 sigmoid 分数
  - 5–55：17 个关键点 `(x,y,conf)`，x/y 为 padded 像素，conf 已 sigmoid
- 后处理：conf 阈值 0.25；按分数排序；IoU NMS 0.45；把 box/kpt 从 padded 坐标映射回原图并裁剪。
- 该模型是 **pose/person** 模型，不是跌倒/PIR/SOS 模型；事件中明确标注 `confSemantics`。

## 3. 转换（PC 侧，只用于生成 ncnn 模型）

工具版本：

```text
ultralytics 8.4.175
torch 2.14.1+cpu
pnnx 20260526
ncnn (Python) 1.0.20261020
```

命令（与 `artifacts/export_ncnn.py` 等价）：

```python
from ultralytics import YOLO
m = YOLO(r"<WORKSPACE>\competition\vision\yolo11n-pose.pt")
m.export(format="ncnn", imgsz=640, half=False, batch=1, device="cpu")
# 输出目录：<WORKSPACE>\competition\vision\yolo11n-pose_ncnn_model
```

产物：

| 文件 | 大小(B) | SHA-256 |
|---|---:|---|
| `model.ncnn.param` | 25,357 | `6214EAE58D3ED8669E36E5FF14B0D20764CD8A97EB008D44DD1B13760F22F7E3` |
| `model.ncnn.bin` | 11,634,260 | `531602E61A5E77651873109D13BC06199C274B5ECE42AA608A95CBCA28E21FEA` |
| `metadata.yaml` | 465 | `ACD1953D80B29D7556BF8035A50EA7158FBD00E443C32EDDE57415647061BF1B` |

## 4. ncnn 交叉编译（OHOS SDK，arm32）

源码：`third_party/ncnn`，gitee `https://gitee.com/Tencent/ncnn`，commit `cb65ca26ba955bf456f3a26e13e9a644769fc4a4`（GitHub 不可达，PyPI/gitee 可用）。

```powershell
$sdk='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony'
$ncnn='<WORKSPACE>\competition\vision\dayu-local\third_party\ncnn'
$build='<WORKSPACE>\competition\vision\dayu-local\build-arm-neon2'
& "$sdk\native\build-tools\cmake\bin\cmake.exe" -S $ncnn -B $build -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$sdk\native\build\cmake\ohos.toolchain.cmake" `
  -DOHOS_ARCH=armeabi-v7a -DOHOS_STL=c++_shared -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_C_FLAGS="-mcpu=cortex-a7 -mfloat-abi=softfp" `
  -DCMAKE_CXX_FLAGS="-mcpu=cortex-a7 -mfloat-abi=softfp" `
  -DNCNN_VULKAN=OFF -DNCNN_OPENMP=OFF -DNCNN_BUILD_TOOLS=OFF -DNCNN_BUILD_EXAMPLES=OFF `
  -DNCNN_BUILD_BENCHMARK=OFF -DNCNN_PYTHON=OFF -DNCNN_SHARED_LIB=OFF -DNCNN_BUILD_TESTS=OFF
& "$sdk\native\build-tools\cmake\bin\cmake.exe" --build $build -j 8
```

**关键坑**：对 OHOS 三元组，`-march=armv7a -mfpu=neon` **不会**启用 NEON（`__ARM_NEON` 未定义）；必须 `-mcpu=cortex-a7 -mfloat-abi=softfp`。未启用时单帧 154,879 ms；启用后约 1.7 s。

## 5. 板端程序交叉编译

```powershell
$sdk='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony'
$dl='<WORKSPACE>\competition\vision\dayu-local'
$ab="$dl\build-app-neon4"
& "$sdk\native\build-tools\cmake\bin\cmake.exe" -S $dl -B $ab -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$sdk\native\build\cmake\ohos.toolchain.cmake" `
  -DOHOS_ARCH=armeabi-v7a -DOHOS_STL=c++_shared -DCMAKE_BUILD_TYPE=Release `
  -DNCNN_SRC="$dl\third_party\ncnn\src" -DNCNN_BUILD="$dl\build-arm-neon2" `
  -DCMAKE_C_FLAGS="-mcpu=cortex-a7 -mfloat-abi=softfp" `
  -DCMAKE_CXX_FLAGS="-mcpu=cortex-a7 -mfloat-abi=softfp"
& "$sdk\native\build-tools\cmake\bin\cmake.exe" --build $ab -j 8
```

产物：ELF32 ARM PIE，`NEEDED libc++_shared.so, libc.so`（设备 `/lib` 均有）。

## 6. 板端部署

```powershell
$hdc='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$t='450100445634303332012847942eca00'
$r='/data/local/tmp/p1a-yolo-2026-10-25'
& $hdc -t $t shell "mkdir -p $r/model $r/testdata $r/evidence"
& $hdc -t $t file send "$dl\build-app-neon4\dayu_local_yolo" "$r/dayu_local_yolo"
& $hdc -t $t file send "$dl\model\model.ncnn.param" "$r/model/model.ncnn.param"
& $hdc -t $t file send "$dl\model\model.ncnn.bin" "$r/model/model.ncnn.bin"
& $hdc -t $t shell "chmod 755 $r/dayu_local_yolo"
```

## 7. 产物哈希

| 产物 | 大小(B) | SHA-256 |
|---|---:|---|
| 板端程序（最终，含日志修复） | 2,984,528 | `F80FFD7CC0015D96C63EE88DC037FEC5F0B08B76F6526F521E869EF0ED8BDD25` |
| 板端程序（日志修复前，已弃用） | 2,984,512 | `A3D0FFDD28EF0C3DC754D0583E67DAC4A0DB6DECA43CCD14D16DDCFEEE91D74A` |
| `model.ncnn.param` | 25,357 | `6214EAE58D3ED8669E36E5FF14B0D20764CD8A97EB008D44DD1B13760F22F7E3` |
| `model.ncnn.bin` | 11,634,260 | `531602E61A5E77651873109D13BC06199C274B5ECE42AA608A95CBCA28E21FEA` |
| `metadata.yaml` | 465 | `ACD1953D80B29D7556BF8035A50EA7158FBD00E443C32EDDE57415647061BF1B` |
| `dayu_local_yolo.cpp` | 26,867 | `E891D32BC98520657332448639339A9ECE810331EA624AD335BE5106C513E785` |
| `CMakeLists.txt` | 702 | `C3E2C3CBB2299B4C0BEBAD27A029D4E6C9FCF65A37E8D6C0DAB7908DB98C05DD` |
| `stb_image.h`（ncnn 自带） | 310,910 | `2456D521678FC1A337F37C538C6E2BE52CB027352E99ABCF13F4B3EBBE7FF112` |

## 8. 运行环境

- 设备：OpenHarmony 7.0.0.38 / API26 / kernel 6.6.101 aarch64 / 32-bit ARM musl；4×A55 1.992GHz；2GB RAM。
- 运行时依赖：`/lib/libc++_shared.so`、`/lib/libc.so`（系统自带）；无额外库、无 root 安装。
- 模型/程序均在 `/data/local/tmp/p1a-yolo-2026-10-25/`，未写入系统分区。
