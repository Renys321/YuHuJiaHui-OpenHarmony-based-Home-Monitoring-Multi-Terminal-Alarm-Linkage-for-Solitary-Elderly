# 中间状态（2026-10-27 15:21 · 真机/模拟器安装已完成，等待生产发布）

> 本文件是过程记录；最终结论以 `REPORT.md` 为准。

## 已真实验证（本轮新增）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| HarmonyOS 模拟器启动 | `Mate 90 Pro`（HarmonyOS 7.0.0.107，x86_64，UDID `454D5505…0000`）启动成功，`hdc` target `127.0.0.1:5555` | `acceptance/INSTALL-RECORD.txt` |
| APP 1.0.5 unsigned 安装 | **安装成功**（模拟器接受 unsigned debug HAP，与历史验收方式一致）；`versionName=1.0.5`、`versionCode=1000005`、`appSignType=none` | 同上 + `acceptance/app-bm-dump-1.0.5.txt` |
| APP 启动 / 登录页 | `aa start` 成功，登录页正常；勾选协议、输入生产监护人账号密码后**登录成功** | `screenshots/01-launch.jpeg`、`09-login-result.jpeg` |
| 健康评估入口 | `我的 → 健康评估` 进入成功 | `screenshots/10-profile-tab.jpeg`、`11-health-page-top.jpeg` |
| 固定提示 | 页面上同时显示：隐私提示、免责声明、**第三方 AI（DeepSeek）告知** | `screenshots/11-health-page-top.jpeg` |
| 两页表单 | 第 1 步基础信息、第 2 步生活习惯均可填写（年龄、夜间醒来、运动次数已实际输入） | `screenshots/20–29` |
| APP 失败态 | 保存时后端尚未发布（404）→ 页面显示 `对象不存在或已失效` + `重试`，不伪造成功 | `screenshots/30-save-result.jpeg` |
| APP 测试 | 工作区 **368/368**；构建副本 **338/338**；HAP 构建成功 | `logs/` |

## 仍待完成（阻塞点）

1. **生产后端发布**：`GET /api/v1/health-profile`（已登录）仍返回 **404 not found**，说明生产仍是 v7，健康接口不存在。
   发布包与命令已就绪：`deploy/DEPLOY-COMMANDS.md`（镜像 `54F00C11…` / 源码 `B916911B…`）。
2. 生产发布完成后需补做（Lead 自动继续，无需再询问）：
   - 公网接口验证（401/保存/读取/建议/409/504）；
   - APP 真机全流程：保存 → 生成（第三方 AI 同意弹窗）→ 真实 DeepSeek 结果四段 + 免责声明截图；
   - 重启 APP 后资料仍在；失败/超时态可重试；
   - 最终 `REPORT.md` + `SHA256SUMS.txt`。

## 说明

- 安装目标为**模拟器**：DAYU200 真机（UDID `DC3ABD…`）要求签名且本机无 `com.example.program_04` 签名材料，unsigned 安装被拒（`9568320 no signature file`），SDK 开发签名也被拒（`9568393 verify code signature failed`）。模拟器是该项目历史上安装该 APP 的既有环境（`appSignType=none`），本轮沿用，未换签名身份、未卸载清数据（该实例原本未安装该 APP，属全新安装）。
- 安装未修改 APP 源码、未改 bundleName、未改签名字段配置。
