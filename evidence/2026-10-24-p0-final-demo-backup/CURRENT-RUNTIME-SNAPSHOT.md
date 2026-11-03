# 当前运行现场只读快照（2026-10-24）

快照时间：2026-10-24T23:58:25+08:00（Git/系统时间 23:56:17 读取）
性质：**CURRENT READ-ONLY**。本快照只记录读取结果，没有关闭、重启、杀死、安装、串口操作或网络写入。

## 1.  Git 状态

```text
git 版本          2.56.0.windows.2（可用）
<WORKSPACE>                 不是 Git 仓库（无 .git）
<WORKSPACE>\competition     不是 Git 仓库（无 .git）
<WORKSPACE>\APP             不是 Git 仓库（无 .git）
APP\ElderlyCareGuardian        不是 Git 仓库（无 .git）
competition/APP 下 depth<=4    未发现任何嵌套 .git
```

因此本次无法提供分支、HEAD commit、git status、已修改/未跟踪文件清单；
事实是“工作区没有 Git 元数据”，不是“git status 干净”。
本次未执行 git reset/checkout/clean，未提交、未推送，未回退任何文件。

## 2.  进程（只读）

```text
supervisor      PID 11872  ppid 51568  node public-sync-supervisor.js（evidence 候选入口）
worker          PID 50580  ppid 11872  node public-sync-worker.js
Broker          PID 43624  node mqtt_broker.js 1883
Bridge          PID 47704  node mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 ...
模拟器          PID 52588  Emulator.exe（既有 Mate 90 Pro）
手机 APP        PID 26710  com.example.program_04（设备侧，127.0.0.1:5555）
```

其他 node 进程（Codex CUA、DevEco language server）与本演示链路无关，未操作。

## 3.  端口与 HDC

```text
1883  LISTEN  pid=43624  addr=::
9001  LISTEN  pid=43868  addr=127.0.0.1   （hdcd 侧 fport 转发）
9101  LISTEN  pid=47704  addr=::
5555  LISTEN  pid=52588  addr=127.0.0.1
```

```text
hdc list targets:
  127.0.0.1:5555
  450100445634303332012847942eca00

hdc fport ls:
  450100445634303332012847942eca00    tcp:9001 tcp:9000    [Forward]
```

## 4.  supervisor lock/state（只读）

```text
lock 文件内容       11872
state.supervisorPid 11872
state.workerPid     50580
state.state         HEALTHY
state.restartCount  1
state.heartbeatAt   1792857500290
```

lock 与 state 的 supervisor PID 一致；worker 父进程为 supervisor。

## 5.  DAYU 与手机

```text
DAYU target        450100445634303332012847942eca00（USB Connected）
homemon            运行中 pid=2449，设备侧 9000 LISTEN
homemon SHA-256    0d243539403de89c547defacf43c86a4980142ef8ec686b277be7133c42881e6（冻结原版，未替换）
手机模拟器         127.0.0.1:5555（Mate 90 Pro，HarmonyOS 7.0.0.107）
APP bundle         com.example.program_04
APP 版本           1.0.0 / versionCode 1000000
APP PID            26710
```

## 6.  自然 202 累计计数（只读观察，不作为新验收）

```text
esp32-kitchen   145
esp32-bath      124
dayu200-living  160
```

这些计数来自 supervisor 事件日志（自然上报，retain=0）；本任务不重做验收，只记录现场仍在运行。

## 7.  本次任务未执行的变更

未关闭/重启/杀进程，未切换入口，未安装/覆盖 HAP，未操作任何 COM 端口，未烧录，
未发送 MQTT/HTTP ingest/SOS/ACK/reset/设备命令，未修改 backend/gateway/绑定/Wi-Fi/AP/DNS。
