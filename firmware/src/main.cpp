// AI Image Interpreter ESP32 display firmware.
//
// Hardware: Waveshare ESP32-S3-Touch-LCD-1.28 (GC9A01 round LCD + CST816S touch).
//
// Behaviour:
//   * On first boot (or after a reset) it hosts a WiFi captive portal called
//     "ai-exams-setup" where you pick your WiFi and enter the backend base URL
//     (e.g. http://192.0.2.10:8000). These are saved to NVS.
//   * The whole round screen is one button. A tap calls POST /api/remote/trigger,
//     which tells the browser (holding the screen share) to capture + interpret the
//     current frame. The device then polls GET /api/remote/answer and renders the
//     answer letters big, with the short answer text and a confidence ring.
//   * Hold a touch while powering on to wipe WiFi/server settings and re-provision.
//
// The HTTP contract is the in-memory remote bridge from M3 (app/routers/remote.py).
// It is superseded by per-device WebSocket push in M8.

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <Preferences.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <HTTPUpdate.h>

#include "lgfx_config.h"

// OTA (over-the-air) update identity. Override via build_flags in platformio.ini.
#ifndef OTA_HOSTNAME
#define OTA_HOSTNAME "ai-image-display"
#endif
#ifndef OTA_PASSWORD
#define OTA_PASSWORD "change-this-ota-pass"
#endif

// Optional built-in WiFi credentials (auto-connect without the setup portal) and a
// default backend URL. Provide them in wifi_secrets.h (see wifi_secrets.example.h).
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#endif
#ifndef DEFAULT_BACKEND_URL
#define DEFAULT_BACKEND_URL "http://192.0.2.10:8000"
#endif

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
static LGFX lcd;
static LGFX_Sprite canvas(&lcd);  // full-screen off-screen buffer (flicker-free)
static Preferences prefs;
static WiFiManager wifiManager;
static WebSocketsClient g_ws;
static bool g_wsConnected = false;

static const uint16_t W = SCREEN_WIDTH;
static const uint16_t H = SCREEN_HEIGHT;
static const int16_t CX = SCREEN_WIDTH / 2;
static const int16_t CY = SCREEN_HEIGHT / 2;

// Backend base URL (no trailing slash), e.g. "http://192.0.2.10:8000".
static String g_serverUrl;
// WiFiManager custom field buffer for the server URL.
static char g_serverUrlBuf[96] = "http://192.0.2.10:8000";
static bool g_shouldSaveParams = false;
// Persistent WiFiManager custom parameter (backend URL); added to the portal once.
static WiFiManagerParameter g_serverParam("server", "Backend base URL", "", 96);
static bool g_paramAdded = false;

// Device-side state machine.
enum class UiState { Connecting, Idle, Solving, Answer, Error, Settings, CaseStudy };
static UiState g_state = UiState::Connecting;

// Baseline answer id so we ignore a stale answer left on the server.
static String g_lastAnswerId;
static uint32_t g_triggerAt = 0;          // millis() when we sent the trigger
static const uint32_t SOLVE_TIMEOUT_MS = 15000;
static String g_errorMsg;

// Latest answer to render.
struct Answer {
  String letters;   // e.g. "B" or "A, C"
  String text;      // short answer text
  String qtype;     // single | truefalse | multi | draganddrop | unknown
  float  confidence = 0.0f;
  bool   cached = false;
};
static Answer g_answer;

// Touch / gesture tracking.
static uint32_t g_lastTouchAt = 0;
static const uint32_t TOUCH_DEBOUNCE_MS = 250;
static bool g_gestureActive = false;   // a touch is currently held down
static bool g_gestureSwiped = false;   // current gesture already fired a swipe
static int32_t g_gestureStartX = 0;
static int32_t g_gestureStartY = 0;
static const int16_t SWIPE_TOP_ZONE = 60;      // swipe must start in the top 60px
static const int16_t SWIPE_MIN_DISTANCE = 70;  // and travel at least 70px down

// Settings screen state.
static int g_settingsScroll = 0;         // pixels scrolled within the settings list
static int g_settingsContentH = 0;       // total content height (computed each render)
static bool g_settingsDragging = false;  // a drag is in progress on the settings screen
static int32_t g_settingsDragStartY = 0;
static int32_t g_settingsLastY = 0;

// Case-study mode state. Swipe up to enter: the whole screen becomes a capture UI for the
// "fake company" scenario screens. Each tap on the camera asks the browser (which holds
// the API key) to transcribe + cache the current screen; the running count is pushed back
// over the WebSocket. The cached scenario is then supplied as context on later solves.
static int g_caseCount = 0;              // scenario screens captured (from server broadcasts)
static bool g_caseCapturing = false;     // a capture request is in flight
static uint32_t g_caseCaptureAt = 0;     // millis() when the capture was requested
static uint32_t g_caseFlashAt = 0;       // millis() of the last success/failure flash
static bool g_caseLastOk = true;         // outcome of the last capture (for the flash)
static const uint32_t CASE_CAPTURE_TIMEOUT_MS = 12000;

// Case-study has two sub-pages you switch between: page 0 captures the scenario screens,
// page 1 solves the questions (which use the cached scenario as context).
static uint8_t g_casePage = 0;      // 0 = capture, 1 = solve
static bool g_caseSolving = false;  // a solve is in flight on the solve page

// Firmware OTA (HTTP): set when the backend broadcasts {"type":"ota"}. The blocking
// download + flash runs from loop() (never inside the WebSocket receive callback).
static bool g_otaRequested = false;
static String g_otaUrl;

