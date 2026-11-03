#ifndef LOCAL_VOICE_H
#define LOCAL_VOICE_H
/* Nonblocking, bounded, local playback. No microphone, URL, or network access. */
void local_voice_start(void); /* call after I2C0 init, before sensor/network tasks */
void local_voice_alarm(const char *type);
void local_voice_cancel(void);
#endif
