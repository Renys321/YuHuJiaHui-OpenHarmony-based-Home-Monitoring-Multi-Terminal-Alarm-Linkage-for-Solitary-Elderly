# 褰掓。鍖呭惈/鎺掗櫎瑙勫垯涓庣瀵嗘壂鎻忕粨璁猴紙2026-10-24锛?
## 1. 鍖呭惈瑙勫垯

- 鍙敹褰曗€滄仮澶嶅綋鍓?P0 婕旂ず鍩虹嚎鈥濆繀闇€鐨勫彲鎵ц鍒跺搧銆佹渶灏忔簮鐮?鍙楁帶婧愮爜蹇収銆佹枃妗ｄ笌楠屾敹璇佹嵁銆?- 鎵€鏈夊鍒跺潎璁板綍婧愯矾寰勩€佺洰鏍囪矾寰勫拰 SHA-256锛涘鍒跺悗閫愪釜鏍￠獙婧?鐩爣鍝堝笇涓€鑷淬€?- 鏂囨湰鏂囦欢涓庝簩杩涘埗鏂囦欢鍒嗗紑澶勭悊锛涗簩杩涘埗锛圚AP銆乭omemon ELF锛夊彧鍝堝笇锛屼笉鍋氬唴瀹规壂鎻忋€?
## 2. 鏄庣‘鎺掗櫎椤逛笌鍘熷洜

| 鎺掗櫎瀵硅薄 | 鍘熷洜 |
|---|---|
| 浠讳綍 `node_modules/` | 绗笁鏂逛緷璧栵紝浣撶Н澶э紝鍙敱 `package-lock.json` 閲嶆柊瀹夎锛涗笉鍚紨绀哄繀闇€璇佹嵁 |
| `entry/.hvigor/`銆乣*.hvigor` 缂撳瓨銆乣build/`銆乣.test/` | 鏋勫缓缂撳瓨/涓棿浜х墿锛屽彲閲嶅缓锛涗笉淇濊瘉涓庢簮鐮佷竴鑷?|
| `oh_modules/`銆乣.idea/` | 渚濊禆缂撳瓨涓?IDE 鏈湴鐘舵€?|
| `APP/ElderlyCareGuardian/local.properties` | 鏈哄櫒鐩稿叧 SDK 璺緞锛屼笉灞炰簬鍙Щ妞嶅熀绾?|
| `competition/cloud/onenet/certs/onenet-mqtt-ca.pem` | OneNET CA 璇佷功锛涘綋鍓?public-sync 涓?backend-only锛屼笉浣跨敤 OneNET 浼犺緭锛屾棤闇€褰掓。 |
| `.env` / `*.env` | 鍙兘鍚湡瀹炵瀵嗭紱鏈浠藉彂鐜板嵆鎺掗櫎锛屼笖涓嶈鍙栧唴瀹?|
| AssetStore 瀵煎嚭銆乻ession/token/cookie 鏂囦欢銆乲eystore/jks/p12/pfx銆佺閽?| 鍑嵁/瀵嗛挜鏉愭枡锛岀姝㈠綊妗?|
| runtime `public-sync-supervisor.lock`銆乣*.state.json` | 杩愯鎬佷复鏃舵枃浠讹紙PID/蹇冭烦锛夛紱鏀圭敱 `CURRENT-RUNTIME-SNAPSHOT.md` 璁板綍鍙浜嬪疄 |
| 杩愯鏈熻秴澶ф棩蹇?`runtime/bridge.out.log`锛堢害 265鈥?54 KB锛夈€乣runtime/broker.out.log` | 浣庤瘉鎹瘑搴︺€佷綋绉ぇ锛泂upervisor 浜嬩欢鏃ュ織锛堝惈 worker stdout/stderr锛夊凡瓒充互璇佹槑鑷劧 202 |
| evidence 鐩綍涓殑閲嶅 HAP锛坄guardian-app-p0-sensors-candidate.hap`銆乣frozen-reference.hap`銆乮dentity diag HAP锛?| 涓庡綋鍓?鍥為€€涓や釜 canonical HAP 閲嶅锛岄伩鍏嶆仮澶嶆椂閫夐敊锛汬AP 鐢卞喕缁撴枃妗ｄ笌 manifest 鏄庣‘ |
| UI layout 澶?JSON锛坄runtime-*-layout-*.json`銆乣monitorpage-layout-*.json`锛屽崟鏂囦欢 80鈥?20 KB锛?| 浠呯敤浜庡綋鏃跺畾浣嶏紱宸蹭繚鐣欏搴旀枃鏈娊鍙栵紙FINAL-*.txt锛変笌缁撹鏂囨。 |
| 鏃у浠界洰褰?`2026-10-24-demo-backup/`銆乣*.zip` 鍘嗗彶鍖?| 鏈换鍔♀€滀笉瑕嗙洊鏃у浠解€濓紱鏃у寘淇濇寔鍘熸牱锛屼笉閲嶅褰掓。 |
| `competition/evidence/2026-10-24-app-refresh-diagnostic/app` 绛夎瘖鏂壇鏈?| 鍘嗗彶璇婃柇鏍戯紝闈炲綋鍓嶆仮澶嶅繀闇€ |
| 鏃犲叧澶ф枃浠讹紙`docs-master.zip`銆乣openharmony.rar`銆佸綍闊炽€丳PT銆乨ocx 绛夛級 | 涓庡綋鍓?P0 鎭㈠鏃犲叧 |