// Display preferences (pushed from Settings → Device & Display; persisted in NVS).
static uint8_t g_dispBrightness = 200;
static uint8_t g_dispTextSize = 1;        // 0=small, 1=medium, 2=large
static bool g_dispShowConfidence = true;
static bool g_dispShowSubtext = true;
static bool g_dispShowCachedBadge = true;

static void loadDisplayPrefs() {
  prefs.begin("aiexams", true);
  g_dispBrightness = prefs.getUChar("dbright", 200);
  g_dispTextSize = prefs.getUChar("dtsize", 1);
  g_dispShowConfidence = prefs.getBool("dconf", true);
  g_dispShowSubtext = prefs.getBool("dsub", true);
  g_dispShowCachedBadge = prefs.getBool("dcache", true);
  prefs.end();
}

static void saveDisplayPrefs() {
  prefs.begin("aiexams", false);
  prefs.putUChar("dbright", g_dispBrightness);
  prefs.putUChar("dtsize", g_dispTextSize);
  prefs.putBool("dconf", g_dispShowConfidence);
  prefs.putBool("dsub", g_dispShowSubtext);
  prefs.putBool("dcache", g_dispShowCachedBadge);
  prefs.end();
}

// ---------------------------------------------------------------------------
// Colours (RGB565)
// ---------------------------------------------------------------------------
static const uint16_t COL_BG      = 0x0000;  // black
static const uint16_t COL_TEXT    = 0xFFFF;  // white
static const uint16_t COL_MUTED   = 0x8410;  // grey
static const uint16_t COL_ACCENT  = 0x05BF;  // cyan-ish
static const uint16_t COL_GOOD    = 0x2E6B;  // green
static const uint16_t COL_WARN    = 0xFD20;  // orange
static const uint16_t COL_BAD     = 0xF986;  // red

static uint16_t confidenceColor(float c) {
  if (c >= 0.75f) return COL_GOOD;
  if (c >= 0.45f) return COL_WARN;
  return COL_BAD;
}

// ---------------------------------------------------------------------------
// Rendering helpers (draw into the off-screen sprite, then push once)
// ---------------------------------------------------------------------------
static void drawConfidenceRing(float c) {
  const float frac = constrain(c, 0.0f, 1.0f);
  const int r0 = CX - 10;
  const int r1 = CX - 4;
  // Track
  canvas.fillArc(CX, CY, r0, r1, 0, 360, COL_MUTED);
  // Value arc starting at top (-90deg), clockwise.
  const float endDeg = -90.0f + 360.0f * frac;
  if (frac > 0.001f) {
    canvas.fillArc(CX, CY, r0, r1, -90, endDeg, confidenceColor(frac));
  }
}

static void renderConnecting(const char* line) {
  canvas.fillScreen(COL_BG);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_ACCENT, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("ai-visio+", CX, CY - 18);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.setTextSize(1);
  canvas.drawString(line, CX, CY + 14);
  canvas.pushSprite(0, 0);
}

// A small filled "Case Study" pill near the top of the idle/answer screens, sized and
// positioned to sit fully inside the round display (not clipped by the bezel).
static void drawCaseButton() {
  const int bw = 92, bh = 28, by = 26;
  const int bx = CX - bw / 2;
  canvas.fillRoundRect(bx, by, bw, bh, 14, COL_ACCENT);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_BG, COL_ACCENT);
  canvas.setTextSize(1);
  canvas.drawString("Case Study", CX, by + bh / 2);
}

static void renderIdle() {
  canvas.fillScreen(COL_BG);
  canvas.fillArc(CX, CY, CX - 6, CX - 2, 0, 360, COL_MUTED);
  drawCaseButton();
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("Solve", CX, CY - 6);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.setTextSize(1);
  canvas.drawString("tap lower half", CX, CY + 20);
  canvas.drawString(WiFi.localIP().toString().c_str(), CX, CY + 46);
  canvas.pushSprite(0, 0);
}

static void renderSolving() {
  canvas.fillScreen(COL_BG);
  // Spinner: a moving arc.
  const int sweep = (millis() / 4) % 360;
  canvas.fillArc(CX, CY, CX - 10, CX - 4, sweep, sweep + 80, COL_ACCENT);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("Thinking", CX, CY);
  canvas.pushSprite(0, 0);
}

// Draw text centred and word-wrapped across up to maxLines lines, keeping a
// side margin so nothing is clipped by the round bezel. Overflowing text is
// truncated with an ellipsis on the final line.
static void drawWrappedCentered(const String& text, int cx, int topY,
                                int maxWidth, int lineH, int maxLines) {
  String lines[4];
  int count = 0;
  String line;
  int pos = 0;
  const int len = text.length();

  while (pos < len && count < maxLines) {
    int sp = text.indexOf(' ', pos);
    String word = (sp < 0) ? text.substring(pos) : text.substring(pos, sp);
    String trial = line.length() ? line + " " + word : word;
    if (line.length() == 0 || canvas.textWidth(trial.c_str()) <= maxWidth) {
      line = trial;
    } else {
      lines[count++] = line;
      line = word;
    }
    pos = (sp < 0) ? len : sp + 1;
  }
  if (count < maxLines && line.length()) {
    lines[count++] = line;
    line = "";
  }

  // Anything left over means we ran out of lines and must truncate.
  if ((pos < len || line.length()) && count > 0) {
    String last = lines[count - 1];
    while (last.length() &&
           canvas.textWidth((last + "...").c_str()) > maxWidth) {
      last.remove(last.length() - 1);
    }
    lines[count - 1] = last + "...";
  }

  for (int i = 0; i < count; i++) {
    canvas.drawString(lines[i].c_str(), cx, topY + i * lineH);
  }
}

