/* 板载 IO：XL9555 扩展器、蜂鸣器、KEY0/KEY1，以及几路数字输入的方向配置。
 *
 * DNESP32S3 板子的蜂鸣器和两颗按键都不在 ESP32 的 GPIO 上，而是挂在 I2C0
 * (IO41/IO42) 的 XL9555@0x20 上：
 *   P0_2 = 功放使能（local_voice.c 管）
 *   P0_3 = 蜂鸣器，低电平响
 *   P1_6 = KEY1，低电平按下（语音提问）
 *   P1_7 = KEY0，低电平按下（SOS）
 * 这些访问都在主任务里串行做，语音播放任务只碰 I2S，不需要额外互斥。
 */
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_log.h"

#include "board_io.h"
#include "node_common.h"
#include "alarm_logic.h"
#if CONFIG_NODE_VOICE_ENABLED
#include "mic_link.h"
#endif

#define I2C_XL_PORT              I2C_NUM_0
#define XL9555_SDA_GPIO          41
#define XL9555_SCL_GPIO          42
#define XL9555_ADDR              0x20
#define XL9555_OUTPUT_PORT0_REG  2
#define XL9555_CONFIG_PORT0_REG  6
#define XL9555_CONFIG_PORT1_REG  7
#define XL9555_INPUT_PORTS_REG   0   /* 从 P0 起连续读，P1 紧跟其后 */
#define XL9555_BEEP_P0_BIT       0x08

esp_err_t board_xl9555_read(uint8_t reg, uint8_t *value)
{
    return i2c_master_write_read_device(I2C_XL_PORT, XL9555_ADDR, &reg, 1, value, 1, pdMS_TO_TICKS(100));
}

esp_err_t board_xl9555_write(uint8_t reg, uint8_t value)
{
    uint8_t buf[2] = { reg, value };
    return i2c_master_write_to_device(I2C_XL_PORT, XL9555_ADDR, buf, 2, pdMS_TO_TICKS(100));
}

esp_err_t board_xl9555_read_ports(uint8_t out[2])
{
    uint8_t reg = XL9555_INPUT_PORTS_REG;
    return i2c_master_write_read_device(I2C_XL_PORT, XL9555_ADDR, &reg, 1, out, 2, pdMS_TO_TICKS(50));
}

#if CONFIG_NODE_BUZZER_XL9555
static void beep_init(void)
{
    uint8_t cfg = 0, out = 0;
    if (board_xl9555_read(XL9555_CONFIG_PORT0_REG, &cfg) != ESP_OK) {
        ESP_LOGW(TAG, "XL9555 不可用（板载蜂鸣器未启用）");
        return;
    }
    if (board_xl9555_write(XL9555_CONFIG_PORT0_REG, (uint8_t)(cfg & ~XL9555_BEEP_P0_BIT)) != ESP_OK) {
        ESP_LOGW(TAG, "XL9555 配置 P0_3 为输出失败");
        return;
    }
    if (board_xl9555_read(XL9555_OUTPUT_PORT0_REG, &out) != ESP_OK) out = 0xFF;
    /* P0_3 低电平有效（实测 0 时长响），上电先写 1 保持静音 */
    board_xl9555_write(XL9555_OUTPUT_PORT0_REG, (uint8_t)(out | XL9555_BEEP_P0_BIT));
    ESP_LOGI(TAG, "板载蜂鸣器就绪（XL9555 P0_3）");
}
#endif

#if CONFIG_NODE_SOS_KEY0_ENABLED
static int s_key0_last_raw = -1;   /* 上次成功读到的电平；-1 表示还没读到过 */
static int s_key0_read_fail = 0;   /* 连续失败次数，只用来限流日志 */

