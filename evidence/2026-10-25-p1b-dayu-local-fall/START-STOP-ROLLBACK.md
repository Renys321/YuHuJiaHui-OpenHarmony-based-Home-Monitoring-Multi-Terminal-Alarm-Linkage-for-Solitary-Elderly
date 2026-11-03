# 启动、停止、回滚（P1-B）

## 1. 候选身份

- 程序：`dayu_local_fall`（ELF32 ARM PIE，约 3.10 MB）
- 设备目录：`/data/local/tmp/p1b-fall-2026-10-25/`
- 模型：
  - `models/320/model.ncnn.param|.bin`（本轮最终选择，性能达标）
  - `models/416`、`models/640`（对比候选，不满足性能闸门）
- 端口：仅 `127.0.0.1:9200`（拒绝非 loopback bind）
- 旋转：`--rotate 0`（真实 JPEG 方向正常；90/270 实测会丢检，不得使用）
- 事件：本地 JSONL；APP HTTP 响应固定 `fall=false/fallEvaluated=false`

## 2. 启动（相机服务）

```sh
cd /data/local/tmp/p1b-fall-2026-10-25
rm -f evidence/events.jsonl evidence/stats.jsonl evidence/server.log
nohup ./dayu_local_fall --serve 127.0.0.1:9200 --duration 1500 --threads 4 --size 320 --rotate 0 \
  --param models/320/model.ncnn.param --bin models/320/model.ncnn.bin \
  --events evidence/events.jsonl --stats evidence/stats.jsonl > evidence/server.log 2>&1 &
```

然后由用户在 DAYU 上打开正式 APP 相机页并保持前台；检查：

```sh
ps -ef | grep dayu_local_fall
netstat -lntp | grep 9200
wc -l evidence/events.jsonl
```

## 3. 单图/回放

```sh
./dayu_local_fall --image testdata/person_camera_preview.jpeg --size 320 --rotate 0 \
  --param models/320/model.ncnn.param --bin models/320/model.ncnn.bin \
  --events evidence/img_events.jsonl --stats evidence/img_stats.jsonl

./dayu_local_fall --dir testdata --repeat 10 --size 320 --rotate 0 \
  --param models/320/model.ncnn.param --bin models/320/model.ncnn.bin \
  --events evidence/dir_events.jsonl --stats evidence/dir_stats.jsonl
```

## 4. 离线自测

```sh
./dayu_local_fall --selftest
# 13/13 PASS，exit 0
```

## 5. 停止

```sh
kill -TERM $(pidof dayu_local_fall)
sleep 2
ps -ef | grep dayu_local_fall   # 应无输出
cat evidence/stats.jsonl        # summary 已写出
```

停止后退出测试打开的 DAYU APP（或 `aa force-stop com.dsh.eldercare`）；不要卸载/清数据。
若仍需要相机帧，先退 APP 再重新启动服务。

## 6. 回滚

```sh
# DAYU：只删除本任务独立候选目录
rm -rf /data/local/tmp/p1b-fall-2026-10-25

# PC：保留 evidence/2026-10-25-p1b-dayu-local-fall 证据；如需清理构建物：
# rm -rf <P1-B>/build
```

回滚不影响 Broker/Bridge/public-sync/supervisor/worker/homemon/手机 APP；不涉及 HAP、系统分区、驱动、fport。

## 7. 当前状态（本任务结束时更新）

见 `P1B-REPORT.md` §现场状态；结束时必须确认：候选已停止、9200 无监听、测试 APP 已退出、P0 正常。
