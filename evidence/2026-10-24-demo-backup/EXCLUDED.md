# 未纳入备份的内容

以下内容有意排除，原因是它们不是当前推荐演示件、含生成缓存/运行时状态，或可能包含敏感凭据：

- `.local/`、`sdkconfig*`、`.env`、数据库和运行时快照；
- APP 的 `build/`、`.preview/`、`.test/`、`node_modules/` 生成目录；
- Wi-Fi 密码、Token、Cookie、Authorization、INGEST_KEY、AppSecret 和签名私钥；
- COM8 的 bench 固件和 RGB Demo，不计入当前三节点演示；
- 手机失败试验包 `94361A...`、`7A78C68C...`、`6B7CD42C...`；
- 未部署的 homemon `06ECFB...` 候选；
- 原始串口日志、完整运行日志和可能含认证上下文的临时文件。

排除项不代表丢失：相关历史证据仍留在原工作区的 `competition/evidence/` 中，但不属于本次可演示版本恢复包。
