# 回滚说明（2026-10-28 task-8 改动）

本任务只改 `competition/materials/**` 与本 evidence 目录；**未改** bridge/onenet/wearable-mirror 源码、
DAYU homemon 二进制、APP/HAP、后端。所有被改脚本都有 `.bak-20261028` 备份；PS1 必须保持 **UTF-8 BOM**。

## 1. 脚本回滚（推荐，最小影响）

| 改动文件 | 备份 | 回滚命令（PowerShell） |
|---|---|---|
| `materials/start-demo-supervisor.ps1` | `start-demo-supervisor.ps1.bak-20261028` | `Copy-Item ...\start-demo-supervisor.ps1.bak-20261028 ...\start-demo-supervisor.ps1 -Force` |
| `materials/start-demo-supervisor.cmd` | `start-demo-supervisor.cmd.bak-20261028` | `Copy-Item ...\start-demo-supervisor.cmd.bak-20261028 ...\start-demo-supervisor.cmd -Force` |
| `materials/README.md` | `README.md.bak-20261028` | `Copy-Item ...\README.md.bak-20261028 ...\README.md -Force` |
| `materials/resolve-dayu-lan-ip.ps1` | 新文件（无旧版） | `Remove-Item ...\resolve-dayu-lan-ip.ps1`（删除前确认没有别的启动路径引用它） |
| `materials/start-mirror-dayu.ps1` | 新文件（无旧版） | `Remove-Item ...\start-mirror-dayu.ps1` |

回滚后校验（必须做）：

```powershell
$files=@('<WORKSPACE>\competition\materials\start-demo-supervisor.ps1','<WORKSPACE>\competition\materials\public-sync-health.ps1')
foreach($f in $files){
  $b=[System.IO.File]::ReadAllBytes($f)
  $e=$null;$t=$null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e)
  "{0} BOM={1} parse={2}" -f $f,($b[0] -eq 239),$(if($e.Count -eq 0){'OK'}else{$e[0].Message})
}
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\materials\start-demo-supervisor.ps1 -Preflight
```

`$HomemonSha` 只有 Lead 在替换 homemon 新二进制时才会改；**回滚脚本不得把 `$HomemonSha` 回退到旧值**
（旧值 `f6f4497c…` 对应 MAX_CLIENTS=4 的旧二进制；新二进制上线后回退脚本会导致预检拒绝）。

## 2. 启动入口行为回滚（不换文件时）

- 如果只是不想让 `.cmd` 自动解析端点：运行时显式传参即可覆盖，例如
  `start-demo-supervisor.ps1 -StatusTcp 10.127.130.131:9000 -RelayTo 10.127.130.131:9000`
  （显式参数优先于 `-AutoDayuEndpoint`）。
- mirror 封装脚本默认 dry-run，不启动任何进程；不使用它不影响现网。

## 3. 运行态回滚（仅当本轮验收启动了进程/建立了 fport）

> 本任务自身**没有**启停任何运行态进程（运行态变化均由用户/Lead 执行，见 README §1/§8）。以下供需要回滚时使用。

1. **watcher**：在其窗口按 `Q` 只退出 watcher（P0/APP/推理保留）；或校验命令行含 `demo-autostart.ps1` 后
   `Stop-Process -Id <watcher PID>`。不要按历史 PID 杀。
2. **fport**：若验收中由 watcher/P0 入口新建了 `tcp:9001 -> tcp:9000`，回滚时
   `hdc fport rm tcp:9001`（确认没有 bridge/mirror 正在使用 fport 拓扑再删）。
3. **bridge**：只停本轮新建的 bridge PID，按阶段 A 记录的旧命令行（含旧端点）重启；
   不要动 broker/supervisor/worker。
4. **P0 supervisor/worker**：只有 Lead 批准才停；恢复用 `start-demo-supervisor.cmd` 并在可见窗口输入 INGEST_KEY。
5. **mirror**：用其自带 `scripts\stop-mirror.ps1` 停止，再按阶段 A 记录的旧 `--relay-to` 参数重启；
   不要把 mirror 指向旧 IP 长期运行（那等于恢复已知断链）。
6. **DAYU homemon**：本任务不改二进制、不做无授权重启；若需回退 Lead 部署的新二进制：
   - 新（当前）：sha256 `A5F355C2D5E9F4E7330282F1856411927EB54AD743B5ACB7C599BE7C2D6ED9EA`，177,872 B；
   - 回退备份：`/data/homemon/homemon.rollback-20261028-0045`（f6f4497c…，MAX_CLIENTS=4）
     与 `/data/homemon/homemon.rollback-20261028-2257`（0d2435…）；
   - 恢复步骤：先停 homemon → 备份当前 → 覆盖为新二进制 → 重启 → **同步 `start-demo-supervisor.ps1` 的 `$HomemonSha`**
     （否则 P0 预检会拒绝继续）。不要只看大小，必须比 sha256。
7. **DAYU APP（HAP）**：当前安装 1.0.10 signed = `evidence/2026-10-27-video-fps/dayu-video-fps-1.0.10-signed.hap`
   （1,385,966 B，`B5EC606E428A40B6005F552276000EE2CDEA79A3E91DB4612DCB874406F2B714`）。
   1.0.8 / 1.0.6 / 1.0.5 / 1.0.0 回退包与哈希见 `northbound/RELEASE.md` 回滚表；
   安装/回滚用 `hdc install -r <hap>`，安装后 `bm dump -n com.dsh.eldercare | grep versionName` 复核。
   `materials/demo_start.ps1` 等三处已改指 1.0.10（带 SHA-256 校验），不会再默认装回 1.0.0。

## 3.1 BOM / PS5.1 硬规则（回滚后同样必须遵守）

任何 `.ps1` 恢复/改写后，必须：首 3 字节 `EF BB BF`（UTF-8 BOM）+ **Windows PowerShell 5.1** AST
`Parser::ParseFile` 全绿，才允许继续使用；否则 watcher 拉起的 P0 窗口会解析失败退出（已实际发生，见 README §9）。
回滚后请把 BOM/解析结果追加到本目录 `logs/`。

## 4. 证据与数据保留

- **不删除**任何历史告警、证据目录、`logs/`、`.bak-*`；回滚只回滚脚本/运行态，不回滚证据。
- 回滚后跑一次 `public-sync-health.ps1` 与 `verify-p0-health.ps1`，把结果追加到本目录 `logs/`。

## 5. 本轮未触碰（无需回滚）

- `demo-autostart.ps1`（保持 22:41 修复版；watcher 通过 .cmd 自动获得 `-AutoDayuEndpoint`）
- `public-sync-health.ps1`、`verify-p0-health.ps1`
- `bridge/**`、`cloud/onenet/**`、`cloud/wearable-mirror/**`、`southbound/**`、`northbound/**`、`APP/**`
- DAYU homemon 二进制与配置、任何 HAP 安装
- 任何凭据/INGEST_KEY/历史告警
