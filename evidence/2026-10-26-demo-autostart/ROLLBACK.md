# ROLLBACK

## 1. 正式 HAP

本轮**没有修改、没有重装**正式 DAYU 应用。当前仍为：

```text
com.dsh.eldercare 1.0.2 / 1000002
1,883,399 B
SHA-256 A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE
```

因此不需要 HAP 版本回退。不要为了“回退”卸载或清应用数据。

## 2. 停止演示看护

在看护窗口：

```text
S  停止自动看护（不会自动反向拉起）
Q  退出看护窗口（P0/应用/推理保留）
```

关闭窗口只停止看护逻辑；不主动停 P0/应用/推理。若需要完全停本机推理，在正式应用点“暂停监护”，或只终止独立目录内的进程：

```text
hdc -t 450100445634303332012847942eca00 shell "pidof dayu_local_fall"
# 先确认 /proc/<pid>/exe 指向 /data/local/tmp/dayu-demo-autostart-2026-10-26/
hdc -t 450100445634303332012847942eca00 shell "kill -TERM <pid>"
```

不要按名称杀未知 PID，不要杀整个 Windows Job。

## 3. 回退入口/看护器

新增文件均未覆盖 P0 冻结制品：

```text
materials\start-demo-all.cmd
materials\demo-autostart\demo-autostart.ps1
materials\demo-autostart\dayu\
evidence\2026-10-26-demo-autostart\
```

停止看护后，删除这些新增文件即可恢复“无统一入口”的状态；不会删除正式应用、P0、homemon 或历史证据。

## 4. 回退 DAYU 独立推理目录

只删除新增独立目录：

```text
/data/local/tmp/dayu-demo-autostart-2026-10-26/
```

不影响 `/data/homemon`、正式应用数据、P0 冻结制品。删除前先确认没有本目录的推理进程。

## 5. P0/公网

本入口不创建第二套 Broker/Bridge/supervisor，也不创建 Windows 服务/计划任务。P0 继续由既有 `start-demo-supervisor.cmd` 窗口管理；关闭该窗口会停止公网同步 supervisor，但不会停止 DAYU 本机推理（若仍在运行）。

## 6. 应用数据与设置

本轮未清理应用数据、未修改签名身份、未改系统相机服务。预览参数仍为 60%/130%。若需要回到其他正式 HAP，必须先核对版本降级/签名限制；**不能仅因为旧 HAP 存在就声称 `install -r` 一定能无损降级**，也不要卸载清数据绕过限制。
