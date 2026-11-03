# 回滚

## 运行环境

候选 HAP 未安装，公网 backend、DNS 和生产数据未修改，P0 正式包与回退包未覆盖。因此当前
运行环境不需要回滚。

## 制品基线

```text
P0 正式 HAP：9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A
P0 回退 HAP：8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
原 CAMERA-A：BCAA21B2452D545611E7198FB5CE8C58B27D7863BC799C1BB5D1DB2ADEA54F7C
```

三者在 hardening 构建后重新计算哈希，均与冻结值一致。

## 源码回滚范围

如需撤销本轮，只撤销 `MANIFEST.md` 中列出的 7 个 APP 源码/测试文件的 hardening 差异，
并移除本目录的新候选。不得触碰 P0 制品、原 CAMERA-A 候选、DAYU HAP、backend 部署或生产
数据。缓存只存在于进程内，停止候选进程或登出即可释放，不需要清理相册或持久化存储。