static void renderAnswer() {
  canvas.fillScreen(COL_BG);
  if (g_dispShowConfidence) drawConfidenceRing(g_answer.confidence);
  drawCaseButton();

  canvas.setTextDatum(textdatum_t::middle_center);

  // Big answer letters in the centre. Base size follows the display text-size pref, then
  // scales down if there are many letters.
  const char* letters = g_answer.letters.length() ? g_answer.letters.c_str() : "?";
  int base = g_dispTextSize == 0 ? 6 : (g_dispTextSize == 2 ? 8 : 7);
  int size = base;
  if (g_answer.letters.length() > 4) size = base - 2;
  if (g_answer.letters.length() > 7) size = base - 4;
  if (size < 2) size = 2;
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(size);
  canvas.drawString(letters, CX, CY - 18);

  // Short answer text below, wrapped across up to 3 rows with side margins so
  // it is not clipped left/right by the round screen.
  if (g_dispShowSubtext) {
    canvas.setTextSize(1);
    canvas.setTextColor(COL_MUTED, COL_BG);
    drawWrappedCentered(g_answer.text, CX, CY + 26, W - 56, 12, 3);
  }

  // Cached marker.
  if (g_dispShowCachedBadge && g_answer.cached) {
    canvas.setTextColor(COL_ACCENT, COL_BG);
    canvas.drawString("cached", CX, CY + 64);
  }
  canvas.pushSprite(0, 0);
}

static void renderError(const char* msg) {
  canvas.fillScreen(COL_BG);
  canvas.fillArc(CX, CY, CX - 6, CX - 2, 0, 360, COL_BAD);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_BAD, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("Error", CX, CY - 16);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.setTextSize(1);
  canvas.drawString(msg, CX, CY + 14);
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.drawString("tap to retry", CX, CY + 40);
  canvas.pushSprite(0, 0);
}

// A simple camera glyph (no icon font): body + viewfinder bump + lens.
static void drawCameraIcon(int cx, int cy, int s, uint16_t col) {
  canvas.fillRoundRect(cx - s, cy - (s * 2) / 3, s * 2, (s * 4) / 3, 5, col);
  canvas.fillRoundRect(cx - s / 3, cy - (s * 2) / 3 - 6, (s * 2) / 3, 8, 2, col);
  canvas.fillCircle(cx, cy, s / 2, COL_BG);
  canvas.fillCircle(cx, cy, s / 3, col);
  canvas.fillCircle(cx, cy, s / 6, COL_BG);
}

// Small pill at the top of the case-study screens to switch between the two pages.
static void drawCaseSwitchTab(const char* label) {
  const int bw = 100, bh = 26, by = 26;
  const int bx = CX - bw / 2;
  canvas.drawRoundRect(bx, by, bw, bh, 13, COL_ACCENT);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_ACCENT, COL_BG);
  canvas.setTextSize(1);
  canvas.drawString(label, CX, by + bh / 2);
}

// "Exit & clear" button at the bottom of the case-study screens.
static void drawCaseExitButton() {
  const int bw = 116, bh = 30, by = (int)H - 44;
  const int bx = CX - bw / 2;
  canvas.fillRoundRect(bx, by, bw, bh, 8, COL_BAD);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_BG, COL_BAD);
  canvas.setTextSize(1);
  canvas.drawString("Exit & clear", CX, by + bh / 2);
}

// Case-study page 1 — capture: tap the camera to cache each scenario screen.
static void renderCaseCapture() {
  canvas.fillScreen(COL_BG);
  canvas.setTextDatum(textdatum_t::middle_center);
  drawCaseSwitchTab("Go to Solve");

  const bool flashing = g_caseFlashAt && (millis() - g_caseFlashAt < 1600);
  if (g_caseCapturing) {
    const int sweep = (millis() / 4) % 360;
    canvas.fillArc(CX, CY - 6, 32, 38, sweep, sweep + 80, COL_ACCENT);
    canvas.setTextColor(COL_TEXT, COL_BG);
    canvas.setTextSize(1);
    canvas.drawString("Reading...", CX, CY - 6);
  } else if (flashing) {
    canvas.setTextColor(g_caseLastOk ? COL_GOOD : COL_BAD, COL_BG);
    canvas.setTextSize(2);
    canvas.drawString(g_caseLastOk ? "Saved" : "Failed", CX, CY - 8);
  } else {
    drawCameraIcon(CX, CY - 10, 20, COL_ACCENT);
    canvas.setTextColor(COL_MUTED, COL_BG);
    canvas.setTextSize(1);
    canvas.drawString("Tap to capture", CX, CY + 22);
  }

  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(1);
  char c[24];
  snprintf(c, sizeof(c), "Screens: %d", g_caseCount);
  canvas.drawString(c, CX, H - 60);

  drawCaseExitButton();
  canvas.pushSprite(0, 0);
}

