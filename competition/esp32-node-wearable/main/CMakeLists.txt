idf_component_register(SRCS "wearable_main.c" "wearable_logic.c" "battery_logic.c"
                       INCLUDE_DIRS "."
                       REQUIRES driver nvs_flash esp_timer esp_hw_support esp_adc)
