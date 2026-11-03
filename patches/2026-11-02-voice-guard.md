# 2026-11-02 · 语音关闭配置编译修复（living）

## 问题

`micupload` 串口命令分支直接引用 `CONFIG_NODE_MIC_RECORD_SEC` / `CONFIG_NODE_MIC_PORT`，
而这两个符号在 Kconfig 里 `depends on NODE_VOICE_ENABLED`。living 使用语音关闭配置
（`CONFIG_NODE_VOICE_ENABLED=n`），宏未定义，编译失败：

```
node_main.c:647: error: 'CONFIG_NODE_MIC_RECORD_SEC' undeclared
node_main.c:648: error: 'CONFIG_NODE_MIC_PORT' undeclared
```

## 改动

```c
#if CONFIG_NODE_VOICE_ENABLED
        /* 原 micupload 逻辑（录音→9303→ASR） */
#else
        ESP_LOGW(TAG, "MIC_UPLOAD 未启用：本节点语音关闭（CONFIG_NODE_VOICE_ENABLED=n）");
#endif
```

四份 `node_main.c`（common/kitchen/bathroom/living）同步为同一哈希；kitchen/bathroom
行为不变（语音使能分支），living 可编译。

## 验证

- common 与三工程源码逐字节一致；
- 三工程构建通过：kitchen `a3ad5db9…`、bathroom `7035e25f…`、living `1923fc6d…`；
- living bin 内出现“MIC_UPLOAD 未启用”，kitchen/bathroom 仍为“已排队”。

证据：`evidence/2026-11-02-firmware-refactor/`（`outputs/build-after-fix.log`、`outputs/living-build.log`）。