static void key0_init(void)
{
    uint8_t cfg[2] = { 0, 0 };
    if (board_xl9555_read(XL9555_CONFIG_PORT0_REG, &cfg[0]) != ESP_OK ||
        board_xl9555_read(XL9555_CONFIG_PORT1_REG, &cfg[1]) != ESP_OK) {
        ESP_LOGW(TAG, "SOS 按键：XL9555 不可用，KEY0 求助入口本次不可用（采集/蜂鸣/语音不受影响）");
        return;
    }
    if ((cfg[1] & SOS_KEY0_P1_BIT) == 0) {
        /* 只改 P1 的方向寄存器，别动输出锁存（P0 上还有蜂鸣器和功放使能） */
        if (board_xl9555_write(XL9555_CONFIG_PORT1_REG, (uint8_t)(cfg[1] | SOS_KEY0_P1_BIT)) == ESP_OK)
            ESP_LOGW(TAG, "SOS 按键：KEY0(P1_7) 原为输出，已改为输入");
        else {
            ESP_LOGW(TAG, "SOS 按键：KEY0(P1_7) 设为输入失败，求助按键不可用");
            return;
        }
    }
    uint8_t in[2] = { 0, 0 };
    if (board_xl9555_read_ports(in) != ESP_OK) {
        ESP_LOGW(TAG, "SOS 按键：读取 KEY0 基线失败（下次轮询重试，不触发求助）");
        return;
    }
    int baseline = ((in[1] & SOS_KEY0_P1_BIT) == 0) ? 1 : 0;
    ESP_LOGI(TAG, "SOS 按键就绪：板载 KEY0 = XL9555 P1_7（低电平按下，输入方向），"
                  "上电基线=%s，P1=0x%02X；需先见到松开才允许触发",
             baseline ? "按下" : "松开", in[1]);
}

int board_key0_poll(void)
{
    uint8_t in[2] = { 0, 0 };
    int read_ok = (board_xl9555_read_ports(in) == ESP_OK);
    int key0 = sos_key0_pressed(read_ok, in[1]);
    if (key0 < 0) {
        /* I2C 失败不能当成按下，也不能当成松开：返回 -1 让上层两条路都不走 */
        if (s_key0_read_fail < 3) {
            s_key0_read_fail++;
            ESP_LOGW(TAG, "KEY0 读取失败：本次不触发也不解除（求助按键暂不可用）");
        }
        return -1;
    }
    s_key0_read_fail = 0;
    if (key0 != s_key0_last_raw) {
        s_key0_last_raw = key0;
        ESP_LOGI(TAG, "KEY0 原始电平变化：%s（XL9555 P1=0x%02X）",
                 key0 ? "按下(低)" : "松开(高)", in[1]);
    }
    return key0;
}
#endif /* CONFIG_NODE_SOS_KEY0_ENABLED */

void board_i2c_start(void)
{
#if CONFIG_NODE_BUZZER_XL9555 || CONFIG_NODE_SOS_KEY0_ENABLED || CONFIG_NODE_VOICE_ENABLED
    i2c_config_t cfg = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = XL9555_SDA_GPIO,
        .scl_io_num = XL9555_SCL_GPIO,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
        .clk_flags = 0,
    };
    ESP_ERROR_CHECK(i2c_param_config(I2C_XL_PORT, &cfg));
    ESP_ERROR_CHECK(i2c_driver_install(I2C_XL_PORT, cfg.mode, 0, 0, 0));
    vTaskDelay(pdMS_TO_TICKS(50));
#if CONFIG_NODE_BUZZER_XL9555
    beep_init();
#endif
#if CONFIG_NODE_SOS_KEY0_ENABLED
    key0_init();
#endif
#endif
}

