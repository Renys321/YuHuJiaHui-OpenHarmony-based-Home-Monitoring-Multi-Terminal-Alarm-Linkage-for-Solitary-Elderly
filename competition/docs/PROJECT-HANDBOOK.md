# 域护家徽（居家安全监护）项目手册

> 用途：给开发者/答辩人从头理解整个项目。最后更新：2026-11-01。
> 原则：只写当前真实可复现的能力，未验证项明确标注。

## 1. 项目一句话

面向独居老人的居家安全监护系统：DAYU200 看家/人体检测/显示，ESP32-S3 节点采集环境与语音，PC 网关做识别/问答/语音，云后端做账号/告警/事件，手机 APP 给家属处置。

## 2. 角色分工

| 角色 | 硬件/软件 | 职责 |
|---|---|---|
| 家庭看板 | DAYU200（OpenHarmony） | 摄像头、人体检测、预警/统计、AI 回答文字显示 |
| 房间节点 | 2× ESP32-S3（DNESP32S3） | 温湿度/燃气/烟雾/门磁、SOS、KEY1 语音提问、喇叭播报 |
| 随身求助 | 4G  wearable | SOS/定位，经云与镜像进入系统 |
| 本地网关 | Windows PC Node.js | MQTT、设备桥、视觉、视频 relay、语音 ASR/LLM/TTS、云端同步 |
| 云端 | 阿里云 ECS + Caddy + Node | 账号、告警、elder-safe、视频/设备 API |
| 家属端 | HarmonyOS 手机 APP | 登录、告警处置/ACK、老人自述安全、视频/统计 |

## 3. 总架构

```text
ESP32-S3 厨房/卫生间 ──WiFi TCP 9101──> PC bridge ──MQTT 1883──> public-sync ──HTTPS──> 云
        │ 9303 PCM 上传                         │
        └──────────────> PC voice-gateway <─────┘
                              │ 9302 文本/只读事件
DAYU200 ──USB/hdc rport 9302──┘
        └──hdc 9001/9200/9301──> bridge/vision/video relay
PC voice-gateway ──9102 PCM/clip──> ESP32-S3 喇叭
手机 APP ──HTTPS──> 云后端
```

## 4. 关键端口

| 端口 | 位置 | 用途 |
|---|---|---|
| 1883 | PC | MQTT broker |
| 9000/9001 | 板端/PC | DAYU homemon 状态，hdc fport 9001→9000 |
| 9101 | PC | ESP32 节点 TCP 状态接入 |
| 9102 | PC | 音箱节点 PCM/clip 推送 |
| 9200 | PC | 视觉服务 + hdc rport 视频取帧 |
| 9301 | 板端/PC | DAYU 摄像头服务，hdc fport |
| 9302 | PC | DAYU 语音会话/文本查询；hdc rport |
| 9303 | PC | S3 麦克风 PCM 上传 |
| 9443 | PC | 视频 relay |
| 80/443 | 云 | Caddy → backend |
| 8080 | 云内 | backend 容器 |

## 5. 目录地图

```text
competition/
├─ firmware/                 ESP32-S3 ESP-IDF 工程（kitchen/bathroom/living）
│  └─ common/components/elder_node/  共用节点逻辑
├─ northbound/              DAYU200 OpenHarmony APP
├─ bridge/                  MQTT broker/bridge、运行态
├─ cloud/onenet/            public-sync supervisor/worker
├─ cloud/backend/           云后端（Node）
├─ voice-gateway/           PC 语音网关
├─ vision/                  视觉/跌倒检测
├─ video/relay/             视频 relay
├─ mobile/                  手机 APP 产物
├─ materials/               一键脚本、PPT/DOCX 生成
├─ docs/                    架构/接线/部署/验证/风险
└─ evidence/                验收证据
```

## 6. 端到端数据流

### 6.1 SOS

```text
KEY0/SOS → S3 本地告警语音/蜂鸣 → 9101 状态 → bridge → public-sync → 云告警
→ 手机 APP 待处置；DAYU 预警页同步
```

### 6.2 老人说“我没事”

```text
SOS 提示“如果您没事，请说没事” → S3 4 秒录音 → 9303 → 网关 ASR（prompt 强制安全语法）
→ 云 /internal/v1/elder-safe → 手机 APP 绿卡
→ 不 ACK 原告警；家属 ACK 后按设备回执闭环
```

### 6.3 KEY1 健康语音（稳定有声）

```text
短按 KEY1 → S3 4 秒录音 → 9303 → 网关 ASR/健康判断
→ 网关先回 {"type":"clip","clip":9} 再回 answer
→ S3 本板播放 health.adpcm（约 11.7 秒）
→ DAYU 显示文字
```

### 6.4 DAYU 快捷提问（文字可靠）

```text
DAYU AI 页按钮 → 9302 {"type":"text_query","text":"...","target":"esp32-bath"}
→ 网关 DeepSeek（≤40 字）→ answer 回 DAYU 显示
→ 按 target 推 PCM 给选中 S3（音频受 9102 限制）
```

### 6.5 家属 ACK

```text
APP 点确认 → 云 202 PENDING → 命令经 public-sync/bridge 到设备
→ 设备回执 ACKED → 云告警变 ACKED → APP 绿卡消失/安全日志
```

## 7. 启动与使用

### 7.1 一键脚本

```bat
materials\core-start.cmd
```

新脚本会：