## 3. 闇€瑕佽鏄庣殑鈥滃凡瀹￠槄浣嗕笉鎺掗櫎鈥濇枃浠?
- APP 婧愮爜涓殑 `auth/TokenVault.ets`銆乣core/api/ApiClient.ts` 绛夋枃浠跺悕/鍐呭鍚?  `Token` / `Authorization` 绛?*鏍囪瘑绗?*锛屽畠浠槸鏋勫缓涓庢仮澶嶅繀闇€鐨勬簮鐮侊紝涓嶅惈鐪熷疄绉樺瘑鍊硷紱
  绉樺瘑鎵弿鎸夆€滃€肩骇妯″紡鈥濆垽瀹氾紝鏈懡涓湡瀹炲嚟鎹紝鏁呬繚鐣欍€?- `cloud/onenet/*.test.js`銆乣materials/verify-supervisor-acceptance.ps1` 绛夋祴璇?楠屾敹鑴氭湰
  鍚?`INGEST_KEY`銆乣Authorization` 绛?*瀛楁鍚嶆垨妫€鏌ラ€昏緫**锛屽悓鏍蜂笉鍚湡瀹炲€笺€?
## 4. 绉樺瘑鎵弿鏂规硶锛堜笉杈撳嚭鍖归厤鍊硷級

鎵弿浠呴拡瀵瑰綊妗ｉ泦鍚堜腑鐨?*鏂囨湰鏂囦欢**锛屾寜浠ヤ笅鈥滃€肩骇鈥濇ā寮忔鏌ワ紝杈撳嚭浠呬负
`鏂囦欢璺緞 | 鍛戒腑绫诲瀷 | 鏄惁鎺掗櫎`锛?
```text
INGEST_KEY / BACKEND_INGEST_KEY 璧嬪€肩粰闀垮瓧闈㈤噺
Authorization: Bearer <闀?token> 瀛楅潰閲?Cookie: <闀垮€?
sessionToken/AppSecret/Wi-Fi password/绉侀挜 璧嬪€间负闀垮瓧闈㈤噺
-----BEGIN ... PRIVATE KEY-----
.env / AssetStore / keystore / p12 / pfx / 绉侀挜鏂囦欢
```

浜岃繘鍒?HAP銆乭omemon 涓嶅弬涓庢枃鏈壂鎻忥紙宸插崟鐙搱甯屽苟鏍稿锛夈€?
## 5. 鎵弿缁撹

鎵弿缁撴灉瑙?`BACKUP-VERIFICATION.md`锛堝湪 ZIP 鐢熸垚鍚庡畬鎴愭渶缁堟壂鎻忥級銆?
```text
鏈彂鐜扮湡瀹炵瀵嗗€艰繘鍏ュ綊妗ｉ泦鍚堛€?鏈彂鐜伴渶瑕佸洜绉樺瘑鍘熷洜鎺掗櫎鐨勫凡閫夋枃浠躲€?```

## 6. 复核中新增的排除项与说明（2026-10-25 00:0x）

1. 秘密扫描在 `cloud/onenet/adapter.test.js` 与 `cloud/onenet/command-sync.test.js`
   命中“值级”测试夹具模式（Wi-Fi password 字面量 / INGEST_KEY 赋值）。
   为严格遵守“命中即从归档集合排除”，这两个测试文件已从源码快照中移除；
   未读取或输出其匹配值；其余测试文件保留。
2. 旧入口 `demo_recover.ps1` 为 **UTF-8 无 BOM**：作为 UTF-8 解析 0 错误；
   但用 Windows PowerShell 5.1 的 `-File` 运行可能因 ANSI 解码误判中文注释。
   该文件仅作为旧链路回退参考保留，不是当前推荐入口；
   当前正式入口 `start-demo-supervisor.ps1` 为 UTF-8 with BOM，已通过解析检查。
3. 历史文档（交付索引/版本清单/启动清单）保留原文，其指向更早历史文档的相对链接
   中，约 19 个目标不属于本 P0 归档范围（COM8/bath/valid/homemon 历史证据）。
   这些链接在归档内不可解析属于“按设计的 NOT INCLUDED”，详见 BACKUP-VERIFICATION.md。
