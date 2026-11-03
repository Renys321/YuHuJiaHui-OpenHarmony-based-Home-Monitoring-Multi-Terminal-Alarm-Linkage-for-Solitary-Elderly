/* 温湿度传感器：AHT20（I2C1）或 DHT11（单总线），按 Kconfig 二选一编译。
 *
 * 板载 IIC0(IO41/IO42) 上挂的是 XL9555/ES8388 这些板载器件，引脚没引出到排针，
 * 所以外部 AHT20 单独走 I2C1，SDA/SCL 由 Kconfig 指定（当前 IO4/IO5）。
 *
 * 读数无效一律返回 -1，由调用方决定“保持上次判定”，这里不猜温度。
 */
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"

#include "climate.h"
#include "node_common.h"

#define AHT20_ADDR  0x38
#define I2C_AHT_PORT I2C_NUM_1

void climate_bus_start(void)
{
#if CONFIG_NODE_AHT20_ENABLED
    i2c_config_t cfg = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = CONFIG_NODE_I2C_SDA_GPIO,
        .scl_io_num = CONFIG_NODE_I2C_SCL_GPIO,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
        .clk_flags = 0,
    };
    ESP_ERROR_CHECK(i2c_param_config(I2C_AHT_PORT, &cfg));
    ESP_ERROR_CHECK(i2c_driver_install(I2C_AHT_PORT, cfg.mode, 0, 0, 0));
    vTaskDelay(pdMS_TO_TICKS(100));
    const uint8_t init[] = { 0xbe, 0x08, 0x00 };
    esp_err_t err = i2c_master_write_to_device(I2C_AHT_PORT, AHT20_ADDR, init, sizeof(init), pdMS_TO_TICKS(100));
    if (err != ESP_OK) ESP_LOGW(TAG, "AHT20 初始化命令失败: %s", esp_err_to_name(err));
    vTaskDelay(pdMS_TO_TICKS(20));
#endif
}

