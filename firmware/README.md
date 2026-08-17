# AI Image Interpreter firmware (ESP32-S3 round display)

Firmware for the **Waveshare ESP32-S3-Touch-LCD-1.28** — a 1.28" round LCD
(GC9A01) with a CST816S capacitive touch controller. The whole screen is one
button: tapping it asks the web app to capture + interpret the current frame,
and the result is shown on the round display.

## How it works

The MacBook screen share lives in the browser, so the device cannot capture the
screen itself. It uses the M3 **remote bridge** HTTP endpoints:

```
Device taps ──► (WS) {type:trigger} ──► browser sees it on GET /api/remote/poll
                                        browser captures + interprets the frame
                                        browser ──► POST /api/remote/answer
Server pushes (WS) {type:answer} ─────► device renders it instantly
```

The device opens a WebSocket to `ws://<backend>/api/remote/ws`: it sends a
`{type:trigger}` on tap and receives pushed `{type:answer}` / `{type:status}`
messages in real time (no polling).

The device shows: a spinner while working, then the big result letter(s), the
short result text, and a confidence ring around the edge. (This is superseded by
per-device WebSocket push in M8.)

## Hardware

| Function        | Signal | GPIO |
|-----------------|--------|------|
| LCD SCLK        | SCL    | 10   |
| LCD MOSI        | SDA    | 11   |
| LCD CS          | CS     | 9    |
| LCD DC          | DC     | 8    |
| LCD RST         | RST    | 14   |
| LCD Backlight   | BL     | 2    |
| Touch I2C SDA   | SDA    | 6    |
| Touch I2C SCL   | SCL    | 7    |
| Touch RST       | RST    | 13   |
| Touch INT       | INT    | 5    |

Touch I2C address: `0x15` (CST816S). Pins live in [src/lgfx_config.h](src/lgfx_config.h);
change only those if you use a different round-display board.

## Build & flash (PlatformIO)

```bash
# from the firmware/ directory
pio run                 # compile
pio run -t upload       # flash over USB
pio device monitor      # serial logs @ 115200
```

VS Code: install the **PlatformIO IDE** extension, open this `firmware/` folder,
then use the PlatformIO toolbar (build / upload / monitor).

## GitHub release firmware

Every GitHub release contains an `ai-visio-display-v*.bin` asset built for the
`waveshare-s3-round` environment. In Settings → Devices, choose **Load latest
from GitHub** to stage that image, then deploy it to a connected display.

## Over-the-air (OTA) updates (from VS Code)

After the **first** USB flash, all later updates can go over WiFi — no cable
needed. The firmware runs an ArduinoOTA service once it joins WiFi.

1. Read the device IP from its **idle screen** (shown under "Tap to scan").
2. Set the password and IP. The OTA password is defined in two places that must
   match: `OTA_PASSWORD` in [platformio.ini](platformio.ini) `build_flags`, and
   `--auth=` in the `[env:waveshare-s3-round-ota]` section. **Change the default
   `change-this-ota-pass` before deploying.**
3. Upload over the network:

   ```bash
   pio run -e waveshare-s3-round-ota -t upload --upload-port <device-ip>
   ```

   In VS Code: pick the **waveshare-s3-round-ota** environment in the PlatformIO
   project tasks, set `upload_port` to the device IP (or pass `--upload-port`),
   then run **Upload**. The round screen shows an "Updating %" ring during flash
   and reboots into the new firmware.

Arduino IDE OTA: after the first USB flash, the device also appears under
**Tools → Port → Network ports** as `ai-image-display`; select it and Upload
(enter the OTA password when prompted).

> OTA needs the device and your computer on the same network. The OTA password
> protects the device from unauthorized flashes — keep it secret.


## First-time setup (WiFi + backend URL)

1. On first boot the device hosts a WiFi access point named **`ai-exams-setup`**.
2. Join it from your phone/laptop; a captive portal opens.
3. Pick your WiFi network, enter its password, and set **Backend base URL**
   (e.g. `http://192.0.2.10:8000` — the host running the FastAPI backend).
4. Save. The device reboots, connects, and shows **Tap to solve**.

Settings are stored in NVS. To re-provision, **hold a finger on the screen while
powering on** — this wipes WiFi + server settings and reopens the portal.

## Alternative: deploy with the Arduino IDE

If PlatformIO/esptool can't flash over the CH343 USB-UART bridge, use the Arduino
IDE sketch in [arduino/ai_visio_display/](arduino/ai_visio_display/). It includes the
same maintained source as the PlatformIO build, so both distribution paths have
identical display behavior.

1. Install the **CH34x Mac driver** (required on macOS):
   https://files.waveshare.com/wiki/common/CH34XSER_MAC.7z — then reboot.
2. Arduino IDE → Preferences → Additional Boards Manager URLs, add:
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
   then Boards Manager → install **esp32 by Espressif Systems** (the Waveshare wiki
   recommends **2.0.12** for this board).
3. Library Manager → install **LovyanGFX**, **ArduinoJson** (v7),
   **WiFiManager** (by tzapu), and **WebSockets** (by Markus Sattler).
4. Open `arduino/ai_visio_display/ai_visio_display.ino`.
5. Tools → Board: **ESP32S3 Dev Module**, then set:
   - **USB CDC On Boot:** Disabled  (this board's USB-C uses a CH343 UART
     bridge, not native USB — leave this **off** or you get no serial logs)
   - **CPU Frequency:** 240MHz
   - **Flash Mode:** QIO 80MHz
   - **Flash Size:** 16MB (128Mb)
   - **PSRAM:** QSPI PSRAM  (this is the ESP32-S3**R2**, 2MB PSRAM)
   - **Partition Scheme:** 16M Flash (3MB APP/9.9MB FATFS)
   - **Upload Speed:** 921600 (drop to 115200 if uploads fail)
   - **Port:** `/dev/cu.usbmodem*`
6. **Put the board in download mode** (official Waveshare sequence): hold **BOOT**,
   press **RESET**, release **RESET**, then release **BOOT**.
7. Click **Upload**. After it finishes, tap **RESET** once to run the firmware.

> The official FAQ notes that a blank flash / unstable USB often blocks the first
> upload — the BOOT+RESET download-mode sequence above resolves it.

## Usage

- **Tap** anywhere → triggers a solve; the browser tab with the screen share must
  be open and connected to the same backend.
- While solving, a spinner + "Thinking" is shown (times out after 15 s).
- The answer screen shows the letter(s), short text, and a confidence ring
  (green ≥ 0.75, orange ≥ 0.45, red below). **Tap again** to solve the next one.
- On error, tap to return to the idle screen.

## Notes

- Keep the browser tab visible; some browsers throttle background tabs, which
  slows the capture→solve round-trip.
- The device polls `/api/remote/answer` every 400 ms only while waiting for an
  answer, so idle traffic is minimal.