// Case-study page 2 — solve: tap to answer the question using the cached scenario.
static void renderCaseSolve() {
  canvas.fillScreen(COL_BG);
  canvas.setTextDatum(textdatum_t::middle_center);
  drawCaseSwitchTab("Go to Capture");

  if (g_caseSolving) {
    const int sweep = (millis() / 4) % 360;
    canvas.fillArc(CX, CY - 6, 32, 38, sweep, sweep + 80, COL_ACCENT);
    canvas.setTextColor(COL_TEXT, COL_BG);
    canvas.setTextSize(1);
    canvas.drawString("Thinking", CX, CY - 6);
  } else if (g_answer.letters.length() || g_answer.text.length()) {
    const char* letters = g_answer.letters.length() ? g_answer.letters.c_str() : "?";
    int size = 6;
    if (g_answer.letters.length() > 4) size = 4;
    if (g_answer.letters.length() > 7) size = 3;
    canvas.setTextColor(COL_TEXT, COL_BG);
    canvas.setTextSize(size);
    canvas.drawString(letters, CX, CY - 16);
    canvas.setTextSize(1);
    canvas.setTextColor(COL_MUTED, COL_BG);
    drawWrappedCentered(g_answer.text, CX, CY + 22, W - 74, 12, 2);
  } else {
    canvas.setTextColor(COL_TEXT, COL_BG);
    canvas.setTextSize(2);
    canvas.drawString("Solve", CX, CY - 6);
    canvas.setTextColor(COL_MUTED, COL_BG);
    canvas.setTextSize(1);
    canvas.drawString("tap to answer", CX, CY + 20);
  }

  drawCaseExitButton();
  canvas.pushSprite(0, 0);
}

static void renderCaseStudy() {
  if (g_casePage == 1) renderCaseSolve();
  else renderCaseCapture();
}

static void renderOtaProgress(int pct) {
  canvas.fillScreen(COL_BG);
  // Progress arc from the top, clockwise.
  canvas.fillArc(CX, CY, CX - 10, CX - 4, 0, 360, COL_MUTED);
  if (pct > 0) {
    canvas.fillArc(CX, CY, CX - 10, CX - 4, -90, -90 + 3.6f * pct, COL_ACCENT);
  }
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("Updating", CX, CY - 14);
  char buf[8];
  snprintf(buf, sizeof(buf), "%d%%", pct);
  canvas.drawString(buf, CX, CY + 16);
  canvas.pushSprite(0, 0);
}

// Show a WiFi QR for the device's setup AP so a phone can scan to join it.
static void renderSetupQR() {
  lcd.fillScreen(COL_BG);
  lcd.setTextDatum(textdatum_t::middle_center);
  lcd.setTextColor(COL_TEXT, COL_BG);
  lcd.setTextSize(1);
  lcd.drawString("Scan to set up", CX, 22);
  const int qr = 150;
  const int qx = CX - qr / 2;
  const int qy = CY - qr / 2 + 6;
  lcd.fillRect(qx - 6, qy - 6, qr + 12, qr + 12, 0xFFFF);  // white quiet zone
  lcd.qrcode("WIFI:S:ai-exams-setup;T:nopass;;", qx, qy, qr, 3);
  lcd.setTextColor(COL_MUTED, COL_BG);
  lcd.drawString("join 'ai-exams-setup'", CX, H - 16);
}

// Shorten a string with a trailing ellipsis so it fits within maxWidth pixels.
static String fitText(const String& s, int maxWidth) {
  if (canvas.textWidth(s.c_str()) <= maxWidth) return s;
  String t = s;
  while (t.length() && canvas.textWidth((t + "...").c_str()) > maxWidth) {
    t.remove(t.length() - 1);
  }
  return t + "...";
}

// A small accent-coloured section heading inside the settings list.
static void drawSettingSection(const char* title, int cx, int& y) {
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextSize(1);
  canvas.setTextColor(COL_ACCENT, COL_BG);
  canvas.drawString(title, cx, y);
  y += 16;
}

// A label/value pair: muted label on one line, bright value below it.
static void drawSettingRow(const char* label, const String& value, int cx, int& y) {
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextSize(1);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.drawString(label, cx, y);
  y += 11;
  canvas.setTextColor(COL_TEXT, COL_BG);
  String v = value.length() ? value : String("-");
  canvas.drawString(fitText(v, W - 44).c_str(), cx, y);
  y += 16;
}

// Render the scrollable settings screen (QR + current settings + status).
static void renderSettings(int scroll) {
  canvas.fillScreen(COL_BG);

  const int cx = CX;
  int y = 16 - scroll;

  // Title.
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_ACCENT, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("Settings", cx, y);
  y += 26;

  // QR to join the on-device setup access point.
  const int qr = 88;
  const int qx = cx - qr / 2;
  canvas.fillRect(qx - 4, y - 4, qr + 8, qr + 8, 0xFFFF);
  canvas.qrcode("WIFI:S:ai-exams-setup;T:nopass;;", qx, y, qr, 2);
  y += qr + 8;

  canvas.setTextSize(1);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.drawString("Scan to join 'ai-exams-setup'", cx, y); y += 12;
  canvas.drawString("then open http://192.0.2.10", cx, y); y += 22;

  // Editable settings (changed through the portal above).
  drawSettingSection("CONFIGURE VIA QR", cx, y);
  drawSettingRow("WiFi network", WiFi.SSID().length() ? WiFi.SSID() : String("not set"), cx, y);
  drawSettingRow("Backend URL", g_serverUrl, cx, y);
  y += 8;

  // Read-only status.
  drawSettingSection("STATUS", cx, y);
  drawSettingRow("Connection", WiFi.isConnected() ? String("connected") : String("offline"), cx, y);
  drawSettingRow("IP address", WiFi.isConnected() ? WiFi.localIP().toString() : String("-"), cx, y);
  drawSettingRow("Signal", WiFi.isConnected() ? (String(WiFi.RSSI()) + " dBm") : String("-"), cx, y);
  drawSettingRow("Server link", g_wsConnected ? String("registered") : String("searching..."), cx, y);
  drawSettingRow("Discovery", g_wsConnected ? String("visible to app") : String("not visible"), cx, y);
  drawSettingRow("Device name", String(OTA_HOSTNAME), cx, y);
  drawSettingRow("MAC address", WiFi.macAddress(), cx, y);
  y += 10;

  // Close hint.
  canvas.setTextColor(COL_ACCENT, COL_BG);
  canvas.drawString("swipe up to close", cx, y); y += 18;

  // Record the absolute content height (independent of the scroll offset).
  g_settingsContentH = y + scroll;

  // Scrollbar on the right edge when the content overflows the screen.
  const int maxScroll = (g_settingsContentH > (int)H) ? (g_settingsContentH - (int)H) : 0;
  if (maxScroll > 0) {
    const int trackH = (int)H - 20;
    int barH = trackH * (int)H / g_settingsContentH;
    if (barH < 12) barH = 12;
    const int barY = 10 + (trackH - barH) * scroll / maxScroll;
    canvas.fillRoundRect(W - 6, barY, 3, barH, 1, COL_MUTED);
  }

  canvas.pushSprite(0, 0);
}

