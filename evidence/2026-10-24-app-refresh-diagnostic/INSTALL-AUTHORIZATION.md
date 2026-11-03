# 一次性诊断安装/观察授权点（尚未执行）

## 安装前必须明确

```text
需要安装诊断包：
<WORKSPACE>\competition\evidence\2026-10-24-app-refresh-diagnostic\guardian-app-refresh-diag-unsigned.hap
size: 2,102,896
sha256: 0A2AD6643EB41250E23C718A8E740E239D9227A32A8B38D455CFA1BB73D20F18
bundle: com.example.program_04
```

该包是 **unsigned diagnostic HAP**，不是 `F91852…` 候选，也不是最终版本。  
**在获得明确安装授权前不执行 install。**

## 获授权后的唯一操作

```text
hdc -t 127.0.0.1:5555 install -r <诊断包>
```

要求：

- 保留 APP 数据；
- 允许安装导致一次 APP 启动；
- 不卸载、不清数据；
- 若 unsigned 被拒绝：停止，不改签名配置，不卸载旧 APP；
- 失败回退 `8A722…`。

## 观察

1. 先等一次自动轮询（30s）；
2. 在同一 PID 内点击一次 MonitorPage 刷新；
3. 采集 hilog `AppRefreshDiag`，按同一 refreshId 对齐；
4. 只记录白名单字段；
5. 不执行 PIR/离线验收，不安装 `F91852…`；
6. 不更新最终交付版本。

## 预期判定

- 无新 HTTP：调度/single-flight；
- REUSED：single-flight 缺陷；
- HTTP 旧 332/527：客户端/目标/缓存；
- HTTP 236/329 但 map 旧：映射；
- map 当前但 AppStorage 读回旧：AppStorage；
- AppStorage 当前但页面旧：MonitorPage/render；
- devices 失败但 toast 成功：成功判定/错误传播。
