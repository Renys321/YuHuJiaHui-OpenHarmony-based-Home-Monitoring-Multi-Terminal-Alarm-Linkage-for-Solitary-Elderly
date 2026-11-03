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
idf_component_register(SRCS "node_main.c" "board_io.c" "wifi_link.c" "climate.c" "door_monitor.c" "announce.c" "gw_link.c" "local_voice.c" "speaker_link.c" "mic_link.c" "local_led.c" "battery_logic.c"
                       INCLUDE_DIRS "."
                       EMBED_FILES ${voice_assets}
                       REQUIRES esp_adc driver esp_wifi esp_event esp_netif nvs_flash lwip esp_timer)