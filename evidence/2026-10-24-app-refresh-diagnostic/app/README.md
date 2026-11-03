# 颐养守护 · 独居老人居家安全监测与应急辅助系统（北向 App）

> **第三届河南省信息技术应用创新大赛 · 赛题四**
> 平台：HarmonyOS 5.0.4 (API 16) · DevEco Studio · ArkTS / ArkUI
> 工程路径：`E:\eco_project\ElderlyCareGuardian`
> 交付截止：2026-11-06
> 版本：v1.0.0（2026-10-12）

## 目录结构

```
ElderlyCareGuardian/                       ← DevEco Studio 工程根（含 hvigor / oh_modules）
├── README.md                    ← 本文件
├── DESIGN_SYSTEM.md             ← 设计规范（颜色/字体/组件/交互）
├── preview/
│   └── preview.html             ← 高保真 HTML 预览（浏览器直接打开）
├── build-profile.json5          ← 保留 DevEco 原始构建配置
├── hvigorfile.ts / oh-package.json5 / code-linter.json5
├── AppScope/
│   ├── app.json5
│   └── resources/base/element/string.json   ← app_name = "颐养守护"
└── entry/src/main/
    ├── module.json5             ← 已追加 INTERNET / VIBRATE / DISTRIBUTED_DATASYNC 权限
    ├── resources/base/
    │   ├── element/color.json   ← 已注入完整调色板（primary/success/warning/critical 等）
    │   ├── element/string.json
    │   └── profile/main_pages.json  ← 已注册 5 个可路由页面
    └── ets/
        ├── entryability/EntryAbility.ets       ← 保留 DevEco 原始 @kit.* 导入
        ├── entrybackupability/                 ← 保留 DevEco 原始备份扩展
        ├── common/
        │   ├── Theme.ets        ← 设计 Token（Color / Space / Radius / FontSize / Size）
        │   ├── DateUtil.ets
        │   └── MockData.ets     ← 演示数据
        ├── model/
        │   ├── Elder.ets
        │   ├── Sensor.ets
        │   └── AlertEvent.ets
        ├── components/
        │   ├── StatusCard.ets        ← 顶部总体状态卡
        │   ├── SensorCard.ets        ← 传感器瓦片
        │   ├── AlertItem.ets         ← 预警列表项
        │   ├── LevelBadge.ets        ← 等级徽标 + TagChip
        │   ├── SectionHeader.ets
        │   ├── EmptyState.ets
        │   ├── Buttons.ets           ← Primary/Secondary/Ghost
        │   ├── NavBar.ets
        │   └── SosFloatingButton.ets ← 全局悬浮 SOS（长按 1.5s）
        └── pages/
            ├── Index.ets             ← 主入口 · 底部 Tabs
            ├── HomePage.ets          ← 仪表盘
            ├── MonitorPage.ets       ← 实时监测
            ├── AlertListPage.ets     ← 预警中心
            ├── AlertDetailPage.ets   ← 预警详情 & 处置闭环
            ├── ProfilePage.ets       ← 我的
            ├── LogPage.ets           ← 安全日志
            ├── DevicePage.ets        ← 设备管理
            └── StatsPage.ets         ← 数据统计
```

## 快速开始

### 1. 环境准备

- DevEco Studio 5.0.4 Release 或以上（工程 `compatibleSdkVersion` 为 `5.0.4(16)`）
- HarmonyOS SDK API 16
- 工程已包含 hvigor 脚手架、oh_modules 依赖、layered_image 图标，无需重新初始化

### 2. 打开工程

1. DevEco Studio → `File` → `Open` → 选择 `E:\eco_project\ElderlyCareGuardian`
2. 等待 `Sync Now` 完成（首次约 30s）
3. 目标设备：Phone 模拟器（推荐 1080×2340）或真机
4. 点击 ▶ Run 'entry'

### 3. 若符号图标（SymbolGlyph）显示为空白

`Sensor.ets` / 各页面里使用了 `$r('sys.symbol.xxx')`。HarmonyOS 各 API 版本的符号库略有差异，若某符号在你的 SDK 中不存在，两种解决方式：
- **替换为等价符号**：编辑对应 `SensorMeta.icon()` / 页面里的 `$r('sys.symbol.xxx')`
- **换成本地图片**：`$r('app.media.my_icon')`，把 SVG/PNG 放到 `entry/src/main/resources/base/media/`

### 4. 关键文件速查

| 需求 | 文件 |
|------|------|
| 修改主色/字号/间距 | `entry/src/main/ets/common/Theme.ets` |
| 替换 Mock 数据 | `entry/src/main/ets/common/MockData.ets` |
| 修改老人档案 | `MockData.elder()` |
| 新增传感器类型 | `model/Sensor.ets` 的 `SensorType` + `SensorMeta` |
| 新增处置方式 | `model/AlertEvent.ets` 的 `DispositionType` + `AlertMeta` + `AlertDetailPage.dispositionOptions` |
| 新增页面 | `pages/` 下建 `.ets` + 在 `resources/base/profile/main_pages.json` 注册 |

