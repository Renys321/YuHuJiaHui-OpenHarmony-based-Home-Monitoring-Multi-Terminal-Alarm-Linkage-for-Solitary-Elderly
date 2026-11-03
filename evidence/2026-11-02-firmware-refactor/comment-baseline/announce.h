#ifndef ANNOUNCE_H
#define ANNOUNCE_H

/* 告警声音编排：先短提示音，再完整语音，两者不重叠 */
void announce_start(int clip);
void announce_cancel(void);
void announce_tick(void);   /* 主循环每 100 ms 调一次，到点才翻转蜂鸣器/起语音 */

#endif /* ANNOUNCE_H */
