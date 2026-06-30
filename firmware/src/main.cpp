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

// Device-side state machine.
enum class UiState { Connecting, Idle, Solving, Answer, Error };
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

// Touch edge detection.
static bool g_wasTouched = false;
static uint32_t g_lastTouchAt = 0;
static const uint32_t TOUCH_DEBOUNCE_MS = 250;

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
  canvas.drawString("ai-exams", CX, CY - 18);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.setTextSize(1);
  canvas.drawString(line, CX, CY + 14);
  canvas.pushSprite(0, 0);
}

static void renderIdle() {
  canvas.fillScreen(COL_BG);
  canvas.fillArc(CX, CY, CX - 6, CX - 2, 0, 360, COL_MUTED);
  canvas.setTextDatum(textdatum_t::middle_center);
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(2);
  canvas.drawString("Tap to", CX, CY - 22);
  canvas.drawString("solve", CX, CY + 4);
  canvas.setTextColor(COL_MUTED, COL_BG);
  canvas.setTextSize(1);
  canvas.drawString(WiFi.localIP().toString().c_str(), CX, CY + 40);
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

static void renderAnswer() {
  canvas.fillScreen(COL_BG);
  drawConfidenceRing(g_answer.confidence);

  canvas.setTextDatum(textdatum_t::middle_center);

  // Big answer letters in the centre. Scale font down if many letters.
  const char* letters = g_answer.letters.length() ? g_answer.letters.c_str() : "?";
  int size = 7;
  if (g_answer.letters.length() > 4) size = 5;
  if (g_answer.letters.length() > 7) size = 3;
  canvas.setTextColor(COL_TEXT, COL_BG);
  canvas.setTextSize(size);
  canvas.drawString(letters, CX, CY - 18);

  // Short answer text below, wrapped to fit the round area.
  canvas.setTextSize(1);
  canvas.setTextColor(COL_MUTED, COL_BG);
  String t = g_answer.text;
  if (t.length() > 42) t = t.substring(0, 41) + "...";
  canvas.drawString(t.c_str(), CX, CY + 34);

  // Cached marker.
  if (g_answer.cached) {
    canvas.setTextColor(COL_ACCENT, COL_BG);
    canvas.drawString("cached", CX, CY + 52);
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
  g_state = UiState::Answer;
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

  if (strcmp(status, "error") == 0) {
    g_errorMsg = "solve failed";
    g_state = UiState::Error;
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

// ---------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------
static bool touchPressed() {
  int32_t x, y;
  return lcd.getTouch(&x, &y);
}

// Returns true once per fresh press (debounced rising edge).
static bool touchTapped() {
  const bool now = touchPressed();
  bool tapped = false;
  if (now && !g_wasTouched && (millis() - g_lastTouchAt) > TOUCH_DEBOUNCE_MS) {
    tapped = true;
    g_lastTouchAt = millis();
  }
  g_wasTouched = now;
  return tapped;
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

static void runProvisioning(bool forcePortal) {
  WiFiManagerParameter serverParam(
      "server", "Backend base URL", g_serverUrlBuf, sizeof(g_serverUrlBuf) - 1);
  wifiManager.addParameter(&serverParam);
  wifiManager.setSaveParamsCallback(saveParamsCallback);
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
    String url = serverParam.getValue();
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
  // Lower TX power to avoid brownout resets on weakly-powered boards.
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
  return false;
#else
  return false;
#endif
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
  lcd.setBrightness(200);
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

  const bool tapped = touchTapped();

  switch (g_state) {
    case UiState::Connecting:
      renderConnecting("connecting...");
      break;

    case UiState::Idle:
      renderIdle();
      if (tapped) {
        if (wsTrigger()) {
          g_triggerAt = millis();
          g_state = UiState::Solving;
        } else {
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
      if (tapped) {  // tap again to solve the next question
        if (wsTrigger()) {
          g_triggerAt = millis();
          g_state = UiState::Solving;
        } else {
          g_errorMsg = "no link";
          g_state = UiState::Error;
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
