# 启动、停止、回滚

## 1. 候选身份

- 名称：`dayu_local_yolo`（原生进程，ELF32 ARM）
- 设备路径：`/data/local/tmp/p1a-yolo-2026-10-25/dayu_local_yolo`
- 模型：同目录 `model/model.ncnn.param`、`model/model.ncnn.bin`
- 程序 SHA-256：`F80FFD7CC0015D96C63EE88DC037FEC5F0B08B76F6526F521E869EF0ED8BDD25`（2,984,528 B）
- 当前状态：**已停止**（00:54:39 CST 收到 SIGTERM，写出 `stats_cam.jsonl` 后退出；当前无 `dayu_local_yolo` 进程）。
- 设备目录保留：程序、模型、测试图、全部 evidence（含 4 MB 压力事件）。

## 2. 依赖/前置

- DAYU 已连接：`hdc list targets` 应包含 `450100445634303332012847942eca00`；所有命令显式 `-t`。
- 设备无需安装任何软件包；依赖系统 `/lib/libc++_shared.so`、`/lib/libc.so`。
- 相机帧来源：DAYU 正式 APP（`com.dsh.eldercare`）相机页在前台时自动向 `127.0.0.1:9200` POST；候选服务先启动再打开 APP。
- 不修改正式 APP、homemon、P0 进程。

## 3. 单图推理（阶段 A 复现）

```sh
cd /data/local/tmp/p1a-yolo-2026-10-25
./dayu_local_yolo --image testdata/person_camera_preview.jpeg \
  --param model/model.ncnn.param --bin model/model.ncnn.bin \
  --events evidence/events_image.jsonl --stats evidence/stats_image.jsonl --threads 4
```

## 4. 相机收帧服务（阶段 B/C 复现）

先启动候选服务（root；建议 nohup 后台，`--duration` 到期自动退出）：

```sh
cd /data/local/tmp/p1a-yolo-2026-10-25
rm -f evidence/events_cam.jsonl evidence/stats_cam.jsonl evidence/server.log
nohup ./dayu_local_yolo \
  --param model/model.ncnn.param --bin model/model.ncnn.bin \
  --serve 127.0.0.1:9200 --duration 1800 --threads 4 \
  --events evidence/events_cam.jsonl --stats evidence/stats_cam.jsonl \
  > evidence/server.log 2>&1 &
```

然后由用户在 DAYU 上打开正式 APP 相机页并保持前台；确认：

```sh
netstat -lntp | grep 9200          # 应看到 dayu_local_yolo LISTEN
wc -l evidence/events_cam.jsonl    # 应增长
ps -ef | grep dayu_local_yolo
```

停止（推荐 SIGTERM，使程序写出 summary）：

```sh
kill -TERM $(pidof dayu_local_yolo)     # 若 pidof 不可用，用 ps 找到 PID 后 kill -TERM
sleep 2
ps -ef | grep dayu_local_yolo           # 应无输出
cat evidence/stats_cam.jsonl            # summary 已写出
```

停止后在 DAYU 上退出正式 APP（或 `aa force-stop com.dsh.eldercare`），恢复 APP 未运行状态。

## 5. 回滚

```sh
# DAYU：删除本任务独立候选目录（只影响本任务）
rm -rf /data/local/tmp/p1a-yolo-2026-10-25

# PC：保留证据/源码即可；如需完全清理构建物，删除：
# <WORKSPACE>\competition\vision\dayu-local\build-arm*, build-app*
```

回滚不需要重启 Broker/Bridge/public-sync/supervisor/worker/homemon；不涉及 HAP、APP、系统分区、fport、驱动。
若只停止而不删除目录，可直接用 §4 重启。

## 6. 注意

- 不要用 `kill -9`（会跳过 summary 写出；证据仍保留）。
- 不要改 `--serve` 到非 loopback 地址（可能暴露端口；本任务只用 `127.0.0.1:9200`）。
- 不要同时运行两个候选服务抢 9200；先确认 `netstat`。
- 服务启动前必须存在 `model/`、`events/` 目录；`--events`/`--stats` 路径需可写。
- 正式 APP 未修改；`aa force-stop` 只停止本次测试打开的实例，不卸载、不清数据。
