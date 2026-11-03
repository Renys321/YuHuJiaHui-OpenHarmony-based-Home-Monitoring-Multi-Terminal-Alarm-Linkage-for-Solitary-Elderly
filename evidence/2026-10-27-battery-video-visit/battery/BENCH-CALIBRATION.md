# 电池电量 · 台架校准与真机验收（契约 §1.3 / §7）

- 本文是**接线完成后**的校准/验收作业指导：本期没有实物电池、没有分压、没有 ADC 接线 →
  **本文所有步骤均未执行**（真实测量状态 `BLOCKED-BY-HARDWARE`，见 `REPORT.md`）。
- 契约要求：至少两点万用表校准后才允许 `NODE_BATTERY_CALIBRATED=y` 并输出 `percent`；
  未标定时固件只输出 `mV`，`percent=null`，APP 必须显示“未标定”。
- 安全：锂电必须在**保护板之后**（OUT+/OUT−）取电；接线前断电；万用表先量电压再接板。

## 0. 判定标准速查

| 验收项 | 通过标准 |
|---|---|
| 静态电压精度 | 万用表读数 vs 上报 `mv` 误差 **≤ ±50mV**（3.0–4.2V 全程） |
| 未标定行为 | `calibrated=false` 时 `percent` **必须是 null**；APP 显示“未标定” |
| 未接电池 | `valid=false`、`mv=null`、`percent=null`、`reason` 为短码；APP 显示“电量未知”，**不是 0%** |
| 断线/拔分压 | 同上；不得沿用上一个旧值，不得显示 0% |
| 数据过期 | `lastSeenTs` 距今 >120s → APP“电量数据过期（最后更新 HH:mm）” |
| 设备离线 | APP“设备离线，电量未知” |
| 低电量 | 电压 ≤ `NODE_BATTERY_LOW_MV`（3500）时 `low=true`；APP 加“电量偏低” |
| 抖动 | 8 样本极差 >300mV 或一致率不足 → `reason=UNSTABLE`，不得给电压/百分比 |
| 重启 | 重启后设备/电量继续上报；后端重启后已聚合电量不丢（详见后端测试） |

**不通过/不允许**：
- 用 USB 5V、充电宝电压、`csq`、Wi-Fi RSSI、或“固定 100%”冒充电量；
- 未标定就显示百分比（百分比只能来自 `calibrated=1` + 1S OCV 近似表）；
- 拔掉电池后 APP 仍显示旧电压或 0%；
- 用 DAYU200 系统的 `BatteryService capacity: 11` 当真实电量（那是模拟值，`present: 0`）。

## 1. 台架准备

1. 按 `BOM-WIRING.md` §1 备料；电池先充到约 3.8V 存放。
2. 分压与滤波焊好（R1=100k、R2=100k、100nF、1k），**先不插电池**。
3. 万用表直流 20V 档，黑表笔接 GND（与 ESP32 共地），红表笔准备量“电池 OUT+”。
4. 串口：115200，看固件日志。**本轮禁止对 COM4/COM5/COM8 烧录**；接线完成后由用户执行
   `FIRMWARE-BUILD.md` 里的构建/烧录步骤。

## 2. 第一步：不开百分比，先确认“能采样且不伪造”

固件设置（Kconfig / profile）：

```
CONFIG_NODE_BATTERY_ADC_CHANNEL=2      # GPIO2 = ADC1_CH1
CONFIG_NODE_BATTERY_DIVIDER_NUM=2
CONFIG_NODE_BATTERY_DIVIDER_DEN=1
CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE=1000
CONFIG_NODE_BATTERY_CAL_OFFSET_MV=0
CONFIG_NODE_BATTERY_LOW_MV=3500
CONFIG_NODE_BATTERY_MIN_MV=2500
CONFIG_NODE_BATTERY_MAX_MV=4350
CONFIG_NODE_BATTERY_CALIBRATED=n        # 先不标定
CONFIG_NODE_BATTERY_SAMPLE_SEC=30
```

接上电池（4.0V 左右），观察串口日志每 30s 一行：

```
电池采样: raw_median=2510 mv=3800 valid=1 percent=-1 low=0 calibrated=0 reason=OK
```

判定：
- `valid=1`、`mv` 与万用表同量级（未标定允许偏几十 mV）；
- `percent=-1`（JSON 里 `"percent":null`）——**这是正确的**，不是缺陷；
- 上报 JSON 里出现 `"battery":{"source":"battery","present":true,"valid":true,"mv":3800,"percent":null,"low":false,"calibrated":false,"reason":""}`。

若 `valid=0` / `reason=UNSTABLE`：先查接线/共地/100nF 是否漏焊，再查采样时是否正好碰上 Wi-Fi 发射。

## 3. 两点校准（契约要求的最低标准）

原理：ADC 线性近似 `raw→pin_mv→battery_mv` 后仍有系统误差（芯片个体差异、电阻 1% 误差、走线压降）。
两点校准用**万用表真实电压**拟合 `battery_mv_cal = battery_mv × GAIN/1000 + OFFSET`。

> 关键：两个校准点必须**静置**（断开升压负载或用电子负载小电流），并在稳定 60s 后读数；
> 用同一块万用表；记录万用表读数与固件 `mv`（未标定值）成对数据。

### 步骤

1. 电池充到约 **4.10–4.15V**，静置 1 分钟。
2. 万用表量电池 OUT+ 记 `V1`（如 4.120V）；读固件日志当前 `mv` 记 `M1`（如 4020mV）。
3. 放电（可用 10Ω/2W 假负载短时放电或电子负载 100mA）到约 **3.40–3.50V**，静置 1 分钟。
4. 记 `V2`（如 3.450V）与固件 `M2`（如 3390mV）。
5. 计算（固件单位：mV、千分比）：

