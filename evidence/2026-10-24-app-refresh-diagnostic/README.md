# APP refresh diagnostic build (2026-10-24)

## Diagnostic HAP

```text
path: <WORKSPACE>\competition\evidence\2026-10-24-app-refresh-diagnostic\guardian-app-refresh-diag-unsigned.hap
size: 2,102,896 B
sha256: 0A2AD6643EB41250E23C718A8E740E239D9227A32A8B38D455CFA1BB73D20F18
bundle: com.example.program_04
build: hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
build_exit: 0
signed: NO (project has no signingConfigs)
installed: NO
```

## Baseline/Source

Diagnostic copy constructed from:

```text
<WORKSPACE>\competition\evidence\2026-10-24-demo-backup\source\app-entry\main
```

It intentionally does **not** include APP-P0-Sensors changes (DevicePage baseline hash `4BBF75F2…C71765F`). It only adds removable diagnostic logging.

Current APP-P0-Sensors candidate `F91852…` remains separate and is not installed.

## Instrumentation

Source copy:

```text
<WORKSPACE>\competition\evidence\2026-10-24-app-refresh-diagnostic\app
```

Added `core/diag/DiagTrace.ets` and diagnostic calls in:

- `net/HarmonyHttpTransport.ets`
- `service/GuardianService.ets`
- `pages/MonitorPage.ets`
- `pages/Index.ets` / `HomePage.ets` / `DevicePage.ets` origin labels

Logs contain only:

- refreshId / PID / pageId / origin
- HTTP method, path, origin, status, elapsed, cache=false
- single-flight NEW/REUSED
- DTO / mapDevices / AppStorage before-after white-listed sensor fields
- `lastUpdatedAt` milliseconds
- toast event

No password, sessionToken, Authorization, Cookie, INGEST_KEY, full API response or complete device object is logged.

## Logs

Build log: `build.log`

The diagnostic HAP is **not** a release/candidate and must not replace `8A722…`.
