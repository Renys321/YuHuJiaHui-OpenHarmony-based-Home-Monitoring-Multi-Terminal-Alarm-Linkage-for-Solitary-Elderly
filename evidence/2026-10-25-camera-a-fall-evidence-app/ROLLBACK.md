# 回滚

## 当前状态

候选 HAP 未安装，公网 backend 未修改，P0 正式 HAP 与回退包未覆盖。因此运行环境无需回滚。

## 源码回滚范围

如需撤销 CAMERA-A，仅撤销 `APP-IMPLEMENTATION.md` 所列 10 个 APP 文件中的本轮变更，
并删除本证据目录。不要触碰：

```text
9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A (P0 正式 HAP)
8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985 (回退包)
DAYU bundle com.dsh.eldercare
backend 公网部署、DNS、生产数据
```

证据缓存只在 APP 进程内；停止候选进程或登出即可清空，不需要删除媒体文件或 Asset Store 图片。
