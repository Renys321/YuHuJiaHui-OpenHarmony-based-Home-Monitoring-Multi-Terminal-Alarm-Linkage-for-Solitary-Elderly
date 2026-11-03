# 2026-11-01 本地 clip 修复 + 30 轮稳定性基线

## 1. 现象

DAYU 快捷提问命中健康问题时，网关日志显示 `本地片段播报：clip=9 推送到 1 个节点`，
但目标 S3 喇叭没有声音；同一时刻网络 PCM 回答正常。
用「5 轮网络 PCM + 5 轮本地 clip 交替」复现：**只有 5 声**，且用户确认只有网络 PCM 有声。

## 2. 根因

`firmware/common/components/elder_node/speaker_link.c` 解析 9102 下发的
`{"type":"clip","clip":9}` 时使用：

```c
int clip = parse_int_field(line, "\"clip\"", 0);
```

`strstr` 先命中的是 `"type":"clip"` 里的 `"clip"`，其后紧跟 `,` 而不是数字，
`parse_int_field` 返回 fallback `0` → `local_voice_play(0)` 等于取消播放 → 整段静音。
该路径没有节点回执，网关侧只能看到“已推送”，无法发现失败。

KEY1 健康语音走 9303 采音连接，`mic_link.c` 用 `strchr(cp, ':')` 取值，因此一直正常。

## 3. 修复

- 改为按带冒号的键 `"clip":` 取值：`atoi(clipKey + 7)`；
- 日志增加 `(key-parse)` 标记，便于串口/二进制核验；
- `firmware/tools/sync-shared.ps1` 同步 kitchen / bathroom；
- 两工程 `idf.py build` 成功后按 MAC 校验逐板刷写（只写 app 分区）。

固件哈希见 `firmware/SHA256SUMS.txt`：

```text
38d391bc…  kitchen/build/esp32_elder_node.bin   1168224 B
476e53ba…  bathroom/build/esp32_elder_node.bin  1157232 B
```

## 4. 验证

- 卫生间串口 `bath-keyboard-serial.log`：
  `RX local clip=9 (key-parse)` → `PLAY clip=9 bytes=93488` → 11.75 s 后
  `STOP clip=9 result=ESP_OK cancelled=0`。
- 厨房串口 `kitchen-serial.log`：同样的三段日志，确认两板固件一致。
- 刷机后回归：`stability-test -Cycles 2` = 14/14 PASS，`voice-chain-test -Cycles 2` = 2/2 PASS。
- 30 轮浸泡（`soak-summary.txt`）：`pass=210 fail=0`，问答 663–1321 ms（均值 924 ms），
  浸泡窗口内 0 断连 / 0 未回执 / 0 错误。

## 5. 稳定性工具加固（同轮）

- `materials/stability-test.ps1`、`materials/core-start.ps1` 的端口探测改为**纯 TCP 连接**，
  不再依赖 `Get-NetTCPConnection`（受限会话会“拒绝访问”导致假 FAIL）；
- 云端 health 检查优先用 `node fetch`，`.NET TLS` 不可用时不会误判云端故障；
- hdc 目标解析增加一次重试；映射缺失时提示 `restore-hdc-mappings.ps1`；
- `core-start.ps1 -RestartGateway` 改为按监听端口定位进程（旧正则匹配不到 `node server.js`，
  会静默产生 EADDRINUSE 的“假重启”）。

## 6. 文件清单

| 文件 | 说明 |
|---|---|
| `pcm-vs-clip-10rounds.log` | 交替 10 轮原始输出（PCM 5 轮 / clip 5 轮） |
| `bath-keyboard-serial.log` / `kitchen-serial.log` | 两板串口 clip 播放证据 |
| `soak-summary.txt` | 30 轮浸泡汇总与异常计数 |
| `firmware/SHA256SUMS.txt` | 两块已刷写 BIN 的 SHA256 |

## 7. 复现

```bat
materials\core-start.cmd -CheckOnly
powershell -File materials\stability-test.ps1 -Cycles 3
powershell -File materials\stability-test.ps1 -Cycles 3 -Question "我不舒服"
materials\voice-chain-test.cmd -Cycles 2
```
