# Device Identity Diagnostic Build（2026-10-24）

## HAP

```text
path:
<WORKSPACE>\competition\evidence\2026-10-24-app-device-identity-diag\
guardian-app-device-identity-diag-unsigned.hap

size=2,127,873 B
sha256=42F8CE61754E06BBFE5B7BA2D1E50202CDF07E975D6CA89B476EDE08C52B646F
bundle=com.example.program_04
signed=NO
installed=NO
```

## Baseline

Built from the 8A722 baseline source copy:

```text
<WORKSPACE>\competition\evidence\2026-10-24-demo-backup\source\app-entry\main
```

No APP-P0-Sensors business changes; only diagnostic logging.

## Tests

```text
hvigorw test --mode module -p product=default -p module=entry@default --no-daemon
test_exit=0
Tests run: 6, Failure: 0, Error: 0, Pass: 6, Ignore: 0
```

Identity fixture uses five synthetic devices (living/kitchen/bath/two offline), no real Token or production response.

## Build

```text
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
build_exit=0
BUILD SUCCESSFUL
```

## Diff vs 8A722

Diagnostic-only additions/changes:

- new `core/diag/IdentityTrace.ts`
- `core/api/ApiClient.ts` — raw response device whitelist
- `core/api/Contracts.ts` — DTO after parse
- `service/GuardianService.ets` — mapped DeviceView / SensorView / AppStorage audit
- `pages/MonitorPage.ets` — pageId, activeKind, allSensors, filtered, ForEach key
- existing `DiagTrace`/refresh observability from previous diagnostic build
- test replacement: `DeviceIdentity.test.ets`, `List.test.ets`; old P0 test not included in this baseline copy

## Install gate

Not installed. Installation would restart APP and destroy PID 3436's current UI/session memory. If the anomaly does not reproduce after install:

```text
PRIOR_IDENTITY_MISMATCH_NOT_REPRODUCED_AFTER_INSTALL
```

and must not be called a fix.
