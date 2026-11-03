# APP 更新记录（D/E-only，unsigned 覆盖更新）

执行时间：2026-10-27 00:18 +08:00（模拟器 `127.0.0.1:5555`，Mate 90 Pro emulator）

## 制品

| 项 | 值 |
|---|---|
| 文件 | `app/guardian-d-e-only-2026-10-26-unsigned.hap` |
| 大小 | 2,552,182 B |
| SHA-256 | `95A7D01A8013C3747F84D0691B7B8DE726F57EE0971CC28ADD28622AD2CD08A4` |
| bundle | `com.example.program_04`（未变） |
| 版本 | versionCode **1000001** / versionName **1.0.1**（更新前 1000000 / 1.0.0） |
| 内容 | 仅 D（处置结果 + 安全日志）+ E（活动报告）；CAMERA-A 证据图片链路已剥离（见 `app/CAMERA-A-STRIP.md`、`app/ISOLATION-DIFF.md`） |
| 签名 | 无（与已安装包一致；未引入新签名身份） |

## 安装命令

```
hdc -t 127.0.0.1:5555 install -r app/guardian-d-e-only-2026-10-26-unsigned.hap
→ [Info]App install path:... msg:install bundle successfully.
```

## 设备侧版本对比（`bm dump -n com.example.program_04`，原文见 `acceptance/app-bm-dump-before-install.txt` / `-after-install.txt`）

| 字段 | 安装前 | 安装后 | 判定 |
|---|---|---|---|
| versionCode | 1000000 | **1000001** | 已更新 ✔ |
| versionName | 1.0.0 | **1.0.1** | 已更新 ✔ |
| firstInstallTime | 1792597207955 | **1792597207955（未变）** | **未卸载、覆盖安装** ✔ |
| updateTime | 1793026431876 | 1793031482930（2026-10-27 00:18） | 已更新 ✔ |
| appSignType | none | **none** | 未引入/未更换签名身份 ✔ |
| appProvisionType | debug | debug | 未变 ✔ |
| uid | 20020063 | 20020063 | 未变（数据保留） ✔ |

## 说明

- 该 bundle 自 2026-10-21 起一直以 unsigned debug 方式安装（历史 HAP 与候选 HAP 均 `verify-app` = signature not found；设备 `appSignType=none`），
  因此“保持现有签名身份”在本 bundle 上等价于“保持无签名”。**没有新建证书、没有卸载、没有清数据、没有改模拟器签名校验配置。**
- 依据：`baseline/SIGNING-IDENTITY.md`、`baseline/APP-SIGNING-DECISION.md`。
- 待验收时还需用户确认：登录会话是否保留（未强制重新注册）、D/E 页面可打开且与后端一致。