// ---------------------------------------------------------------------------
// Networking (WebSocket push)
// ---------------------------------------------------------------------------

// Apply a pushed answer object to the UI state.
static void applyAnswer(JsonObjectConst a, const char* answerId) {
  String letters;
  JsonArrayConst arr = a["answer_letters"].as<JsonArrayConst>();
  for (JsonVariantConst v : arr) {
    if (letters.length()) letters += ", ";
    letters += v.as<const char*>();
  }
  g_answer.letters = letters;
  g_answer.text = String((const char*)(a["answer_text"] | ""));
  g_answer.qtype = String((const char*)(a["question_type"] | "unknown"));
  g_answer.confidence = a["confidence"] | 0.0f;
  g_answer.cached = a["cached"] | false;
  g_lastAnswerId = String(answerId);
  g_caseSolving = false;
  // In case-study mode the answer is shown on the solve page; don't leave the mode.
  if (g_state != UiState::CaseStudy) g_state = UiState::Answer;
}

// Handle a JSON message pushed by the server over the WebSocket.
static void handleWsMessage(const uint8_t* payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len) != DeserializationError::Ok) return;

  const char* type = doc["type"] | "";
  const char* status = doc["status"] | "idle";
  const char* answerId = doc["answer_id"] | "";

  // Initial sync on connect: baseline the answer id so a stale answer left on
  // the server is not shown.
  if (strcmp(type, "state") == 0) {
    g_lastAnswerId = String(answerId);
    if (g_state == UiState::Connecting) g_state = UiState::Idle;
    return;
  }

  // Case-study capture result: the browser transcribed + cached a scenario screen and
  // reports the running count. Show a success/failure flash on the case-study screen.
  if (strcmp(type, "scenario") == 0) {
    g_caseCount = doc["count"] | g_caseCount;
    g_caseLastOk = doc["ok"] | true;
    g_caseCapturing = false;
    g_caseFlashAt = millis();
    return;
  }

  // OTA: the backend told every device to pull + flash new firmware. Defer the blocking
  // download to loop() so it does not run inside this WebSocket receive callback.
  if (strcmp(type, "ota") == 0) {
    const char* path = doc["path"] | "";
    if (strlen(path) > 0) {
      g_otaUrl = g_serverUrl + String(path);
      g_otaRequested = true;
    }
    return;
  }

  // Display preferences pushed from the app: apply + persist.
  if (strcmp(type, "display_config") == 0) {
    g_dispBrightness = (uint8_t)constrain((int)(doc["brightness"] | g_dispBrightness), 10, 255);
    const char* ts = doc["text_size"] | "";
    if (strcmp(ts, "small") == 0) g_dispTextSize = 0;
    else if (strcmp(ts, "large") == 0) g_dispTextSize = 2;
    else if (strcmp(ts, "medium") == 0) g_dispTextSize = 1;
    g_dispShowConfidence = doc["show_confidence"] | g_dispShowConfidence;
    g_dispShowSubtext = doc["show_subtext"] | g_dispShowSubtext;
    g_dispShowCachedBadge = doc["show_cached_badge"] | g_dispShowCachedBadge;
    lcd.setBrightness(g_dispBrightness);
    saveDisplayPrefs();
    return;
  }

  if (strcmp(status, "error") == 0) {
    if (g_state == UiState::CaseStudy) {
      // A solve failed on the case-study solve page: flash it, stay in the mode.
      g_caseSolving = false;
      g_caseLastOk = false;
      g_caseFlashAt = millis();
    } else {
      g_errorMsg = "solve failed";
      g_state = UiState::Error;
    }
    return;
  }

  if (strcmp(status, "done") == 0 && strlen(answerId) > 0 &&
      String(answerId) != g_lastAnswerId) {
    JsonObjectConst a = doc["answer"].as<JsonObjectConst>();
    if (!a.isNull()) applyAnswer(a, answerId);
  }
}

static void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      g_wsConnected = true;
      if (g_state == UiState::Connecting) g_state = UiState::Idle;
      break;
    case WStype_DISCONNECTED:
      g_wsConnected = false;
      g_state = UiState::Connecting;
      break;
    case WStype_TEXT:
      handleWsMessage(payload, len);
      break;
    default:
      break;
  }
}

