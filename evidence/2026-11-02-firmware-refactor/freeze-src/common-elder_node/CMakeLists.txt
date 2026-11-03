# elder_node —— 三块 ESP32-S3 节点共用的固件组件（唯一真源）
# app_main / 传感器 / 告警状态机 / 语音 / LED / 电池 / NVS 全在这里。
# 只有启用语音时才把 ADPCM 片段嵌入固件，关闭语音可省去对应 flash 空间。
set(voice_assets "")
if(CONFIG_NODE_VOICE_ENABLED)
    set(voice_assets
        "voice/sos.adpcm"
        "voice/climate_temp.adpcm"
        "voice/climate_rh.adpcm"
        "voice/climate_both.adpcm"
        "voice/no_motion.adpcm"
        "voice/climate_generic.adpcm"
        "voice/prompt.adpcm"
        "voice/health.adpcm")
endif()
# 公共节点逻辑与可选语音素材由同一组件注册，依赖项提供所需 ESP-IDF 驱动和网络接口。
idf_component_register(
    SRCS "node_main.c" "board_io.c" "wifi_link.c" "climate.c" "door_monitor.c" "announce.c" "gw_link.c" "local_voice.c" "speaker_link.c" "mic_link.c" "local_led.c" "battery_logic.c"
    INCLUDE_DIRS "."
    EMBED_FILES ${voice_assets}
    REQUIRES esp_adc driver esp_wifi esp_event esp_netif nvs_flash lwip esp_timer)