# APP 鍥為€€璇存槑锛?026-10-24锛?
## 1. 涓や釜鍖?
```text
褰撳墠姝ｅ紡鎺ㄨ崘鍖咃紙鏈疆 REAL PASS锛屽凡瀹夎 127.0.0.1:5555锛夛細
  guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap
  size=2,086,949 B
  sha256=9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A
  bundle=com.example.program_04锛寁ersionName=1.0.0锛寁ersionCode=1000000

鍥為€€鍖咃紙鍐荤粨鍩虹嚎锛屼繚鐣欙級锛?  guardian-inline-summary-formal.hap
  size=2,077,912 B
  sha256=8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
  bundle=com.example.program_04
```

涓や釜鍖呭潎鍦ㄦ湰澶囦唤 `artifacts/` 涓嬨€?
## 2. 浣曟椂鍥為€€

鍙湁浠ヤ笅鎯呭喌鎵嶅洖閫€锛?
1. 褰撳墠鍖呭畨瑁呭け璐ユ垨瀹夎鍚?APP 鏃犳硶鍚姩/鐧诲綍锛?2. 鍏抽敭椤甸潰锛堝湪绾挎暟銆丮Q銆丳IR銆丏evicePage銆佽嚜鍔ㄥ埛鏂般€佺绾挎仮澶嶏級鐪熷疄楠屾敹澶辫触锛?3. 鍑虹幇鏃犳硶鍦ㄦ湰杞唴瀹氫綅鐨勫洖褰掋€?
**涓嶈**鍥犱负鈥滄兂鍥炲埌鏃х増鏈€濊€屼富鍔ㄥ洖閫€锛涘洖閫€蹇呴』璁板綍鍘熷洜涓庤瘉鎹€?
## 3. 鍥為€€姝ラ锛堜繚鐣欑敤鎴锋暟鎹級

```powershell
hdc -t 127.0.0.1:5555 install -r ../artifacts/guardian-inline-summary-formal.hap
```

- 浣跨敤 `install -r`锛?*涓嶅嵏杞姐€佷笉娓呮暟鎹€佷笉鎭㈠鍑哄巶**銆?- 鍥為€€鍓嶅厛淇濆瓨澶辫触璇佹嵁锛氭埅鍥?椤甸潰鏂囨湰銆丄PP PID銆佹椂闂淬€佸彂鐢熼〉闈€佺浉鍏虫棩蹇椼€?- 鍥為€€鍚庨噸鏂版墦寮€ APP锛岀‘璁よ兘鍚姩涓庣櫥褰曪紝鍐嶈褰曗€滃凡鍥為€€鍒?8A722鈥濄€?
## 4. 鎶ュ憡绾緥

- 涓嶅緱鎶婂洖閫€鎴愬姛鍐欐垚鈥滃綋鍓嶆柊鐗堟湰閫氳繃鈥濄€?- 涓嶅緱鎶?8A722 鐨勫凡鐭ョ己鍙ｅ啓鎴愬凡淇銆?- 鍥為€€鍚庡闇€缁х画淇锛屽簲浣滀负鏂颁换鍔￠噸鏂伴獙鏀讹紱鏈浠界殑鍐荤粨缁撹浠嶄互 2026-10-24 鐨勮褰曚负鍑嗐€?
## 5. 鐢佃剳閾捐矾鍥為€€

鑻ラ棶棰樺湪鐢佃剳渚ц€岄潪 APP锛?
- 涓嶈鍥為€€ APP锛?- 鏃у叆鍙?`../artifacts/legacy/start-demo-current.cmd` + `demo_recover.ps1` 淇濈暀涓哄洖閫€璺緞锛?- 浣嗘寮忔帹鑽愪粛鏄?supervisor 涓€閿叆鍙ｏ紙`start-demo-supervisor.cmd`锛夈€?- 鍥為€€/鍒囨崲鍓嶅厛璁板綍褰撳墠 supervisor/worker PID 涓?lock/state锛岄伩鍏嶅嚭鐜板弻瀹炰緥銆?
## 6. 鏈换鍔′簨瀹?
鏈疆 P0-C 褰掓。**娌℃湁鍙戠敓鍥為€€**锛氬綋鍓?APP 浠嶆槸 9EEBEE鈥?鍖咃紝8A722 鍖呬粎浣滀负鍥為€€淇濈暀銆?
