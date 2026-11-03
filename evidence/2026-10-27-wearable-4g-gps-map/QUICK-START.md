# 演示当天速查（一页纸）

## 上电（2 分钟）

1. **M100**：DC 5~12V 插底板 DC 座；4G 天线、GPS 天线接好；**底板 USB 数据线不插**。
2. **ESP32**：充电宝 USB 供电（或电脑 USB，仅调试时）。
3. 等 M100 **NET 灯约 1000ms 慢闪 + RDY 常亮**（联网成功，约 20~30 s）。
4. 打开手机/模拟器 APP（账号 `luxunluxunluxun`）。

## 演示动作

```
按随身按钮
 → 蜂鸣器 3 短声
 → APP 首页出现「随身求助」告警（约 5~10 s）
 → 点开告警详情：APP 内地图显示位置/坐标/定位状态
 → 点「确认」
 → 5~15 s 内蜂鸣器停止，APP 变「设备已确认」
 → 再按一次按钮 → 产生新的告警（新 alarmId）
```

## 出问题先看这里

| 现象 | 检查 |
|---|---|
| 按键不响 | ESP32 供电？按钮 GPIO4↔GND、蜂鸣器 GPIO5/VCC3.3/GND |
| 蜂鸣但不进 APP | M100 NET 灯是否 1000ms 慢闪？M100 底板 USB 是否误插？（必须拔） |
| APP 无告警 | 终端：服务器上 `docker ps \| grep wearable-mqtt` 是否 healthy |
| APP 点确认后设备不停 | 等 1 分钟；若仍不停，服务器执行 `docker restart $(docker ps -qf name=wearable-mqtt)`，会重新投递 PENDING 的 ACK |
| APP 地图空白 | 网络/瓦片问题；仍可看经纬度文字并 ACK，不影响验收 |
| 键盘/APP 打不开 | 模拟器是否还活着（`hdc list targets`）；重启 DevEco 模拟器，APP 数据不丢 |

## 不要做

- 不要插 M100 底板 USB（会顶掉 ESP32 串口上行）。
- 不要启动旧的 `cloud/onenet/public-sync` / `gateway`（会抢 ACK 命令）。
- 不要改 M100 参数源（`paramsrc` 必须为 1，否则重启会被云平台覆盖配置）。
- 不要用 GPIO6 接蜂鸣器（Flash 脚）。

## 服务器一条命令体检

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep wearable-mqtt
docker exec $(docker ps -qf name=wearable-mqtt) node -e "fetch('http://127.0.0.1:8099/healthz').then(r=>r.json()).then(j=>console.log(j))"
```
