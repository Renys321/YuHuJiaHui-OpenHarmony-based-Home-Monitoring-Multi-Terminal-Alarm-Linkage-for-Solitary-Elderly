#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "climate_valid.h"

static void check_sample(float t, float r, int expected)
{
    assert(climate_reading_valid(t, r) == expected);
}

int main(void)
{
    climate_sample_t s = { 0.0f, 0.0f, 0 };

    /* 初始化尚未读取：0/0 也不是有效值 */
    climate_apply_sample(&s, -1, 0.0f, 0.0f);
    assert(s.valid == 0);

    /* 本次读取成功：数值更新且 valid=true */
    climate_apply_sample(&s, 0, 24.5f, 55.0f);
    assert(s.valid == 1);
    assert(s.temp_c == 24.5f);
    assert(s.rh == 55.0f);

    /* 成功后下一次读取失败：必须清掉 valid，保留历史数值供“上次读数” */
    climate_apply_sample(&s, -1, 0.0f, 0.0f);
    assert(s.valid == 0);
    assert(s.temp_c == 24.5f);
    assert(s.rh == 55.0f);

    /* 合法零值：读取成功时 0/0 可以是有效读数 */
    climate_apply_sample(&s, 0, 0.0f, 0.0f);
    assert(s.valid == 1);
    assert(s.temp_c == 0.0f);
    assert(s.rh == 0.0f);

    /* 非有限数和越界值不能通过 */
    check_sample(NAN, 50.0f, 0);
    check_sample(INFINITY, 50.0f, 0);
    check_sample(24.0f, -INFINITY, 0);
    check_sample(125.1f, 50.0f, 0);
    check_sample(-40.1f, 50.0f, 0);
    check_sample(24.0f, 100.1f, 0);
    check_sample(24.0f, -0.1f, 0);

    /* SHT30 可表达范围的边界合法 */
    check_sample(-40.0f, 0.0f, 1);
    check_sample(125.0f, 100.0f, 1);

    /* 读取成功但数值非法：不覆盖旧值，仍 valid=false */
    climate_sample_t bad = { 24.0f, 50.0f, 1 };
    climate_apply_sample(&bad, 0, 999.0f, 50.0f);
    assert(bad.valid == 0);
    assert(bad.temp_c == 24.0f);
    assert(bad.rh == 50.0f);

    printf("climate_valid_test: PASS\n");
    return 0;
}