// Split g_serverUrl ("http://host:port") into host and port.
static void parseServer(String& host, uint16_t& port) {
  String u = g_serverUrl;
  port = 80;
  const int scheme = u.indexOf("://");
  if (scheme >= 0) u = u.substring(scheme + 3);
  const int slash = u.indexOf('/');
  if (slash >= 0) u = u.substring(0, slash);
  const int colon = u.indexOf(':');
  if (colon >= 0) {
    host = u.substring(0, colon);
    port = (uint16_t)u.substring(colon + 1).toInt();
    if (port == 0) port = 80;
  } else {
    host = u;
  }
}

static void setupWebSocket() {
  String host;
  uint16_t port;
  parseServer(host, port);
  g_ws.begin(host, port, "/api/remote/ws");
  g_ws.onEvent(onWsEvent);
  g_ws.setReconnectInterval(3000);
}

// Send a touch trigger to the server (the browser then solves the current frame).
static bool wsTrigger() {
  if (!g_wsConnected) return false;
  return g_ws.sendTXT("{\"type\":\"trigger\"}");
}

// Ask the browser to capture + transcribe the current screen as a case-study scenario.
static bool wsCaptureScenario() {
  if (!g_wsConnected) return false;
  return g_ws.sendTXT("{\"type\":\"capture_scenario\"}");
}

// Tell the browser to drop all cached scenario content (leaving case-study mode).
static bool wsCaseExit() {
  if (!g_wsConnected) return false;
  return g_ws.sendTXT("{\"type\":\"case_exit\"}");
}

// Enter case-study mode fresh: start on the capture page with a cleared count.
static void enterCaseStudy() {
  g_caseCapturing = false;
  g_caseSolving = false;
  g_caseFlashAt = 0;
  g_caseCount = 0;
  g_casePage = 0;
  g_state = UiState::CaseStudy;
}

// Download + flash firmware from the backend over HTTP (OTA). Blocking; on success the
// HTTPUpdate library verifies the x-MD5 header and reboots into the new image.
static void performHttpOta(const String& url) {
  renderOtaProgress(0);
  if (g_wsConnected) g_ws.sendTXT("{\"type\":\"ota_status\",\"status\":\"updating\"}");
  WiFiClient client;
  httpUpdate.rebootOnUpdate(true);
  httpUpdate.onProgress([](int cur, int total) {
    renderOtaProgress(total > 0 ? (int)((int64_t)cur * 100 / total) : 0);
  });
  t_httpUpdate_return ret = httpUpdate.update(client, url);
  if (ret == HTTP_UPDATE_FAILED) {
    if (g_wsConnected) g_ws.sendTXT("{\"type\":\"ota_status\",\"status\":\"failed\"}");
    g_errorMsg = "update failed";
    g_state = UiState::Error;
  }
  // HTTP_UPDATE_OK reboots automatically (rebootOnUpdate=true).
}

// ---------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------
static bool touchPressed() {
  int32_t x, y;
  return lcd.getTouch(&x, &y);
}

// Taps whose press point is further than this from the centre are ignored, so resting a
// finger on the round bezel/frame no longer triggers the on-screen buttons.
static const int32_t TAP_RADIUS = 106;

// Poll the touch panel once and classify the gesture. A press released without travelling
// (and within the dial) is a tap; a downward drag that starts near the top edge is a
// "swipe down" (opens WiFi settings).
static void pollGestures(bool* tap, bool* swipeDown) {
  *tap = false;
  *swipeDown = false;

  int32_t x, y;
  const bool now = lcd.getTouch(&x, &y);
  if (now) {
    if (!g_gestureActive) {
      g_gestureActive = true;
      g_gestureSwiped = false;
      g_gestureStartX = x;
      g_gestureStartY = y;
    } else if (!g_gestureSwiped && g_gestureStartY < SWIPE_TOP_ZONE &&
               (y - g_gestureStartY) > SWIPE_MIN_DISTANCE) {
      g_gestureSwiped = true;
      *swipeDown = true;
    }
  } else if (g_gestureActive) {
    g_gestureActive = false;
    const int32_t ddx = g_gestureStartX - CX;
    const int32_t ddy = g_gestureStartY - CY;
    const bool inDial = (ddx * ddx + ddy * ddy) <= TAP_RADIUS * TAP_RADIUS;
    if (!g_gestureSwiped && inDial && (millis() - g_lastTouchAt) > TOUCH_DEBOUNCE_MS) {
      g_lastTouchAt = millis();
      *tap = true;
    }
  }
}

// Tap regions on the idle/answer screens: a small "Case Study" button at the top, and
// the lower half of the screen which triggers a solve (taps elsewhere are inert). The
// last press location is g_gestureStartX/Y (a tap barely moves).
static bool tapInCaseButton() {
  const int32_t dx = g_gestureStartX > CX ? g_gestureStartX - CX : CX - g_gestureStartX;
  return g_gestureStartY >= 20 && g_gestureStartY <= 58 && dx <= 52;
}
static bool tapInLowerHalf() {
  return g_gestureStartY > (int32_t)H / 2;
}

