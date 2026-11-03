set(voice_assets "")
if(CONFIG_NODE_VOICE_ENABLED)
    set(voice_assets "voice/sos.pcm" "voice/warning.pcm")
    if(CONFIG_NODE_VOICE_BOOT_TEST)
        list(APPEND voice_assets "voice/test.pcm")
    endif()
endif()
idf_component_register(SRCS "node_main.c" "battery_logic.c" "local_voice.c"
                       INCLUDE_DIRS "."
                       EMBED_FILES ${voice_assets}
                       REQUIRES esp_adc driver esp_wifi esp_event esp_netif nvs_flash lwip esp_timer)