#if CONFIG_NODE_AHT20_ENABLED
/* AHT20 数据手册的 CRC-8：初值 0xFF，多项式 0x31 */
static uint8_t aht20_crc8(const uint8_t *data, size_t len)
{
    uint8_t crc = 0xff;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

static int aht20_read(float *temp_c, float *rh)
{
    const uint8_t trigger[] = { 0xac, 0x33, 0x00 };
    if (i2c_master_write_to_device(I2C_AHT_PORT, AHT20_ADDR, trigger, sizeof(trigger), pdMS_TO_TICKS(100)) != ESP_OK) {
        return -1;
    }
    vTaskDelay(pdMS_TO_TICKS(90));
    uint8_t data[7] = { 0 };
    if (i2c_master_read_from_device(I2C_AHT_PORT, AHT20_ADDR, data, sizeof(data), pdMS_TO_TICKS(100)) != ESP_OK) {
        return -1;
    }
    if ((data[0] & 0x80) != 0 || aht20_crc8(data, 6) != data[6]) return -1;
    uint32_t raw_h = ((uint32_t)data[1] << 12) | ((uint32_t)data[2] << 4) | (data[3] >> 4);
    uint32_t raw_t = ((uint32_t)(data[3] & 0x0f) << 16) | ((uint32_t)data[4] << 8) | data[5];
    *rh = (float)raw_h * 100.0f / 1048576.0f;
    *temp_c = (float)raw_t * 200.0f / 1048576.0f - 50.0f;
    if (!isfinite(*temp_c) || !isfinite(*rh)) return -1;
    return (*rh >= 0.0f && *rh <= 100.0f && *temp_c >= -40.0f && *temp_c <= 85.0f) ? 0 : -1;
}
#endif

#if CONFIG_NODE_DHT11_GPIO >= 0
/* 等引脚离开 level；超时返回 -1，经过的时间通过 elapsed_us 带出（可为 NULL） */
static int dht11_wait_level(int pin, int level, int timeout_us, int64_t *elapsed_us)
{
    int64_t start = esp_timer_get_time();
    while (gpio_get_level(pin) == level) {
        if (esp_timer_get_time() - start > timeout_us) {
            if (elapsed_us != NULL) *elapsed_us = esp_timer_get_time() - start;
            return -1;
        }
        esp_rom_delay_us(1);
    }
    if (elapsed_us != NULL) *elapsed_us = esp_timer_get_time() - start;
    return 0;
}

/* 一次完整的 DHT11 时序：40 位按高电平宽度解码，最后校验 1 字节和 */
static int dht11_read(float *temp_c, float *rh)
{
    const int pin = CONFIG_NODE_DHT11_GPIO;
    uint8_t data[5] = { 0 };
    int highs[40] = { 0 };
    int64_t elapsed = 0;
    static int s_dht_diag_logs = 0;   /* 时序出错时只打前 8 条，别刷屏 */

    gpio_config_t io = { 0 };
    io.intr_type = GPIO_INTR_DISABLE;
    io.mode = GPIO_MODE_INPUT_OUTPUT_OD;
    io.pin_bit_mask = 1ULL << pin;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    if (gpio_config(&io) != ESP_OK) return -1;

    /* 两次读取至少隔 1 秒，本节点采样周期也是秒级，正好够 */
    gpio_set_level(pin, 1);
    vTaskDelay(pdMS_TO_TICKS(1100));
    gpio_set_level(pin, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(pin, 1);
    esp_rom_delay_us(30);
    gpio_set_direction(pin, GPIO_MODE_INPUT);
    gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);

    if (dht11_wait_level(pin, 1, 100, &elapsed) != 0) {
        if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: no response low, line=%d wait=%lldus", gpio_get_level(pin), elapsed);
        return -1;
    }
    if (dht11_wait_level(pin, 0, 100, &elapsed) != 0) {
        if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: response low stuck, line=%d wait=%lldus", gpio_get_level(pin), elapsed);
        return -1;
    }
    if (dht11_wait_level(pin, 1, 100, &elapsed) != 0) {
        if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: response high stuck, line=%d wait=%lldus", gpio_get_level(pin), elapsed);
        return -1;
    }

    for (int i = 0; i < 40; i++) {
        if (dht11_wait_level(pin, 0, 100, &elapsed) != 0) {
            if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: bit %d low start timeout line=%d wait=%lldus", i, gpio_get_level(pin), elapsed);
            return -1;
        }
        /* 低电平周期刚结束、线已经是高，从这里开始量高电平宽度 */
        int64_t high_start = esp_timer_get_time();
        if (dht11_wait_level(pin, 1, 100, &elapsed) != 0) {
            if (s_dht_diag_logs++ < 8) ESP_LOGW(TAG, "DHT11 diag: bit %d high end timeout line=%d wait=%lldus", i, gpio_get_level(pin), elapsed);
            return -1;
        }
        int high_us = (int)(esp_timer_get_time() - high_start);
        highs[i] = high_us;
        data[i / 8] <<= 1;
        if (high_us > 45) data[i / 8] |= 1;
    }

    gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT_OD);
    gpio_set_level(pin, 1);

    uint8_t sum = (uint8_t)(data[0] + data[1] + data[2] + data[3]);
    if (sum != data[4]) {
        if (s_dht_diag_logs++ < 8) {
            ESP_LOGW(TAG, "DHT11 diag: checksum mismatch d=%02x %02x %02x %02x %02x highs=%d,%d,%d,%d,%d,%d,%d,%d",
                     data[0], data[1], data[2], data[3], data[4],
                     highs[0], highs[1], highs[2], highs[3], highs[4], highs[5], highs[6], highs[7]);
        }
        return -1;
    }
    *rh = (float)data[0];
    *temp_c = (float)data[2];
    if (s_dht_diag_logs++ < 8) {
        ESP_LOGI(TAG, "DHT11 diag: OK rh=%u temp=%u checksum=%02x highs=%d,%d,%d,%d",
                 data[0], data[2], data[4], highs[0], highs[1], highs[2], highs[3]);
    }
    return (*rh >= 0.0f && *rh <= 100.0f && *temp_c >= -20.0f && *temp_c <= 60.0f) ? 0 : -1;
}
#endif

int climate_read(float *temp_c, float *rh)
{
#if CONFIG_NODE_DHT11_GPIO >= 0
    return dht11_read(temp_c, rh);
#elif CONFIG_NODE_AHT20_ENABLED
    return aht20_read(temp_c, rh);
#else
    (void)temp_c;
    (void)rh;
    return -1;
#endif
}
