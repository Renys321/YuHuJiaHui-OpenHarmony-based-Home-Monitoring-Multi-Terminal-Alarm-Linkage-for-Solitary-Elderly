# 板端长帧字节损坏 · 根因定案与修改方案

- 关联：`transport\FINDINGS.md` §2、`REPORT.md` §4
- 状态：根因已定案（字节级），方案待你选型实施
- 所有分析只读：未改代码、未重启 mirror/bridge、未向板端写任何命令

---

## 1. 一句话结论

**不是 homemon 的广播 bug，也不是 mirror 的编码 bug，而是 PC→板端方向的 hdc fport 在 768 字节分块边界处"回退重发"了一段。**
只要 mirror 单次写入 `relay <json>\n` 超过 768 字节，就有约 8% 概率在边界处多出 52–102 字节，
homemon 忠实广播出去 → bridge 与板载 APP 都收到坏帧。

---

## 2. 证据（比上一版更精确）

### 2.1 坏帧的统一模型

用"正常 sos 帧 + 替换 ts/lastSeen"重建真值帧 T（812B），与坏帧做 LCP/LCS 对齐，得到唯一模型：

```
坏帧 = T[0 .. 762]  +  T[k .. 762]  +  T[762 .. 812]
                ↑ 这一段被"回退重发"了一次
```

| 坏帧 | 长度 | 重复段 | k | 重复段长度 | 终止偏移 |
|---|---|---|---|---|---|
| #1 | 914 | T[660,762) | 660 | 102 | **762** |
| #2 | 914 | T[660,762) | 660 | 102 | **762** |
| #3 | 865 | T[709,762) | 709 | 53 | **762** |
| #4 | 864 | T[710,762) | 710 | 52 | **762** |

**四帧的重复段全部终止于 762**，起点不同 → 不是随机乱码，是**固定边界的重发**。

### 2.2 762 是怎么来的

mirror 实际写入的线上字节是 `relay `（6B）+ JSON（812B）+ `\n`（1B）= **819B**。
`768 − 6 = 762` → **hdc forward 的 768 字节缓冲边界，正好落在 JSON 偏移 762**。
重复段长度（52/53/102）取决于当时的 USB 写回压，所以是概率性的 ~8%。

### 2.3 为什么只有 esp32-sos 中招

| 帧来源 | 线上字节数 | 是否 >768 | 坏帧 |
|---|---|---|---|
| mirror → `relay ` + sos JSON | 819 | **是** | **8.2% 中招** |
| mirror → kitchen 注入行 | 6+438+1=445 | 否 | 0 |
| mirror → bath 注入行 | 6+435+1=442 | 否 | 0 |
| homemon 自身 dayu 状态 | 531 | 否 | 0 |

### 2.4 为什么可以排除其它三层

- **homemon 广播**：`tcp_broadcast` 对所有客户端 `send` 同一个 `line` 指针（`homemon.c:731-747`）；
  若坏在这里，两个通道不会收到"完全相同的坏帧"——实际 bridge 与只读探针收到的是同一份坏帧，
  说明**坏在入站行本身**。
- **mirror 编码**：`JSON.stringify` 后单次 `socket.write`（`transport.js:93-104`），Node 不会重复字节；
  `mirror-status.json` 的 `linesSent` 与 homemon 实际收到帧数一致。
- **bridge 读取**：`appendNodeData` 按 `\n` 累积、无重复逻辑；且坏帧在**入站**就坏了。

---

## 3. 修改方案

> 关键约束：损坏发生在 **mirror → homemon 的入站方向**，所以**只能在注入侧或传输侧修**。
> bridge 侧任何"修复坏帧"的动作都救不了板载 APP（APP 已经从 homemon 收到坏帧了），只能减少日志噪音，**不作为方案**。

### 方案 A｜mirror 分块写（推荐先做，改动 3 行）

**文件**：`cloud\wearable-mirror\src\transport.js:93-104`

```js
// 现在
this.socket.write(`relay ${line}\n`);

// 改为：按 ≤512B 分片连续写，语义与字节序完全不变
const buf = Buffer.from(`relay ${line}\n`, 'utf8');
const CHUNK = 512;
for (let off = 0; off < buf.length; off += CHUNK) {
  this.socket.write(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
}
```

- **原理**：若 hdc 的 768B 边界是按"单次 write 的块"计算的，把每次写拆到 512B 就不会再出现跨边界块，回退重发自然消失。
- **代价**：零语义变化（TCP 是字节流）。
- **验证**：见 §4。
- **回滚**：还原 3 行。
- **不确定性**：如果 hdc 是按累计字节数而不是按 write 分块，方案 A 可能无效 → 需要先做小规模验证（见 §5 实验 1）。

### 方案 B｜mirror 直连板端 WiFi，绕开 fport（配置级，最稳）

**改动**：mirror 启动参数 `--relay-to 10.127.130.132:9000`（实测板端 9000 端口从 PC 可达；
homemon 监听 `0.0.0.0:<tcp_port>`）。

- **好处**：整条 sos 注入链路不再经过 hdc fport，768B 边界问题不存在；同时减少 fport 承载。
- **代价**：
  1. 多占 1 个 homemon 客户端槽（`MAX_CLIENTS 8`，当前占 4–5）；
  2. 依赖板端 WiFi 与 IP 稳定（建议在 AP 上给 `54:78:c9:96:a6:b2` 做 DHCP 保留）；
  3. 改配置需重启 mirror（**1 次、约 1–2 秒的 sos 注入空档**）。
