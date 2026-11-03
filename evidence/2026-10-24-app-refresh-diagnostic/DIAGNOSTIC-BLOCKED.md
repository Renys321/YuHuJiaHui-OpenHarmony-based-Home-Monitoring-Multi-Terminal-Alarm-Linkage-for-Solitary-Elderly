# APP Refresh 诊断：DIAGNOSTIC_BLOCKED（2026-10-24）

## 前置校验

```text
diagnostic HAP:
<WORKSPACE>\competition\evidence\2026-10-24-app-refresh-diagnostic\guardian-app-refresh-diag-unsigned.hap
size=2,102,896 B
sha256=0A2AD6643EB41250E23C718A8E740E239D9227A32A8B38D455CFA1BB73D20F18
```

大小/哈希一致后执行：

```text
hdc -t 127.0.0.1:5555 install -r <diagnostic HAP>
install_exit=0
[Info] ... install bundle successfully.
```

## 阻塞

安装成功后立即检查：

```text
hdc list targets
→ 450100445634303332012847942eca00（仅 DAYU）
```

手机模拟器目标 `127.0.0.1:5555` 已消失，连续 3 次复查仍未恢复。随后：

```text
hdc -t 127.0.0.1:5555 shell ...
→ [Fail][E001005] Device not found or connected
```

因此无法：

- 取得新 APP PID；
- 启动/观察诊断 APP；
- 采集 `AppRefreshDiag` 日志；
- 进行自动/手动刷新分层判断；
- 安装后恢复冻结 8A722 HAP；
- 把任何结果写成 RESTART_RECOVERED 或 FIRST_DIVERGENCE_CONFIRMED。

## 判定

```text
DIAGNOSTIC_BLOCKED
blocker: phone emulator target 127.0.0.1:5555 disappeared after install
```

本轮未安装 F91852、未执行 PIR/离线验收、未修改业务代码或服务、未操作 COM5/COM14/COM8。

## 需要的下一步

请先由现场恢复/重新连接手机模拟器目标 `127.0.0.1:5555`（不在本轮自动重启范围内）。目标恢复后：

1. 重新确认诊断包已安装或重新安装；
2. 恢复/确认 APP 进程并采集诊断日志；
3. 诊断结束后安装回 `8A722…` 并保留数据；
4. 不安装 `F91852…`。
