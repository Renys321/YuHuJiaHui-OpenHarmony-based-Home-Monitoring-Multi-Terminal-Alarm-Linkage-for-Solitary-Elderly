# 许可证说明

## 1. 模型

- 原始模型：`competition/vision/yolo11n-pose.pt`，Ultralytics YOLO11n-pose（COCO-pose）。
- 元数据许可证：**AGPL-3.0 License**（`metadata.yaml` 中 `license: AGPL-3.0 License (https://ultralytics.com/license)`）。
- 本轮转换产物（ncnn `.param/.bin`、320/416/640 模型）属于该模型的衍生格式；分发/商用前必须按 AGPL-3.0 评估源代码提供义务、网络服务条款及 Ultralytics 许可条款。
- 本轮只做技术验证，**不自行宣称已解决正式分发许可证问题**；没有把模型上传公网或再分发。

## 2. 推理库

- ncnn：BSD-3-Clause（源码 commit `cb65ca26ba955bf456f3a26e13e9a644769fc4a4`，来自 gitee 镜像；仅用于编译静态库）。
- ncnn 自带的 `stb_image.h`：public domain / MIT（以文件头声明为准）。
- 板端程序 `dayu_local_fall.cpp`、`fall_core.cpp`、`selftest.cpp`、`CMakeLists.txt`：本轮新写的候选代码，仅用于本任务验证；未声明对外许可证。

## 3. 数据

- 测试图 `person_camera_preview.jpeg`、`no_person_camera_check.jpeg`、`no_person_living_room.jpeg` 来自项目既有证据（P1-A 已使用），本轮未新增真人照片到证据目录。
- 真实相机帧只在 DAYU 候选目录临时用于基准，**不放入交付证据**；证据只保留不含图像的事件/统计。
- 没有保存完整相机视频，没有保存人员身份信息。

## 4. 结论

本轮不改变任何既有许可证；正式集成/分发前需单独完成 AGPL-3.0 合规评估与模型再分发决策。