// Case-study screen regions: the page-switch pill (top), the exit button (bottom); a tap
// anywhere else in the dial is the middle action (capture on page 0, solve on page 1).
static bool tapCaseSwitch() {
  const int32_t dx = g_gestureStartX > CX ? g_gestureStartX - CX : CX - g_gestureStartX;
  return g_gestureStartY >= 20 && g_gestureStartY <= 58 && dx <= 52;
}
static bool tapCaseExit() {
  return g_gestureStartY > (int32_t)H - 50;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------
static void saveParamsCallback() { g_shouldSaveParams = true; }

static void loadServerUrl() {
  prefs.begin("aiexams", true);
  g_serverUrl = prefs.getString("server", "");
  prefs.end();
  if (g_serverUrl.length()) {
    g_serverUrl.toCharArray(g_serverUrlBuf, sizeof(g_serverUrlBuf));
  }
}

static void saveServerUrl(const String& url) {
  prefs.begin("aiexams", false);
  prefs.putString("server", url);
  prefs.end();
  g_serverUrl = url;
}

// Add the backend-URL parameter to the portal exactly once (it is reused).
static void ensureParamAdded() {
  if (!g_paramAdded) {
    wifiManager.addParameter(&g_serverParam);
    g_paramAdded = true;
  }
}

static void runProvisioning(bool forcePortal) {
  g_serverParam.setValue(g_serverUrlBuf, sizeof(g_serverUrlBuf) - 1);
  ensureParamAdded();
  wifiManager.setSaveParamsCallback(saveParamsCallback);
  wifiManager.setConfigPortalBlocking(true);
  wifiManager.setConfigPortalTimeout(180);
  wifiManager.setAPCallback([](WiFiManager*) {
    renderSetupQR();
  });

  bool connected;
  if (forcePortal) {
    renderConnecting("setup portal...");
    connected = wifiManager.startConfigPortal("ai-exams-setup");
  } else {
    renderConnecting("connecting WiFi...");
    connected = wifiManager.autoConnect("ai-exams-setup");
  }

  if (g_shouldSaveParams || forcePortal) {
    String url = g_serverParam.getValue();
    url.trim();
    while (url.endsWith("/")) url.remove(url.length() - 1);
    if (url.length()) saveServerUrl(url);
  }

  if (!connected) {
    renderError("WiFi failed; rebooting");
    delay(2500);
    ESP.restart();
  }
}

// Enable over-the-air updates (PlatformIO `espota` / Arduino IDE network port).
static void setupOTA() {
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { renderOtaProgress(0); });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    renderOtaProgress(total ? (int)(progress * 100 / total) : 0);
  });
  ArduinoOTA.onEnd([]() { renderConnecting("update done; rebooting"); });
  ArduinoOTA.onError([](ota_error_t) { renderError("OTA failed"); });
  ArduinoOTA.begin();
}

// Connect using the built-in WiFi credentials from wifi_secrets.h, if provided.
static bool connectWifiDirect() {
#ifdef WIFI_SSID
  renderConnecting("connecting WiFi...");
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Lower TX power to avoid brownout.
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
  Serial.printf("[wifi] connecting to '%s' ...\n", WIFI_SSID);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[wifi] connected, IP=");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.printf("[wifi] FAILED, status=%d\n", (int)WiFi.status());
  // Also surface the failure on the round screen (serial may be unavailable).
  // status: 1=SSID not found (often 5GHz), 4=connect failed, 6=wrong password.
  char msg[40];
  snprintf(msg, sizeof(msg), "WiFi fail: status %d", (int)WiFi.status());
  renderConnecting(msg);
  delay(3000);
  return false;
#else
  return false;
#endif
}

// Open the scrollable settings screen on demand (swipe down from the top).
// The config portal runs non-blocking so the screen stays interactive.
static void openWifiSettings() {
  g_settingsScroll = 0;
  g_settingsContentH = 0;
  g_settingsDragging = false;
  g_gestureActive = false;
  g_gestureSwiped = false;

  g_serverParam.setValue(g_serverUrlBuf, sizeof(g_serverUrlBuf) - 1);
  ensureParamAdded();
  wifiManager.setSaveParamsCallback(saveParamsCallback);
  wifiManager.setConfigPortalBlocking(false);
  wifiManager.setConfigPortalTimeout(0);
  wifiManager.setAPCallback([](WiFiManager*) {});
  wifiManager.startConfigPortal("ai-exams-setup");

  g_state = UiState::Settings;
}

// Close the settings screen (swipe up): persist changes, stop the portal, and
// return to normal operation.
static void closeWifiSettings() {
  if (g_shouldSaveParams) {
    String url = g_serverParam.getValue();
    url.trim();
    while (url.endsWith("/")) url.remove(url.length() - 1);
    if (url.length()) saveServerUrl(url);
    g_shouldSaveParams = false;
  }
  wifiManager.stopConfigPortal();
  WiFi.mode(WIFI_STA);
  setupWebSocket();
  g_state = UiState::Connecting;
}