## 页面地图

```
Index (Tabs · AppStorage: currentTabIndex)
├── [0] HomePage       首页仪表盘
│       ├── 状态卡（正常/关注/紧急三态）
│       ├── 快捷操作：一键呼叫 · 视频探望 · 消息 · 实时监测
│       ├── 今日概览：活动次数 · 睡眠时长 · 出门次数
│       ├── 待处置预警 Top3 → 点击进 AlertDetailPage
│       └── 设备健康摘要 → DevicePage
├── [1] MonitorPage    实时监测
│       ├── 摘要：在线率 · 最后活动 · 今日触发
│       ├── 过滤器：全部 / 活动 / 门窗 / 环境 / 安全
│       └── 2 列栅格 SensorCard（电量 · 信号 · 状态）
├── [2] AlertListPage  预警中心
│       ├── Tabs：待处置 / 处置中 / 已归档 / 误报 / 全部
│       └── AlertItem 列表 → 点击进 AlertDetailPage
└── [3] ProfilePage    我的
        ├── 用户身份卡
        ├── 守护对象（老人档案 + 病史）
        ├── 紧急联系人（快速拨号）
        ├── 功能：安全日志 · 设备管理 · 数据统计
        ├── 通知设置
        ├── 多终端协同（OpenHarmony 分布式能力开关）
        └── 关于

二级路由：
├── AlertDetailPage   预警详情 & 处置闭环（一屏完成）
│       ├── 状态区（等级 · 计时器 · 描述 · 已推送终端）
│       ├── 快速联系（老人 / 家属 / 社区 / 120）
│       ├── 处置表单（7 种处置方式单选 + 备注）
│       ├── 事件时间线
│       └── 底部行动条（暂不处理 / 确认处置并归档）
├── LogPage           安全日志（按日期分组 · 搜索）
├── DevicePage        设备管理（网关状态 · 电量提醒 · 一键自检）
└── StatsPage         数据统计（24h 活动热力 · 7 日趋势 · 智能洞察）
```

## 关键设计决策

### 1. 暖心医护风视觉

| 元素 | 值 | 说明 |
|------|-----|------|
| 主色 | `#0EA5E9` | 冷静、可信的天青蓝，医护行业标准色 |
| 温暖点缀 | `#F97316` | 珊瑚橙，用于「关怀」类操作（视频探望、AI 洞察） |
| 语义色 | 绿/黄/红 | 与状态严格一一对应，全应用零例外 |
| 圆角 | 16vp | 卡片圆角柔和，避免冷硬感 |
| 阴影 | 极淡 | 扁平化优先，不用大面积模糊 |

### 2. 一屏闭环处置

**问题**：预警发生时，监护人往往慌乱，多次跳转 = 高认知负担 = 处置延迟。
**方案**：`AlertDetailPage` 内直接完成「查看 → 联系 → 归档」全流程：
- 顶部状态区一眼看清严重程度和已过去时长（心理紧迫感）
- 快速联系区 4 个大按钮（老人/家属/社区/120）
- 处置表单 7 个预设选项，一次点选即可归档
- 无需任何跳转即可完成事件闭环

### 3. 全局悬浮 SOS 按钮

- 长按 1.5s 触发（防误触）
- 进度环实时反馈
- 触发后：本地声光报警器启动 + 推送全部联系人 + Toast 明示
- 位于所有 Tab 页之上（Stack 布局）

### 4. 状态共享架构

跨路由页面的状态通过 **AppStorage** 共享：
- `alerts: AlertEvent[]` — 预警事件列表
- `currentTabIndex: number` — 当前 Tab

Tab 内的状态通过 **@StorageLink** 双向绑定；路由页读取后修改并调用 `AppStorage.setOrCreate` 触发全局刷新。这比 `@Provide/@Consume` 更适合跨路由场景。

### 5. 无障碍与适老化

- 触控目标最小 44×44 vp
- 所有语义色配文字/图标（色盲友好）
- 正文 ≥ 14sp，重要数值 ≥ 20sp
- 对比度全部满足 WCAG AA（4.5:1）
- 紧急按钮长按 + 进度反馈，兼顾防误触与心理确认

## 与南向的对接点

| 北向 App 位置 | 需要的南向数据/能力 | 建议协议 |
|---------------|---------------------|----------|
| MonitorPage · SensorCard | 各传感器实时状态、电量、信号 | MQTT / 星闪组网上报 |
| AlertListPage · AlertEvent | 传感器阈值判定后的预警事件 | 边缘计算触发 → 上报 |
| SosFloatingButton · 触发 | 本地声光报警器联动、语音播放 | 星闪/蓝牙下行控制 |
| AlertDetailPage · 一键呼叫 | 电话能力 | `ohos.telephony.call` |
| ProfilePage · 多终端协同 | 分布式流转 | `@ohos.distributedscheduler` |
| StatsPage · 数据聚合 | 历史活动数据 | 本地 SQLite + 云端上报 |