void board_gpio_start(void)
{
#if CONFIG_NODE_MOTION_GPIO >= 0
    {
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_MOTION_GPIO;
        io.pull_up_en = GPIO_PULLUP_DISABLE;
        io.pull_down_en = GPIO_PULLDOWN_ENABLE;     /* 悬空时不要随机触发 */
        gpio_config(&io);
    }
#endif
#if CONFIG_NODE_SOS_GPIO >= 0
    {   /* 按键另一端接 GND，内部上拉，按下读到 0 */
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_SOS_GPIO;
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        io.pull_down_en = GPIO_PULLDOWN_DISABLE;
        gpio_config(&io);
    }
#endif
#if CONFIG_NODE_WATER_GPIO >= 0
    {   /* 水漏模块 DO：低有效时上拉，高有效时下拉 */
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_INPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_WATER_GPIO;
#if CONFIG_NODE_WATER_ACTIVE_LOW
        io.pull_up_en = GPIO_PULLUP_ENABLE;
        io.pull_down_en = GPIO_PULLDOWN_DISABLE;
#else
        io.pull_up_en = GPIO_PULLUP_DISABLE;
        io.pull_down_en = GPIO_PULLDOWN_ENABLE;
#endif
        gpio_config(&io);
    }
#endif
#if CONFIG_NODE_BUZZER_XL9555
    /* 板载蜂鸣器由 board_i2c_start() 里的 XL9555 初始化处理，不占 GPIO */
#elif CONFIG_NODE_BUZZER_GPIO >= 0
    {
        gpio_config_t io = { 0 };
        io.intr_type = GPIO_INTR_DISABLE;
        io.mode = GPIO_MODE_OUTPUT;
        io.pin_bit_mask = 1ULL << CONFIG_NODE_BUZZER_GPIO;
        gpio_config(&io);
        gpio_set_level(CONFIG_NODE_BUZZER_GPIO, 0);
    }
#endif
}

void board_buzzer(int on)
{
#if CONFIG_NODE_BUZZER_XL9555
    uint8_t out = 0;
    if (board_xl9555_read(XL9555_OUTPUT_PORT0_REG, &out) != ESP_OK) return;
    uint8_t next = on ? (uint8_t)(out & ~XL9555_BEEP_P0_BIT) : (uint8_t)(out | XL9555_BEEP_P0_BIT);
    if (next != out) board_xl9555_write(XL9555_OUTPUT_PORT0_REG, next);
#elif CONFIG_NODE_BUZZER_GPIO >= 0
    gpio_set_level(CONFIG_NODE_BUZZER_GPIO, on ? 1 : 0);
#else
    (void)on;
#endif
}

#if CONFIG_NODE_VOICE_ENABLED && CONFIG_NODE_BUZZER_XL9555
/* KEY1 = P1_6，低电平按下。短按松开后录 4 秒提问，不做 SOS、不改告警状态。
 * 识别成健康问题时网关回 clip=9，本板直接播健康建议；其余问题走 ASR/DeepSeek。 */
#define AI_KEY1_P1_BIT 0x40
static int s_ai_key_last_raw = -1;
static int s_ai_key_armed = 0;
static int s_ai_key_press_active = 0;
static int64_t s_ai_key_press_at = 0;

void board_ai_key_tick(void)
{
    uint8_t p1 = 0;
    if (board_xl9555_read(XL9555_INPUT_PORTS_REG + 1, &p1) != ESP_OK) return;
    int raw = ((p1 & AI_KEY1_P1_BIT) == 0) ? 1 : 0;
    if (s_ai_key_last_raw < 0) {
        s_ai_key_last_raw = raw;
        if (!raw) s_ai_key_armed = 1;
        return;
    }
    int64_t now = node_now_ms();
    if (raw && s_ai_key_last_raw == 0 && s_ai_key_armed) {
        s_ai_key_press_at = now;
        s_ai_key_press_active = 1;
    }
    if (!raw && s_ai_key_last_raw == 1) {
        if (s_ai_key_press_active && now - s_ai_key_press_at >= 50) {
            ESP_LOGI(TAG, "AI_KEY1 短按：开始 4 秒语音提问");
            board_buzzer(1);
            vTaskDelay(pdMS_TO_TICKS(80));
            board_buzzer(0);
            mic_link_trigger("question");
        }
        s_ai_key_press_active = 0;
        s_ai_key_armed = 1;
    }
    s_ai_key_last_raw = raw;
}
#endif
