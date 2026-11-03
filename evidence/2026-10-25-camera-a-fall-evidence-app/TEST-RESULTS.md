# 测试结果

## APP Node 行为/静态测试

```text
TypeScript compile: PASS
tests=198 pass=198 fail=0 cancelled=0 skipped=0
CAMERA-A 新增目标用例=15，全部通过
```

覆盖：入口资格、成功 JPEG、401、403、404、500、超时、非 JPEG、超过 2 MiB、
JPEG 格式、取消、主动重试、告警隔离、账号隔离、Authorization 不进 URL、平台生命周期接线。

## APP Hypium

```text
Tests run: 21, Failure: 0, Error: 0, Pass: 21, Ignore: 0
BUILD SUCCESSFUL
```

原始结果：`logs/app-hypium-test-result.txt`。

## APP 构建

```text
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
BUILD SUCCESSFUL
33 tasks: 27 executed, 6 up-to-date
signingConfigs 未配置，因此候选为 unsigned debug HAP
```

构建有项目既存 warning（TokenVault deprecated API、若干页面 may throw），无 CAMERA-A 编译错误。

## backend（源码未修改）

```text
npm run check: PASS
npm test: 215/215 PASS
npm run test:restart: 2/2 PASS
```

证据专项既有测试通过：授权读取、精确绑定、不同告警、路径遍历、非 JPEG、SHA-256、
2 MiB、篡改检测、`private, no-store`、URL query token 无效。

## 公网只读探测

```text
GET https://api.luxunacc.xyz/healthz -> 200 application/json
GET /api/v1/alerts (no session) -> 401
GET /api/v1/alerts/camera-a-probe/evidence/content (no session) -> 401, Cache-Control: no-store
```

匿名 401 只证明鉴权门，不能证明证据 route 的部署版本；没有输出任何秘密。
