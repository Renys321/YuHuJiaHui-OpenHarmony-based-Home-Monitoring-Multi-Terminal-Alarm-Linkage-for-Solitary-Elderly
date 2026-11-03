# YOLO Pose 跌倒检测离线基线证据

执行时间：2026-10-10 17:17-17:31（Asia/Shanghai）

本目录记录当前源码的本机验证结论。执行时 `hdc list targets` 为空，系统只枚举到蓝牙
`COM19/COM20`，`1883/9000/9001/9100/9101` 均未监听。因此本文不包含 DAYU 摄像头、
真人跌倒、ESP32 或 APP 真机结论。

## 结果

| 项目 | 结果 | 直接输出摘要 |
|---|---|---|
| Python 语法 | PASS | 4 个 Python 文件 `py_compile` 成功 |
| 时序判定与 YOLO 适配器 | PASS | `unittest discover` 共 11 项通过 |
| Python 依赖一致性 | PASS | `pip check`: `No broken requirements found` |
| YOLO Pose 权重 | PASS | `yolo11n-pose.pt`, 6,255,593 bytes |
| CPU 模型推理 | PASS | 空场景输出 0 人；人像样例输出 1 人、`1x17x3` 关键点并成功生成 `PoseFrame` |
| YOLO 服务安全默认值 | PASS | 未传 `--publish`，未启动 Broker，也未发送 FALL |
| MQTT FALL 定向路由 | PASS | Bridge 集成测试 11 项通过，目标节点精确收到一次 `fall\n` |
| homemon ARM32 | PASS | ELF32 / ARM / `/lib/ld-musl-arm.so.1` |
| homemon ARM64 参考构建 | PASS | ELF64 / AArch64 / `/lib/ld-musl-aarch64.so.1` |
| ArkTS unsigned HAP | PASS | hvigor `BUILD SUCCESSFUL`，33 tasks |
| signed HAP 离线验签 | PASS | `verify codesign success`, digest true, `verify-app success` |
| 当前 HAP 真机安装 | NOT TESTED | DAYU/HDC 离线 |
| DAYU 摄像头取帧 | NOT TESTED | DAYU/HDC 离线 |
| 真人跌倒识别与误报率 | NOT TESTED | 无现场视频数据集 |
| RK3568 RKNN/NPU | NOT TESTED | 未确认 toolkit、转换产物和 32 位 runtime |

## 自动测试覆盖

时序判定覆盖：稳定站立、快速下落并保持水平、坐下、弯腰、初始躺卧、床区排除、
关键点丢失、恢复后第二次跌倒，以及不同 track ID 不得拼成一次跌倒。YOLO 适配器覆盖
多人候选主目标选择、track ID、坐标归一化、source 和排除区参数解析。

Bridge 测试使用随机本地端口启动真实 `mqtt_broker.js` 与 `mqtt_bridge.js`，通过
`mqtt_tool.js` 发布：

```json
{"cmd":"fall","score":0.8,"source":"test"}
```

订阅映射只向 `esp32-bath` 当前活动连接写入一次 `fall\n`；测试结束后精确关闭自身子进程。

## 当前指纹

```text
fall_detector.py          EAE6F7C8A99FBA870FB8ABB74FC2A2D14660A732AB676BA1E2F65D4258DD113D
test_fall_detector.py     07107732B654A3E5C2B82F337FDD8FB25B6AE2C5208CBCD2F76A674FCAE4B404
yolo_pose_service.py      B96B3A077152A050E07B0B100CBE9DF7458219E5774FB2C0DBBA353248D6CF43
test_yolo_pose_service.py 3546EFA984A2FE5270FDCF0652D330A1949645293A8766C5239965BF30D64C1D
yolo11n-pose.pt           869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0
mqtt_bridge.js            6A874233D79439985510513F56832C87A07EE5A9FF7A9794EBE0D062CF6ABF1B
homemon.c                  8EDE0A64693D46F3B71B19786F4130E27ED9381F2A664E379282BEA9C39F45AE
DeviceModel.ets            50C7BCC17FE8A0E84BC8F17874492F68291EEED7744918AF9D2109610773E30D
homemon-arm                0D243539403DE89C547DEFACF43C86A4980142EF8EC686B277BE7133C42881E6
eldercare-signed.hap       A0606DF65FC0E405B87651C77909663EC29FD4470BAB7DA138D9916ADFADF0A5
```

模型事件中的 `score` 是规则证据分，不是经过标定的医学概率。现场验收前不得宣称跌倒
准确率、医疗诊断能力或 NPU 加速已实现。

人像样例单张耗时为 preprocess 2.14 ms、inference 51.82 ms、postprocess 1.35 ms。该数值只
证明本机单张 CPU 推理可执行，不能外推 DAYU 摄像头连续帧率、端到端延迟或板端性能。