- **回滚**：改回 `127.0.0.1:9001` 重启。
- **适用**：演示后 24 小时内做，可同时作为"fport 单点"的部分卸载。

### 方案 C｜缩短 sos relay 帧到 <768B（备选，需 APP 回归）

**文件**：`cloud\wearable-mirror\src\model.js:397-444`（`buildStatus`）

- sos 设备无传感器，`sensors`（约 400B）、`history`、`slots`、`mirror` 对板载 APP 的"随身求助"展示基本无用；
  可新增 `--relay-compact` 开关，在 **relay 传输**时去掉这些字段，把 812B 压到 ~400B。
- **风险**：需确认 APP 对缺字段容错（ArkTS 侧字段缺失可能展示成"未配置"）。
- **回滚**：关闭开关。

### 方案 D｜治本：修 hdc forward 的 768B 边界逻辑（上游，非本项目代码）

- 需要最小复现：单次向 fport 写入 819B → 对端 echo，观察边界处重复；抓 `hdc` 版本号。
- 动作：向 OpenHarmony hdc 提 issue / 升级 hdc 后回归。
- **短期不可依赖**，但应记录，否则每次换 hdc 版本都要重新验证。

### 方案 E｜bridge 侧坏帧修复（不推荐，仅降噪）

- `mqtt_bridge.js:808-810` catch 里尝试"在 762 之后删除重复段"再解析：**救不了 APP 显示**，只会让 `bridge.err.log` 干净。
- 不建议投入；保留监控计数即可。

---

## 4. 验证与回归清单（每个方案都要跑）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 9001 原始流抓包 5 分钟（复用 `lead\tools\analyze-badframes3.js`） | 坏帧 **0 / ≥300 帧**（当前 8.2%） |
| 2 | `bridge.err.log` 新增行数 | 0（基线：历史 60 行） |
| 3 | 板载 APP 随身求助 | "最近上报" ≤5s；`uitest dumpLayout` 含"随身求助设备 · 在线" |
| 4 | mirror 自身 | `linesSent` 递增、`disconnects=0`、`lastError=""` |
| 5 | 回归 | mirror `test\` 单测全过；bridge 测试**必须用离线端口**（禁止 1883/9101/9001） |
| 6 | 只读边界 | 验证期间不 publish 业务命令、不重启 bridge/supervisor |

抓包命令（只读，90–300 秒）：

```powershell
# 采集 9001 广播流（会临时占 1 个 homemon 客户端槽，采集完立即断开）
& D:\Node\node.exe -e "const net=require('net'),fs=require('fs');const s=net.connect(9001,'127.0.0.1',()=>console.error('connected'));const f=fs.createWriteStream('capture.bin');s.pipe(f);setTimeout(()=>{s.destroy();setTimeout(()=>process.exit(0),200)},180000)"
& D:\Node\node.exe <WORKSPACE>\competition\evidence\2026-10-28-fullchain-health\lead\tools\analyze-badframes3.js capture.bin
```

---

## 5. 实施顺序建议

### 演示前（现在～演示开始）：**不改**
- 影响面只有"板载 APP 的随身求助显示最坏晚 ≤5 秒"（5s 心跳自动覆盖），
  而任何方案都要重启 mirror（1–2s 注入空档）或改配置；**收益 << 风险**。
- 保持监控即可：`bridge.err.log` 行数增长速率 ≈ 1.16 条/分属已知基线，不是新增故障。

### 演示后 · 第 1 步（30 分钟，可回滚）：做方案 B
- 目的：**同时验证根因**（绕开 fport 后坏帧应归零）并立刻消除缺陷。
- 操作：改 `--relay-to 10.127.130.132:9000` → 重启 mirror → 跑 §4 的 1/2/3/4。
- 若坏帧归零 → 根因在 hdc fport 得到确证。

### 演示后 · 第 2 步（30 分钟）：做方案 A
- 在 B 验证过根因后，把 A 作为"将来仍需走 fport 时"的修复；A 有效则可以不做 B。
- A 的验证用同一套抓包脚本。

### 演示后 · 第 3 步：方案 C 作为长期防御
- 把"relay 行 ≤ 700B"写进 mirror 的约束：构建后断言 `Buffer.byteLength('relay '+line+'\n') <= 700`，超出则告警。
- 这条断言比任何方案都便宜，能防止将来新增字段又把帧撑过 768。

### 演示后 · 第 4 步：方案 D 提 issue
- 附上：hdc 版本、819B 单写复现、762 边界结论、四帧原始字节样本。

---

## 6. 复现/取证资产（已落盘）

| 文件 | 用途 |
|---|---|
| `transport\_tcp9001_raw2.bin`（180s）、`_tcp9001_raw.bin`（76s） | 含 4 个坏帧的原始流 |
| `lead\tools\analyze-badframes3.js` | 按设备基准统计坏帧率、插入长度 |
| `lead\tools\verify-dup-model3.js` | 重建真值帧 + LCP/LCS 对齐，输出 762 边界与重复段 |
| `lead\tools\analyze-badframes.js` / `analyze-badframes2.js` | 早期两版（保留过程） |

---

## 7. 需要你拍板的两件事

1. **演示后是否允许重启 mirror 做方案 B 的验证**（1–2 秒注入空档，可回滚）？
2. **板载 APP 是否依赖 sos 帧里的 `sensors/history/slots` 字段**？
   - 依赖 → 方案 C 放弃，只做 A/B/D；
   - 不依赖 → C 可把帧压到 ~400B，等于从根上远离 768 边界。
