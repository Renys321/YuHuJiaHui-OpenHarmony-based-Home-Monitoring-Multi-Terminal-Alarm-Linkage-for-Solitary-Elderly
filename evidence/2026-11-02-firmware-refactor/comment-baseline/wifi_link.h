#ifndef WIFI_LINK_H
#define WIFI_LINK_H

#include <stdbool.h>

void wifi_start(void);
bool wifi_connected(void);
void wifi_time_sync_start(void);   /* 轮询式 SNTP，是否同步成功由主循环看系统时间 */

#endif /* WIFI_LINK_H */
