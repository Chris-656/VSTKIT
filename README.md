# VSTKIT

Firmware releases for the VST-KIT (ESP32).

- `firmware/version.json` - current version and the names of the images
- `firmware/manifest.json` - used by the web config tool to flash the update image
- `firmware/vstkit_<hw>_<version>_update.bin` - bootloader-less update (boot_app0 + app), flash at `0xE000`; keeps Bluetooth pairings, config and key
- `firmware/vstkit_<hw>_<version>_full.bin` - complete image, flash at `0x0` for new devices; wipes the Bluetooth pairings