1. 检查 Node/hdc/密钥；
2. 杀掉重复网关进程并重启；
3. 恢复 DAYU hdc 映射；
4. 启动 DAYU APP；
5. 检查 1883/9101/9302/9303/9102；
6. 输出健康报告。

只检查不启动：

```bat
materials\core-start.cmd -CheckOnly
```

持续守护（断线自动重启网关/映射）：

```bat
materials\core-supervisor.cmd
```

### 7.2 手机 APP

```text
手机号：13800138000
密码：  ShouChao2026
```

### 7.3 DAYU200

- 实时状态：摄像头/人体检测；
- AI 问答：4 个快捷问题，可“设置”编辑；
- 播放音箱：全部/厨房/卫生间（当前演示固定卫生间）。

### 7.4 S3 KEY1

- 短按一次，说“我不舒服”；
- 本板播放健康语音；
- 不产生 SOS。

## 8. 测试

### 8.0 本次回归结果（2026-11-01）

```text
core-start -CheckOnly: OK=11 WARN=0 FAIL=0
stability-test -Cycles 3: pass=21 fail=0（新增断言：目标音箱定向推送 / done 回执 / 无跨节点播报）
stability-test -Cycles 30（浸泡）: pass=210 fail=0，问答 663–1321 ms，窗口内 0 异常
voice-chain-test -Cycles 2: pass=2 fail=0（按真实 KEY1 reason=question 路径）
core-supervisor -Once: exit=0
```

### 8.1 自动稳定性测试

```bat
materials\stability-test.cmd -Cycles 3
```

每轮检查：

- gateway 9302/9303/9102 监听；
- DAYU hdc 映射；
- 9302 文本问答（DeepSeek 回答非空、限长）；
- 目标音箱推送日志；
- 云健康接口。

语音链路（不验证喇叭出声）：

```bat
materials\voice-chain-test.cmd -Cycles 2
```

### 8.2 手动验收

| 项 | 操作 | 通过标准 |
|---|---|---|
| SOS | 按 KEY0 | 告警、APP 卡片、DAYU 预警 |
| 我没事 | SOS 后说“我没事” | 云端事件、APP 绿卡、不自动 ACK |
| KEY1 健康 | 短按 KEY1 说“我不舒服” | 本板健康语音 |
| DAYU 提问 | 点快捷问题 | 文字回答 |
| 人体检测 | DAYU 实时状态 | 画面 + 检测帧 |
| 手机 ACK | 点确认 | 等待设备回执/ACKED 状态 |

## 9. 已知短板（必须诚实）

1. 9102 网络 PCM 链路已多次实测稳定（定向推送 + `done ok=1`）；此前“本地 clip 无声”是节点解析 bug（已修复并刷两板），普通回答的 PCM 可正常播报。
2. DAYU 只能快捷提问，不能自由输入；普通回答只保证文字。
3. 历史 pending 告警无法由当前设备回执，ACK 会超时。
4. 门磁代码 IO37，但两板实测 `door.open=true / lastOpenTs=0`，输入未生效（悬空或未接到 IO37）；卫生间温湿度/燃气/烟雾 `valid=false`。
5. hdc 映射/WiFi/PC 网关依赖人工环境，已加脚本但仍非工业级。
6. 手机无系统推送，锁屏不提醒。
7. 单户演示，无多老人/多监护人权限模型。
8. 正式手机 HAP 未签名；部分证据带边界。

## 10. 常见故障

| 现象 | 先查 |
|---|---|
| DAYU 全掉线 | hdc fport/rport 是否丢，跑 `restore-hdc-mappings.ps1` |
| S3 离线 | PC WLAN IP 是否 10.127.130.179、1883/9101 是否在 |
| 网关无响应 | 9302/9303/9102 是否监听，`gateway.out.log` |
| 音箱无声 | 本地 `speaktest` 是否有声；PCM 限制 |
| 手机登录失败 | 后端 443、账号密码、`PASSWORD_MIN` |
| ACK 超时 | 告警是否设备当前活动 ID |
| 云端 404 | 后端镜像是否含 elder-safe、路由 |

## 11. 云端部署

```bash
cd /opt/eldercare
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
  build --no-cache backend
docker compose ... up -d backend
```

详见 `docs/PUBLIC-DEPLOY.md` 与 `evidence/2026-11-01-elder-safe-app/README.md`。

## 12. 关键文件

| 文件 | 说明 |
|---|---|
| `voice-gateway/server.js` | 语音/文本问答/云端/音箱 |
| `voice-gateway/asr.ps1` | SAPI ASR auto/safe/health |
| `firmware/common/components/elder_node/node_main.c` | 节点主逻辑/KEY0/KEY1 |
| `.../local_voice.c` | ES8388 播放/麦克风/健康 clip |
| `.../mic_link.c` | 9303 上传/回执/clip |
| `.../speaker_link.c` | 9102 PCM/clip 接收 |
| `northbound/entry/src/main/ets/pages/AiVoicePage.ets` | DAYU AI 页/快捷问题/设置 |
| `cloud/backend/src/server.js` | 云端 API |
| `mobile/` | 手机 APP 源码/产物 |

## 13. 答辩口径

可以讲：

- 本地告警 + S3 KEY1 健康语音 + DAYU 快捷文字问答 + 云端/APP 记录；
- 人体检测/摄像头；
- SOS“我没事”不自动 ACK。

不要讲：

- 所有 AI 回答都能语音播报；
- 任意问题自由语音问答；
- ACK 100% 闭环；
- 卫生间/厨房网络音频 100% 稳定。