```
GAIN_per_mille = round(1000 × (V2 - V1) / (M2 - M1))
OFFSET_mV      = round(V1 - M1 × GAIN_per_mille / 1000)
```

示例：`V1=4120, M1=4020; V2=3450, M2=3390`
→ `GAIN = 1000 × (3450-4120)/(3390-4020) = 1000 × (-670)/(-630) = 1063`
→ `OFFSET = 4120 - 4020×1063/1000 = 4120 - 4273 = -153mV`

6. 写入 Kconfig：`CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE=1063`、`CONFIG_NODE_BATTERY_CAL_OFFSET_MV=-153`、
   **`CONFIG_NODE_BATTERY_CALIBRATED=y`**，重新构建/烧录。
7. 复测：在 4.10V/3.90V/3.70V/3.50V/3.40V 各点对比万用表，误差必须 ≤ ±50mV。
   记录表见 §5。如果一个点超差，改用 §4 多点分段（固件仍只支持一条直线，
   超差严重时优先检查 R1/R2 实际阻值与焊点）。

> 注意：`GAIN` 允许范围 500–2000 千分比、`OFFSET` −500…+500mV（Kconfig range 已约束）。
> 计算结果超出范围说明接线/电阻有问题，**不要硬填**。

## 4. 多点校准（推荐，可选）

ESP32-S3 的 ADC 有明显非线性。若两点校准后在中间点仍超 ±50mV：

1. 取 5 点：4.15V / 3.95V / 3.75V / 3.55V / 3.35V，每点静置 60s，记录 `(V_i, M_i)`。
2. 线性回归 `V = a×M + b`（Excel/脚本），换算 `GAIN=1000a`、`OFFSET=b`。
3. 计算残差表：每点 `|V_i - (M_i×GAIN/1000 + OFFSET)|`，全部 ≤50mV 才算通过。
4. 如残差系统性弯曲（中间偏低/偏高）：记录数据并改进硬件（提高 R1/R2 精度到 0.1%、
   缩短走线、加 100nF），**不允许**在固件里用分段表掩盖硬件问题（本期未实现分段表）。
5. `percent` 只有 `calibrated=y` 才出现，且是**1S Li-ion 静置 OCV 近似**（误差 ±10% 量级），
   APP 必须标注“估算/未标定”语义，不得当成精确库仑计。

## 5. 放电验收（真实测量，本期未做）

目的：证明“从满充到放空，APP 显示的 mV 与万用表一致”。

1. 满充静置 → 记录起始点。
2. 用恒定小负载（如 100mA）放电，每下降约 0.1V 停下静置 2 分钟，记录：
   万用表读数、固件 `mv`、`percent`、`low`、APP 显示文案。
3. 一直放到 3.4V（不要放到保护板切断，避免过放）。
4. 记录表（填满才算通过）：

| # | 万用表 V | 固件 mv | 误差 mV | percent | low | APP 文案 | 时间 |
|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| … |  |  |  |  |  |  |  |

通过标准：所有点 `|误差| ≤ 50mV`；`low` 在 ≤3500mV 时为 true；`percent` 单调不增。

## 6. 异常场景验收（每条都必须做）

| 场景 | 操作 | 期望（固件 JSON） | 期望（APP） |
|---|---|---|---|
| 未接电池 | 拔电池，只留分压 | `valid=false, mv=null, percent=null, reason=OUT_OF_RANGE` | 「电量未知（设备未上报电量）」或按契约的未知文案；**不得 0%** |
| 浮空引脚 | 拔掉 R1 只留 R2/ADC | `valid=false, reason=UNSTABLE 或 OUT_OF_RANGE` | 不得出现任何电压/百分比 |
| 断线（采样中途） | 拔掉 1kΩ 串联电阻 | 下一周期 `valid=false` | 不得沿用旧值；不得 0% |
| 数据过期 | 断电/断网 >120s | 设备离线/停止上报 | 「电量数据过期（最后更新 HH:mm）」或「设备离线，电量未知」 |
| 恢复 | 重新接好 | 30s 内恢复 `valid=true` + 正确 mV | 恢复显示电压 |
| 低电量 | 放电到 3.45V | `low=true`，`mv≈3450` | 文案带“电量偏低” |
| 重启设备 | 断电重启 | 重启后 30s 内上报真实 mV（不沿用上次值、不写死） | 恢复真实值 |
| 后端重启 | 重启 backend | 已聚合 `battery` 不丢（见 `REPORT.md` 持久化测试） | 数值不变或按过期规则处理 |

## 7. 证据留存要求

每个验收点必须留存：串口日志（含 `电池采样:` 与上报 JSON 原文）、万用表读数照片、APP 截图
（含时间）、以及对应 `deviceId`。**没有证据的点不得在报告中写成“通过”。**

## 8. 本期结论

- 校准/放电/异常验收 **全部未执行**：没有电池、没有分压、没有接线、没有开串口、没有烧录。
- 代码侧已把“未标定不给百分比、未接电池给 null、抖动判 UNSTABLE、越界判 OUT_OF_RANGE、
  低电量按阈值、断线不沿用旧值”全部实现并有主机单测（见 `REPORT.md` §3）。
- 真实测量状态：**BLOCKED-BY-HARDWARE**（缺：1S 锂电 + TP4056 + MT3608 + 100k×2 + 100nF + 1k + 万用表 + 接线）。
