# 阶段 A：单图真实推理结果

## 运行位置

- 设备：DAYU200（target `450100445634303332012847942eca00`），root shell。
- 工作目录：`/data/local/tmp/p1a-yolo-2026-10-25/`。
- 模型：`model/model.ncnn.param` + `model/model.ncnn.bin`（哈希见 `MODEL-AND-BUILD.md`）。
- 程序：`dayu_local_yolo`（ELF32 ARM PIE，SHA `F80FFD7C…BDD25`）。
- 推理库：板端静态链接 ncnn（arm32，NEON 启用）；无 PC 参与。

## 命令

```sh
cd /data/local/tmp/p1a-yolo-2026-10-25
./dayu_local_yolo --image testdata/person_camera_preview.jpeg \
  --param model/model.ncnn.param --bin model/model.ncnn.bin \
  --events evidence/events_stageA_neon.jsonl --stats evidence/stats_stageA_neon.jsonl --threads 4
# 无人图同理：no_person_camera_check.jpeg / no_person_living_room.jpeg
```

## 结果

| 图 | 内容 | personCount | dataValid | inferMs | 板端 conf/bbox |
|---|---|---|---:|---|---|
| `person_camera_preview.jpeg` | DAYU 相机预览（真实两人） | **1** | true | 1706 | 0.47492；[47.37, 763.06, 612.01, 336.47] |
| `no_person_camera_check.jpeg` | 空场景 | **0** | true | 1698 | — |
| `no_person_living_room.jpeg` | 空客厅 | **0** | true | 1685 | — |

三条 summary 完整保存在 `raw/stats_stageA_neon.jsonl`；三条 event 在 `raw/events_stageA_neon.jsonl`。`errors=0`。

## 与 PC 参考的对照（仅准备阶段）

| 项目 | PC ncnn 参考（x86） | DAYU 板端 |
|---|---|---|
| personCount（有人图） | 1 | 1 |
| conf（有人图最高） | 0.47896 | 0.47492 |
| 预处理 | letterbox 640、pad 114、/255 | 相同 |
| NMS | 0.45 | 0.45 |

差异在 float/实现精度范围内；PC 参考不作为验收依据。

## 真实缺陷记录

第一版 ncnn 仅用 `-march=armv7a` 编译，NEON 未启用（OHOS 三元组下 `-mfpu=neon` 不定义 `__ARM_NEON`），单帧 **154,879 ms**；事件为
`personCount=1, inferMs=154879`，summary `p50=154879`。改用 `-mcpu=cortex-a7 -mfloat-abi=softfp` 重新编译后为 **1706 ms**。旧数据用于说明性能修复的真实性，最终验收采用 NEON 版本。

## 判定

阶段 A：**PASS（真机、CPU_ONLY、单图）**。
