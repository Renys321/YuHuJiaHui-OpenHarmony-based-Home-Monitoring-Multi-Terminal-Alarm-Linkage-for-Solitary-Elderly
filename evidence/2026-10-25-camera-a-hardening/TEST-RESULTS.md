# 测试结果

## CAMERA-A 专项

```text
TypeScript core compile: PASS
tests=30 pass=30 fail=0 cancelled=0 skipped=0
```

原 CAMERA-A 15 项与新增 hardening 15 项共同执行。新增覆盖响应头三种大小写、字符串数组、
JPEG 参数、非法/冲突 Content-Length、缺失头部，以及 LRU 条目/字节驱逐、get 更新顺序、
同 key 替换、超大条目拒绝、copy-in/copy-out、guardian 隔离与两种清理统计。

说明：第一次预检误把 TypeScript 编译脚本当作可直接执行文件，未生成新增测试模块，Node
因模块不存在退出；这属于测试编排调用错误，不是产品断言失败。改为既有的
`node .../typescript/bin/tsc` 后，专项测试和后续全量验收均从干净编译产物通过。

## APP Node 全量行为及静态测试

```text
tests=213 pass=213 fail=0 cancelled=0 skipped=0
duration=942.8003 ms
```

## APP Hypium

```text
Tests run: 21, Failure: 0, Error: 0, Pass: 21, Ignore: 0
hvigor test: BUILD SUCCESSFUL
20 tasks: 19 executed, 1 up-to-date
```

## ArkTS 平台编译与 assembleHap

```text
:entry:default@CompileArkTS: SUCCESS
:entry:default@PackageHap: SUCCESS
assembleHap: BUILD SUCCESSFUL
33 tasks: 27 executed, 6 up-to-date
```

项目未配置 signingConfigs，因此输出是 unsigned debug HAP。构建仅有项目既存的 deprecated
API 和页面函数可能抛异常警告，没有 CAMERA-A hardening 编译错误。

## backend 回归

backend 源码未修改；仅运行本地回归：

```text
npm run check: PASS
npm test: tests=215 pass=215 fail=0 cancelled=0 skipped=0
npm run test:restart: tests=2 pass=2 fail=0 cancelled=0 skipped=0
```

## 环境操作

```text
候选 HAP 安装：未执行
公网接口访问：未执行
公网 backend/DNS/生产数据修改：未执行
FALL/SOS/ACK/reset：未触发
```
