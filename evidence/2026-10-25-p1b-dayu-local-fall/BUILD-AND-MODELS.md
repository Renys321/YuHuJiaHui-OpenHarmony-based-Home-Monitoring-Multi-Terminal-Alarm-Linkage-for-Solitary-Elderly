# 构建、模型与依赖（P1-B）

## 1. 模型来源

- 原始模型：`<WORKSPACE>\competition\vision\yolo11n-pose.pt`（6,255,593 B，SHA `869E83FC…19DC0`），Ultralytics YOLO11n-pose / COCO-pose / **AGPL-3.0**。
- 640：直接复用 P1-A 的 ncnn 导出（`models/640`，param/bin 哈希与 P1-A 一致）。
- 416/320：PC 上同源重新导出（仅 imgsz 不同）：

```python
from ultralytics import YOLO
m = YOLO(r"<WORKSPACE>\competition\vision\yolo11n-pose.pt")
m.export(format="ncnn", imgsz=320, half=False, batch=1, device="cpu")  # 416 同理
```

工具版本：ultralytics 8.4.175、torch 2.14.1+cpu、pnnx 20260526、ncnn Python 1.0.20261020。

## 2. ncnn（复用 P1-A arm32 构建）

- 源码 commit `cb65ca26ba955bf456f3a26e13e9a644769fc4a4`（gitee 镜像）。
- 复用 `competition/vision/dayu-local/build-arm-neon2/src/libncnn.a`（NEON：`-mcpu=cortex-a7 -mfloat-abi=softfp`）。
- 本轮另建 `build/ncnn-o3` 仅作对比，**未部署**，不作为证据。

## 3. 板端程序

```powershell
$sdk='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony'
$src='<WORKSPACE>\competition\evidence\2026-10-25-p1b-dayu-local-fall\source'
$build='<WORKSPACE>\competition\evidence\2026-10-25-p1b-dayu-local-fall\build\app'
& "$sdk\native\build-tools\cmake\bin\cmake.exe" -S $src -B $build -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$sdk\native\build\cmake\ohos.toolchain.cmake" `
  -DOHOS_ARCH=armeabi-v7a -DOHOS_STL=c++_shared -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_C_FLAGS="-mcpu=cortex-a7 -mfloat-abi=softfp" `
  -DCMAKE_CXX_FLAGS="-mcpu=cortex-a7 -mfloat-abi=softfp"
& "$sdk\native\build-tools\cmake\bin\cmake.exe" --build $build -j 8
```

产物：ELF32 ARM PIE，依赖 `libc++_shared.so`、`libc.so`（设备 `/lib` 自带）。

## 4. 部署

```powershell
$hdc='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$t='450100445634303332012847942eca00'; $r='/data/local/tmp/p1b-fall-2026-10-25'
& $hdc -t $t shell "mkdir -p $r/models/320 $r/models/416 $r/models/640 $r/testdata $r/evidence"
& $hdc -t $t file send "build\app\dayu_local_fall" "$r/dayu_local_fall"
# 每个尺寸的 model.ncnn.param/bin 分别放入 models/<size>/
& $hdc -t $t shell "chmod 755 $r/dayu_local_fall"
```

## 5. 产物哈希

| 对象 | 大小(B) | SHA-256 |
|---|---:|---|
| 板端 `dayu_local_fall` | 3,102,112 | `EF58405E2C930C476B80E520FE2BC61E86929D301CC65879023A1FBA556BBF0A` |
| 320 param | 25,354 | `105F6E42BB4B5151FFB17C6D78BCFF97B7419D98386DCC60143985F1E496C413` |
| 320 bin | 11,508,260 | `5DF9BAA9EE42DB00E408B59F5A707072B294DB1B0F38765B928FAB0E9DA537E1` |
| 416 param | 25,354 | `6A590ABE0E2507AFFE58FFF39B09844307A0B058C2382E299CD083E1FDEDEEF7` |
| 416 bin | 11,537,240 | `DAEDF7CB3732659E842F6A823B28502DAC815BB2AD209144A18C979CE48FD0A9` |
| 640 param | 25,357 | `6214EAE58D3ED8669E36E5FF14B0D20764CD8A97EB008D44DD1B13760F22F7E3` |
| 640 bin | 11,634,260 | `531602E61A5E77651873109D13BC06199C274B5ECE42AA608A95CBCA28E21FEA` |

## 6. 运行依赖/边界

- DAYU：OpenHarmony 7.0.0.38 / API26 / arm32 musl / 4×A55。
- 仅 loopback 9200；不绑 0.0.0.0。
- 不安装系统库/驱动；ncnn 静态链接；无 NPU/RKNN。
- 模型许可证见 `LICENSE-NOTICE.md`。
