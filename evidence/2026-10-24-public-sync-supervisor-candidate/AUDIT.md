# public-sync 进程树退出审计（2026-10-24）

## 结论

```text
PROCESS_TREE_EXTERNAL_TERMINATION_SUSPECTED_NOT_PROVEN
```

不是已证明的 child 自退。两次均表现为 launcher 与 child 同时消失，且没有 child exit 日志。

## 时间线

```text
第一次：
  launcher 45780 / child 49732
  start 2026-10-24 00:34:31
  public-sync 最后写入 00:57:47
  lock 仍为 45780，PID 不存在

第二次：
  launcher 51880 / child 53708
  start 2026-10-24 01:10:48
  public-sync 最后写入 01:34:11
  lock 仍为 51880，PID 不存在
```

两次日志末尾都是正常 202/POLL_OK，没有：

```text
[run-public-sync] public-sync exited code=...
```

## 只读审计结果

| 证据源 | 结果 |
|---|---|
| Windows Application 日志（00:30–01:36） | 无 node/public-sync/WER/Application Error 匹配 |
| Windows System 日志（00:30–01:36） | 无 41/6008/1074/6005/6006 等重启/崩溃事件 |
| PowerShell Operational | 只有本会话自己的脚本记录，没有 `Stop-Process/taskkill` 命中 public-sync |
| `demo_recover.state.json` | 不存在；不能证明 `demo_recover -Stop` 执行过 |
| launcher/child 退出日志 | 无 code/signal |
| lock | 保留已死亡 launcher PID，未清理 |
| Bridge/MQTT | 同期仍持续 natural 非 retained 状态 |

## 解释边界

这些证据更符合：

- 启动它的可见终端/控制台被关闭；
- 自动化宿主关闭 Windows Job；
- 外部清理脚本领整个进程树；
- 系统级强制终止。

但没有进程创建/终止审计、没有 launcher 的父终端活动记录，无法证明具体触发者。  
因此不能写成“已定位为 Job 清理”或“已定位为 child 崩溃”。

## 安全结论

现有 `run-public-sync.js` 只负责启动，不是守护器：

- child 退出时会写 exit 日志、清 lock（正常路径）；
- launcher/child 同时被外部终止时，无法记录、无法清 lock；
- 可见终端关闭会留下相同形态的 stale lock。

因此需要 supervisor；但 supervisor 也不能防止自身或整个 Windows Job 被强杀。最终演示必须从 Explorer/独立终端启动，或另行部署 OS 托管方式。
