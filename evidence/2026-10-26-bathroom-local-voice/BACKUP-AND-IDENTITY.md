# BATHROOM COM4 backup and identity record - 2026-10-26

## Device identity (read-only, esptool 4.7.0)
- Port: COM4 (Windows PnP USB\VID_1A86&PID_7523\7&25042a44&0&2, CH340, status Started)
- Chip: ESP32-S3 (QFN56) revision v0.2, 40 MHz crystal, embedded PSRAM 8MB
- MAC (station): 14:c1:9f:42:dd:b4
- Flash detected size: 16 MB (manufacturer 0x5e, device 0x4018), eFuse flash type quad
- Security: Secure Boot Disabled, Flash Encryption Disabled, SPI_BOOT_CRYPT_CNT=0
- Firmware-reported identity: deviceId=esp32-bath, room=卫生间 (boot log, line 441 ms)
- Application image in factory partition: first 775,616 bytes byte-identical to the
  recorded bathroom firmware bathroom-8D4E9A26.bin (SHA-256 8D4E9A26...02CE).
  Bytes after that image up to 0x100000 are residual/unused (219716 non-0xFF bytes,
  first at image offset 0xbe000); they are preserved in the backup.

## Actual on-device partition table (read at 0x8000, 0x1000 bytes)
- nvs       data  nvs      0x009000  24K
- phy_init  data  phy      0x00f000  4K
- factory   app   factory  0x010000  1M
- Bootloader reports configured SPI flash size 2MB (binary image header), physical
  flash is 16MB; the deployed firmware/bootloader already ran with this 2MB header.

## Backups (PRIVATE - contain network configuration, never distribute)
These files live under:
  <WORKSPACE>\competition\esp32-node\.local\bathroom-voice-20261026\backup\
- Full flash image: bathroom-COM4-fullflash-20261026.bin
  size=16777216 bytes  SHA-256=D905C86C5B58130A8C65171C55F9C85FF53B632419E3E70158ADE0D7913F4E9B
- Original factory app partition (offset 0x10000, length 0x100000):
  bathroom-COM4-app-original-0x10000.bin
  size=1048576 bytes  SHA-256=1FDE4DF95929C0B8264D227066D3E55D7FBCE5860AAC1DB037CCDEB23F5D90A0
- Partition table binary: partition-table-0x8000.bin
  size=4096 bytes  SHA-256=B9118AA3840F7C042A4DEA8DAE339D07A6E69F3716102174CC87B18046276295

## Restore procedure (app partition only)
1) Confirm COM4 identity again (MAC 14:c1:9f:42:dd:b4, chip ESP32-S3).
2) Restore only the application partition, no erase, no bootloader/NVS/partition writes:
   python esptool.py --chip esp32s3 --port COM4 --baud 460800 \\
     write_flash --verify 0x10000 bathroom-COM4-app-original-0x10000.bin
3) Verify the read-back hash equals 1FDE4DF95929C0B8264D227066D3E55D7FBCE5860AAC1DB037CCDEB23F5D90A0 and confirm the board boots and
   reports deviceId=esp32-bath / room=卫生间 with AHT20/PIR reporting.
Full-flash restore (only if a non-app region is ever damaged, NOT used this round):
   python esptool.py --chip esp32s3 --port COM4 --baud 460800 write_flash 0x0 bathroom-COM4-fullflash-20261026.bin
