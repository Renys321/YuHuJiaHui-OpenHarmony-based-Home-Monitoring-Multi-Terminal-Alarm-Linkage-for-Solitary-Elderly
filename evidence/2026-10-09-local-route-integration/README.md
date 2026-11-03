# 目标路由协议集成测试证据（2026-10-09）

## 测试环境

- **测试类型**：本地 socket 集成测试（非真机验证）
- **架构**：伪 homemon（软件模拟）+ 真实 mqtt_bridge + 真实 sim_node
- **端口配置**：
  - MQTT Broker: `127.0.0.1:1883`
  - homemon 模拟: `127.0.0.1:18830`
  - sim_node 监听: `127.0.0.1:19000`
  - bridge 无线节点监听: `127.0.0.1:19100`

## 测试结果（8 项全部通过）

1. **relay 收到 esp32-test 的真实状态 JSON** ✅  
   `state=NORMAL`

2. **拆包 route 被重组并下发，节点进入 ALARM 并回传真实 alarmId** ✅  
   `alarmId=sim-1791555116237-1`  
   验证了 `route` 命令跨 **4 个 TCP 分片**到达时的正确重组

3. **错误 alarmId ACK 后仍为 ALARM** ✅  
   `state=ALARM`

4. **正确 alarmId ACK 后为 ACKED** ✅  
   `state=ACKED`  
   节点状态正确转为 ACKED（本次为模拟节点 sim_node，非真实 homemon）

5. **重复 ACK 被节点拒绝且仍为 ACKED** ✅  
   `state=ACKED`

6. **route missing-device 被 bridge 拒绝且节点未收到** ✅  
   未知 deviceId 路由被正确拦截

7. **普通 JSON / 裸命令 / relay / routeXXX 行均未成为节点命令** ✅  
   `sim 命令数 4→4 state=ACKED`  
   验证了桥接只转发合法 `route` 行，其他格式均被过滤

8. **嵌套 route 被 bridge 拒绝** ✅  
   防注入机制生效

## 证据文件

| 文件 | 说明 | SHA-256 |
|------|------|---------|
| `bridge.log` | mqtt_bridge 运行日志 | `0c5e400aacff2ea1366e26efb14cd1fed975397e5cf2e0472a23659ddcc297f1` |
| `broker.log` | mqtt_broker 运行日志 | `d16fd72663fc630cb67eaf863b37b5b855c8fe3fee55b769c9a24b32fcbaeaa4` |
| `homemon.log` | homemon 模拟器日志 | `966db75eb7b73f0cc8692e18421b0a6f4f2766cb742762b620903e61da1f5cf7` |
| `sim.log` | sim_node 运行日志 | `74f1174a909fec8b9dfb529c50fc0d3abec1aa3e6d2401e069478494ad7ddddd` |
| `results.json` | 测试结果汇总（8 项断言） | `304225e91eb6a88d2c8561c49322c076e2fd8a1b1c93c29935447e2023799db0` |
| `status.json` | 测试结束时节点状态快照 | `14b1fa074e1a90fab987c28d0aa3fa6ae3b09e743932139e459cbf4f82563611` |

## 源文件版本（测试时使用）

| 文件 | SHA-256 |
|------|---------|
| `northbound/entry/src/main/ets/pages/Index.ets` | `990023566a1eb4e89e17e9508e09547acbaf11937ffe1a0f0d367971318ff82c` |
| `southbound/src/homemon.c` | `51ad008b7943862101c0fd344ad74f41cb03c2ca7064bba027e5b99bc0425e47` |
| `bridge/mqtt_bridge.js` | `247cc8af2360639a566a7f2f418df7ddc55135d252df81bf061741eae48c5705` |
| `bridge/sim_node.js` | `a7ffa42781a75e65a5da4606a3803c70bca086ab3230374adf1a9b0637c4cb2d` |
| `esp32-node/main/node_main.c` | `9fe9cd0b1c0735c65af524244851fb03fc14c0e24c89697ff2370559683a7a3f` |

## 二进制版本

| 文件 | 架构 | SHA-256 |
|------|------|---------|
| `southbound/out/homemon-arm` | ARM 32-bit | `8d5040f395571a0c1e4767354465a833d75ed86ad303c627a7cfd92e8071e7ac` |
| `southbound/out/homemon-arm64` | ARM 64-bit (AArch64) | `129d26c2db1067806075e77a52c1f178e5dddf51ea0dc76518d0e11a7179eb64` |

## 重要说明

1. **非真机测试**：本次测试使用软件模拟的 homemon，通过本地 socket 验证了桥接的路由逻辑和协议解析正确性。
2. **真机验证待完成**：需在 DAYU200 板子上运行真实 homemon，通过 `hdc fport` 转发后进行端到端验证。
3. **测试覆盖范围**：已验证拆包重组、设备路由、错误处理、安全过滤等核心功能。