**Mock 数据的位置**：`common/MockData.ets`。真实项目将 `MockData.sensors()` 替换为南向数据订阅（MQTT client），`MockData.alerts()` 替换为本地 `relationalStore` 查询。

## 数据持久化建议

```typescript
// 使用 OpenHarmony Preferences 存储配置类数据（紧急联系人、通知开关）
import preferences from '@ohos.data.preferences';
const store = await preferences.getPreferences(context, 'settings');
await store.put('notifyAlert', true);
await store.flush();

// 使用 RelationalStore 存储预警事件、安全日志
import relationalStore from '@ohos.data.relationalStore';
const store = await relationalStore.getRdbStore(context, {
  name: 'alerts.db',
  securityLevel: relationalStore.SecurityLevel.S1
});
await store.executeSql(`CREATE TABLE IF NOT EXISTS alert (
  id TEXT PRIMARY KEY, level TEXT, status TEXT,
  sensor_type TEXT, sensor_name TEXT, location TEXT,
  title TEXT, description TEXT,
  created_at INTEGER, closed_at INTEGER,
  handler TEXT, disposition TEXT, note TEXT
)`);
```

## 创新项建议（加分点）

1. **多终端协同**：预警一键流转至子女手机 / 社区大屏 / 智慧屏（`startAbility` 分布式）
2. **AI 智能洞察**：StatsPage 已留位。可对接本地轻量化时序异常检测模型（LSTM 或 Prophet）
3. **视频探望**：接入 OpenHarmony 分布式音视频能力
4. **社区网格联动**：与「豫事办」政务小程序打通，一键上报社区
5. **跌倒检测**：南向加速度传感器 + 北向 AI 判定融合

## 预交付检查清单

### 视觉质量
- [x] 无 Emoji 图标（一律使用 `sys.symbol.*` SymbolGlyph）
- [x] 图标风格统一（系统 SF Symbols 语义化图标）
- [x] 悬停/按下态无布局跳动
- [x] 颜色对比度 ≥ 4.5:1

### 交互
- [x] 所有可点击元素 ≥ 44×44 vp
- [x] 异步操作有 loading（如 `PrimaryButton.loading`）
- [x] Toast 明示操作结果
- [x] 关键操作二次确认（如呼叫 120 弹窗）

### 无障碍
- [x] 状态不依赖单一颜色（配文字/图标）
- [x] 触控目标充足
- [x] 正文字号 ≥ 14sp

### ArkTS 代码质量
- [x] 无 `Object.assign(this, Partial<T>)` 反模式
- [x] 无 `any` 类型
- [x] 所有 `@Prop`/`@State`/`@StorageLink` 均有默认值
- [x] ForEach 均提供 keyGenerator

### 待完成（真实项目）
- [ ] 替换 MockData 为真实南向订阅（MQTT）
- [ ] 集成 RelationalStore 持久化预警记录
- [ ] 集成 `@ohos.telephony.call` 实现真实拨号
- [ ] 集成 `@ohos.notification` 系统级推送
- [ ] 集成 `@ohos.distributedscheduler` 多端流转
- [ ] 补充单元测试（`ohosTest/`）
- [ ] 补充国际化（`resources/en_US/`）

## 演示脚本（评审建议路径）

1. **首页** — 展示状态卡「紧急求助」红色态，突出待处置数
2. **点击待处置预警** → 进入 `AlertDetailPage`
3. **详情页** — 展示计时器、快速联系、处置表单
4. **选择「已电话联系老人」+ 填写备注 → 点击「确认处置并归档」**
5. **返回首页** — 状态卡自动切换为「一切正常」绿色态
6. **切换到监测 Tab** — 展示 9 个传感器瓦片、过滤器
7. **切换到我的 Tab** — 展示老人档案、多终端协同开关
8. **进入数据统计** — 展示 24h 活动热力图与 AI 洞察
9. **长按右下 SOS 按钮** — 展示进度环与触发 Toast

## 参考

- OpenHarmony ArkUI 官方组件库：https://docs.openharmony.cn/pages/v5.0/zh-cn/application-dev/reference/arkui-arkts/arkts-common-events-touch-event.md
- HarmonyOS Design 规范：https://developer.harmonyos.com/cn/design
- 大赛官方文件：`E:\acm竞赛模板\赛题四三人小组分工与学习指南.md`

---

**团队分工建议**（对应赛题指南）：
- 北向 App 工程师：负责本工程全部代码 → 集成真实数据
- 南向硬件工程师：负责传感器数据采集 + 星闪组网 → 提供 MQTT topic 约定
- 数据/文档统筹：负责 `MockData.ets` → 真实云端数据管道 + 参赛物料
