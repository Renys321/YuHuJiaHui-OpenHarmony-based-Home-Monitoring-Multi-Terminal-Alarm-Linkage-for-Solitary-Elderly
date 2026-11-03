本目录 = 验收过程中的中间版 report（同一批证据的迭代快照），保留作为审计轨迹；**结论以 ../verify-*-FINAL.md/.json 为准**。

迭代原因：
1. 003458/003515：部署后仅有无 counters 的 /status 摘录 → C0 PASS、其余 BLOCKED；
2. 003908-FAIL：**该次 FAIL 是判据引擎缺陷**——把“用户摘录里没有 adapter.counters”误判成“counters.commandResultOk 未增长”，
   于是 C5 误报“代报嫌疑”。已修复为区分“摘录缺 counters（BLOCKED）”与“有 counters 但不增长（FAIL）”，并复算；
   该次 FAIL **不代表验收失败**，也不代表真的出现代报；
3. 003928/004156：补 C1/C2 markers 后，C2 转 PASS，C1/C5 仍缺 counters → BLOCKED；
4. 005237-FINAL：收到用户完整 status-final.json + logs-final.txt 后的第一版 FINAL（计数器字段映射仍缺 commandsParked/ackReceipts，已补）；
5. 005321-FINAL（当前有效）：字段映射修正后的最终版，6 PASS + 1 BLOCKED（C4 已裁决）。

每一步的 PASS/FAIL/BLOCKED 都只基于当时已存在的真实证据；没有任何一项被手工改成 PASS。
