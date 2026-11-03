#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Add the climate-reason test to the bathroom tree's host test (kept in sync with the
public kitchen tree test) and print the command to build both host test binaries."""
import sys

P = r'D:\OpenHarmony\competition\esp32-node\.local\bathroom-voice-20261026\src\test\host_bathroom_logic_test.c'

FUNC = '''/* 语音文案必须对应真实触发原因（与公共树同一段纯逻辑）：
 * 温度/湿度/两者分别判定，无效读数不得猜原因。 */
static void test_climate_reason(void)
{
    const int TL = 5, TH = 45, RL = 10, RH = 90;
    CHECK(climate_reason_code(1, 20.0f, 60.0f, TL, TH, RL, RH) == CLIMATE_REASON_UNKNOWN, "reason normal -> unknown");
    CHECK(climate_reason_code(1, 50.0f, 60.0f, TL, TH, RL, RH) == CLIMATE_REASON_TEMP, "reason temp high -> temp");
    CHECK(climate_reason_code(1, 2.0f, 60.0f, TL, TH, RL, RH) == CLIMATE_REASON_TEMP, "reason temp low -> temp");
    CHECK(climate_reason_code(1, 20.0f, 95.0f, TL, TH, RL, RH) == CLIMATE_REASON_RH, "reason rh high -> rh");
    CHECK(climate_reason_code(1, 20.0f, 5.0f, TL, TH, RL, RH) == CLIMATE_REASON_RH, "reason rh low -> rh");
    CHECK(climate_reason_code(1, 50.0f, 95.0f, TL, TH, RL, RH) == CLIMATE_REASON_BOTH, "reason temp+rh -> both");
    CHECK(climate_reason_code(1, 2.0f, 5.0f, TL, TH, RL, RH) == CLIMATE_REASON_BOTH, "reason temp low+rh low -> both");
    CHECK(climate_reason_code(0, 50.0f, 95.0f, TL, TH, RL, RH) == CLIMATE_REASON_UNKNOWN, "reason invalid -> unknown");
}

int main(void)
{
    test_pir();'''

with open(P, 'r', encoding='utf-8') as f:
    t = f.read()
if 'test_climate_reason' in t:
    sys.exit('already patched')
old = 'int main(void)\n{\n    test_pir();'
if t.count(old) != 1:
    sys.exit('anchor count != 1: %d' % t.count(old))
t = t.replace(old, FUNC)
old2 = '    test_valid();\n    printf("PASS='
if t.count(old2) != 1:
    sys.exit('main tail anchor count != 1')
t = t.replace(old2, '    test_valid();\n    test_climate_reason();\n    printf("PASS=')
with open(P, 'w', encoding='utf-8', newline='\n') as f:
    f.write(t)
print('bathroom host test extended: test_climate_reason')
