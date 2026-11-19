# esp32sim desktop

[中文](README.md) · English

A Windows desktop launcher for esp32sim: pick a firmware, press Run, and watch the board, serial
console and network panels in a single window. Rebuild the firmware and it restarts automatically.

- Upstream simulator: [mikroverk/esp32sim](https://github.com/mikroverk/esp32sim), `main` baseline
  `d043ff1` (MIT; 18 commits newer than v0.4.0)
- This shell: Tauri 2 + WebView2, with the upstream native binary running as a sidecar
- Platform: Windows 10 1809+ / 11 x64

## Quick start

1. Unzip `dist/esp32sim-desktop_0.1.0_x64-portable.zip`, or install
   `dist/esp32sim desktop_0.1.0_x64-setup.exe` (requires the WebView2 runtime, normally included
   in Windows 10 1809+ / Windows 11).
2. Provide a mask ROM (not distributed with the package): put it in `roms\`, or let the app find it
   automatically under the ESP-IDF directory `%USERPROFILE%\.espressif\tools\esp-rom-elfs`.
3. Enter the ESP-IDF / PlatformIO build directory, click **识别** (Detect), then **运行** (Run).
   The build directory must contain `bootloader.bin`, `partition-table.bin`, and the app's
   `.bin`/`.elf`.

## UI at a glance

| Area | Purpose |
|---|---|
| Chip / Board | The board must match the chip; for example `atech14` is for ESP32-S3 only |
| Wiring canvas | With `custom` selected: place devices by the DevKitC-1 silkscreen and draw wires; pins and `--device` are filled in for you |
| Firmware | Build directory + the three binaries + optional ELF |
| ROM | Leave empty for automatic discovery |
| Modules | Flash / PSRAM sizes must match how the firmware was built |
| Network | Enter an SSID to enable the virtual AP; firmware reaches the real network through NAT |
| Output | Where screenshots / audio / waveforms are saved |
| Automation | Watch the build directory and restart as soon as the artifacts change |
| Project | Save / load configuration (`%APPDATA%\dev.esp32sim.desktop\project.json`) |

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `找不到 <chip> 的 mask ROM` | ROM not in the automatic search path | Put it in `roms\` or select it manually |
| `bootloader 文件不存在` | Path moved or not detected | Re-select the build directory and click Detect |
| `not an ESP image` | A whole flash image was used as the app | Use the three separate binaries instead |
| Restarts immediately / stuck in bootloader | Flash / PSRAM sizes differ from the firmware build | Match the values from `idf.py menuconfig` |
| No serial output | Wrong console (UART0 vs USB-CDC) | Switch the Console tab on the board page |

## Building

```powershell
git clone https://github.com/mikroverk/esp32sim.git vendor/esp32sim
git -C vendor/esp32sim checkout d043ff1dd3e53aca18a23f4f2b18bfb038a57667
git -C vendor/esp32sim apply patches\vendor-esp32sim-local.patch
powershell -ExecutionPolicy Bypass -File scripts\build-sidecar.ps1
node scripts\stage-web.cjs
cd src-tauri
cargo tauri build
```

`vendor/esp32sim/` is not checked in. All local kernel changes live in
`patches/vendor-esp32sim-local.patch`; step 3 above applies them. The patch is based on the fork
commit `3a81c3b` (which adds `--buslog`) and has been verified to apply cleanly to a fresh checkout.
It currently contains:

- Bare-board `--device` I2C form `BUS:ADDR:SDA:SCL:MODEL`: devices answer only when their physical
  SDA/SCL pins are actually wired
- Bare-board `--device` QSPI form `HOST:WIDTH:HEIGHT:XOFF:SCLK:CS:co5300`: transactions must reach
  those two wires
- SPI flash suspend/resume (0x75 / 0x7A) and SFDP probing, avoiding a boot assertion when IDF
  enables automatic suspend

Outputs:

- `src-tauri\target\release\esp32sim-desktop.exe`
- `src-tauri\target\release\bundle\nsis\esp32sim desktop_0.1.0_x64-setup.exe`

## Repository layout

| Path | Contents |
|---|---|
| `src/` | Main UI (plain HTML/CSS/JS) |
| `src-tauri/` | Rust backend: sidecar lifecycle, ports, ROM lookup, directory watch, project I/O |
| `scripts/` | Build scripts |
| `resources/web/` | Generated upstream board resources (with the embed patch; not checked in) |
| `patches/` | Local kernel changes applied at build time (needed to reproduce the untracked `vendor/`) |
| `firmware/` | Sample firmware for the `custom` bare board: SH1106 (I2C) / CO5300 (QSPI), each with its own README |
| `.workbuddy/skills/` | Project-local AI skill: build, run, parse buslog and capture panel shots, all with JSON output |
| `vendor/esp32sim/` | Upstream source (build dependency, not checked in) |

## Verification

Verified on Windows x64: launch, detection of the three firmware binaries, sidecar startup, board
loading and serial logs all work.

## License

This shell is MIT. Upstream esp32sim is MIT; the mask ROM is Espressif Apache-2.0 and is not
distributed with the package. Third-party notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
