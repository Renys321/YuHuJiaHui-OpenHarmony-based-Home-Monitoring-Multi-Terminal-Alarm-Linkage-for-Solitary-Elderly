#include <stdio.h>
#include <string.h>
#include "notice_logic.h"

static int fails, passes;
#define CHECK(c, n) do { if (c) passes++; else { fails++; printf("FAIL: %s (line %d)\n", n, __LINE__); } } while (0)

int main(void)
{
    notice_state_t st;
    notice_reset(&st);

    CHECK(notice_begin(&st, "e-1-1", "esp32-sos", 0) == NOTICE_BEGIN_PLAY, "first notice plays");
    CHECK(strcmp(st.active_id, "e-1-1") == 0, "active id stored");
    CHECK(strcmp(st.source, "esp32-sos") == 0, "source stored");
    CHECK(notice_begin(&st, "e-1-1", "esp32-sos", 0) == NOTICE_BEGIN_DUP_ACTIVE, "duplicate active ignored");

    CHECK(notice_end(&st, "e-wrong") == NOTICE_END_NO_MATCH, "wrong id does not stop");
    CHECK(notice_end(&st, "e-1-1") == NOTICE_END_STOPPED, "correct id stops");
    CHECK(st.active_id[0] == '\0' && strcmp(st.last_id, "e-1-1") == 0, "stopped id remembered");
    CHECK(notice_begin(&st, "e-1-1", "esp32-sos", 0) == NOTICE_BEGIN_DUP_DONE, "played id never replays");

    CHECK(notice_begin(&st, "e-2-1", "esp32-sos", 1) == NOTICE_BEGIN_LOCAL_ALARM, "local alarm wins");
    CHECK(st.active_id[0] == '\0', "local alarm does not set active");

    CHECK(notice_begin(&st, "bad id", "esp32-sos", 0) == NOTICE_BEGIN_BAD_ID, "space rejected");
    CHECK(notice_begin(&st, "e-3-1", "bad source!", 0) == NOTICE_BEGIN_BAD_ID, "bad source rejected");
    CHECK(notice_begin(&st, "", "esp32-sos", 0) == NOTICE_BEGIN_NO_ID, "empty id rejected");

    CHECK(notice_begin(&st, "e-3-1", "esp32-sos", 0) == NOTICE_BEGIN_PLAY, "second notice plays");
    CHECK(notice_yield(&st) == 1, "yield interrupts active notice");
    CHECK(st.active_id[0] == '\0' && strcmp(st.last_id, "e-3-1") == 0, "yielded id marked done");
    CHECK(notice_begin(&st, "e-3-1", "esp32-sos", 0) == NOTICE_BEGIN_DUP_DONE, "yielded id never replays");
    CHECK(notice_yield(&st) == 0, "yield with nothing active is no-op");

    printf("PASS=%d FAIL=%d\n", passes, fails);
    return fails ? 1 : 0;
}
