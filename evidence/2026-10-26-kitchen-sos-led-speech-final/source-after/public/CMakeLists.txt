set(voice_assets "")
if(CONFIG_NODE_VOICE_ENABLED)
    # 6 条与真实触发原因一一对应的离线中文语音（IMA ADPCM 4bit @16kHz）。
    # 旧的 sos.pcm(正弦提示音) / warning.pcm(旧通用文案) / test.pcm(开机诊断) 已下线：
    # 前两条是“听不到人声”的直接原因，第三条在生产固件从来不会嵌入。
    set(voice_assets
        "voice/sos.adpcm"
        "voice/climate_temp.adpcm"
        "voice/climate_rh.adpcm"
        "voice/climate_both.adpcm"
        "voice/no_motion.adpcm"
        "voice/climate_generic.adpcm")
endif()
idf_component_register(SRCS "node_main.c" "local_voice.c" "local_led.c"
                       INCLUDE_DIRS "."
                       EMBED_FILES ${voice_assets}
                       REQUIRES esp_adc driver esp_wifi esp_event esp_netif nvs_flash lwip esp_timer)