// Drive the settings screen each loop: service the portal, handle drag-to-scroll
// and the swipe-up-to-close gesture, then render.
static void handleSettings() {
  wifiManager.process();

  int32_t x, y;
  const bool now = lcd.getTouch(&x, &y);
  if (now) {
    if (!g_settingsDragging) {
      g_settingsDragging = true;
      g_settingsDragStartY = y;
      g_settingsLastY = y;
    } else {
      g_settingsScroll -= (y - g_settingsLastY);  // drag to scroll the list
      g_settingsLastY = y;
    }
  } else if (g_settingsDragging) {
    g_settingsDragging = false;
    // Swipe up from the bottom edge closes the settings.
    if (g_settingsDragStartY > (int)H - 60 &&
        (g_settingsDragStartY - g_settingsLastY) > 80) {
      closeWifiSettings();
      return;
    }
  }

  // Clamp the scroll offset to the content bounds.
  const int maxScroll = (g_settingsContentH > (int)H) ? (g_settingsContentH - (int)H) : 0;
  if (g_settingsScroll < 0) g_settingsScroll = 0;
  if (g_settingsScroll > maxScroll) g_settingsScroll = maxScroll;

  renderSettings(g_settingsScroll);
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[boot] AI Image Interpreter display starting");

  lcd.init();
  lcd.setRotation(0);
  loadDisplayPrefs();
  lcd.setBrightness(g_dispBrightness);
  canvas.setColorDepth(16);
  canvas.createSprite(W, H);

  renderConnecting("starting...");

  loadServerUrl();

  // Hold a touch during boot to force the setup portal (and wipe saved WiFi).
  delay(150);
  const bool forcePortal = touchPressed();
  if (forcePortal) {
    wifiManager.resetSettings();
  }

  // Fast path: try the built-in WiFi credentials first (no portal needed).
  bool connected = false;
  if (!forcePortal) {
    connected = connectWifiDirect();
  }
  // Fall back to the captive portal, which shows a QR to join the device.
  if (!connected) {
    runProvisioning(true);
  }

#ifdef WIFI_SSID
  // Built-in WiFi credentials imply a built-in backend URL: keep them in sync
  // (overrides any stale value saved in NVS).
  if (connected && g_serverUrl != DEFAULT_BACKEND_URL) {
    saveServerUrl(DEFAULT_BACKEND_URL);
  }
#endif

  // Ensure a backend URL exists even when the portal was skipped.
  if (g_serverUrl.isEmpty()) {
    saveServerUrl(DEFAULT_BACKEND_URL);
  }

  setupOTA();
  setupWebSocket();

  renderConnecting("connecting...");
  g_state = UiState::Connecting;
}

void loop() {
  // The settings screen runs its own non-blocking portal + touch handling.
  if (g_state == UiState::Settings) {
    handleSettings();
    delay(10);
    return;
  }

  // Keep WiFi alive.
  if (WiFi.status() != WL_CONNECTED) {
    g_state = UiState::Connecting;
    renderConnecting("reconnecting...");
    WiFi.reconnect();
    delay(500);
    return;
  }

  // Service OTA update requests (PlatformIO espota / Arduino IDE network port).
  ArduinoOTA.handle();
  g_ws.loop();

  // A firmware OTA was pushed from the settings page: download + flash now (blocking).
  if (g_otaRequested) {
    g_otaRequested = false;
    performHttpOta(g_otaUrl);
    return;
  }

  bool tapped = false;
  bool swipeDown = false;
  pollGestures(&tapped, &swipeDown);
  if (swipeDown) {
    openWifiSettings();
    return;
  }

  switch (g_state) {
    case UiState::Connecting:
      renderConnecting("connecting...");
      break;

    case UiState::Idle:
      renderIdle();
      if (tapped) {
        if (tapInCaseButton()) {
          enterCaseStudy();
        } else if (tapInLowerHalf() && wsTrigger()) {
          g_triggerAt = millis();
          g_state = UiState::Solving;
        } else if (tapInLowerHalf()) {
          g_errorMsg = "no link";
          g_state = UiState::Error;
        }
      }
      break;

    case UiState::Solving:
      renderSolving();
      if (millis() - g_triggerAt > SOLVE_TIMEOUT_MS) {
        g_errorMsg = "timed out";
        g_state = UiState::Error;
      }
      break;

    case UiState::Answer:
      renderAnswer();
      if (tapped) {
        if (tapInCaseButton()) {  // top button → case-study mode
          enterCaseStudy();
        } else if (tapInLowerHalf() && wsTrigger()) {  // lower half → solve next
          g_triggerAt = millis();
          g_state = UiState::Solving;
        } else if (tapInLowerHalf()) {
          g_errorMsg = "no link";
          g_state = UiState::Error;
        }
      }
      break;

    case UiState::CaseStudy:
      // Time out a capture / solve that never got a result back.
      if (g_caseCapturing && millis() - g_caseCaptureAt > CASE_CAPTURE_TIMEOUT_MS) {
        g_caseCapturing = false;
        g_caseLastOk = false;
        g_caseFlashAt = millis();
      }
      if (g_caseSolving && millis() - g_triggerAt > SOLVE_TIMEOUT_MS) {
        g_caseSolving = false;
        g_caseLastOk = false;
        g_caseFlashAt = millis();
      }
      renderCaseStudy();
      if (tapped) {
        if (tapCaseSwitch()) {
          g_casePage ^= 1;  // toggle capture <-> solve
          g_caseFlashAt = 0;
        } else if (tapCaseExit()) {
          wsCaseExit();     // clear the cached scenarios on the browser
          g_state = UiState::Idle;
        } else if (g_casePage == 0) {
          if (!g_caseCapturing && wsCaptureScenario()) {
            g_caseCapturing = true;
            g_caseCaptureAt = millis();
          } else if (!g_caseCapturing) {
            g_caseLastOk = false;
            g_caseFlashAt = millis();
          }
        } else {  // solve page
          if (!g_caseSolving && wsTrigger()) {
            g_caseSolving = true;
            g_triggerAt = millis();
          } else if (!g_caseSolving) {
            g_caseLastOk = false;
            g_caseFlashAt = millis();
          }
        }
      }
      break;

    case UiState::Error:
      renderError(g_errorMsg.length() ? g_errorMsg.c_str() : "unknown");
      if (tapped) g_state = UiState::Idle;
      break;

    default:
      g_state = UiState::Idle;
      break;
  }

  delay(10);
}
