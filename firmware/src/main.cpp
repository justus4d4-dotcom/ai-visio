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
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>

#include "lgfx_config.h"

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
static LGFX lcd;
static LGFX_Sprite canvas(&lcd);  // full-screen off-screen buffer (flicker-free)
static Preferences prefs;
static WiFiManager wifiManager;

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
static uint32_t g_lastPollAt = 0;
static const uint32_t POLL_INTERVAL_MS = 400;
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

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
static bool httpGet(const String& url, String& out) {
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(4000);
  if (!http.begin(url)) return false;
  const int code = http.GET();
  bool ok = false;
  if (code == HTTP_CODE_OK) {
    out = http.getString();
    ok = true;
  }
  http.end();
  return ok;
}

static bool httpPost(const String& url, const String& body, String& out) {
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(4000);
  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  const int code = http.POST(body);
  bool ok = false;
  if (code == HTTP_CODE_OK) {
    out = http.getString();
    ok = true;
  }
  http.end();
  return ok;
}

// Read the current answer_id so a stale answer is not shown after boot.
static void primeBaselineAnswerId() {
  String body;
  if (httpGet(g_serverUrl + "/api/remote/answer", body)) {
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      const char* aid = doc["answer_id"] | "";
      g_lastAnswerId = String(aid);
    }
  }
}

static bool sendTrigger() {
  String out;
  if (!httpPost(g_serverUrl + "/api/remote/trigger", "{}", out)) return false;
  return true;
}

// Poll the bridge; updates state if a fresh answer or error arrives.
static void pollAnswer() {
  String body;
  if (!httpGet(g_serverUrl + "/api/remote/answer", body)) return;

  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok) return;

  const char* status = doc["status"] | "idle";
  const char* answerId = doc["answer_id"] | "";

  if (strcmp(status, "error") == 0) {
    g_errorMsg = "solve failed";
    g_state = UiState::Error;
    return;
  }

  // A genuinely new, completed answer.
  if (strcmp(status, "done") == 0 && strlen(answerId) > 0 &&
      String(answerId) != g_lastAnswerId) {
    JsonObject a = doc["answer"].as<JsonObject>();
    if (!a.isNull()) {
      // Join answer_letters into a display string.
      String letters;
      JsonArray arr = a["answer_letters"].as<JsonArray>();
      for (JsonVariant v : arr) {
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
  }
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
    renderConnecting("setup: join WiFi 'ai-exams-setup'");
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

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);

  lcd.init();
  lcd.setRotation(0);
  lcd.setBrightness(200);
  canvas.setColorDepth(16);
  canvas.createSprite(W, H);

  renderConnecting("starting...");

  loadServerUrl();

  // Hold a touch during boot to wipe settings and re-provision.
  delay(150);
  const bool forcePortal = touchPressed() || g_serverUrl.isEmpty();
  if (forcePortal && touchPressed()) {
    wifiManager.resetSettings();
  }

  runProvisioning(forcePortal);

  renderConnecting("ready");
  primeBaselineAnswerId();
  g_state = UiState::Idle;
}

void loop() {
  // Keep WiFi alive.
  if (WiFi.status() != WL_CONNECTED) {
    g_state = UiState::Connecting;
    renderConnecting("reconnecting...");
    WiFi.reconnect();
    delay(500);
    if (WiFi.status() == WL_CONNECTED) g_state = UiState::Idle;
    return;
  }

  const bool tapped = touchTapped();

  switch (g_state) {
    case UiState::Idle:
      renderIdle();
      if (tapped) {
        if (sendTrigger()) {
          g_triggerAt = millis();
          g_lastPollAt = 0;
          g_state = UiState::Solving;
        } else {
          g_errorMsg = "no backend";
          g_state = UiState::Error;
        }
      }
      break;

    case UiState::Solving:
      renderSolving();
      if (millis() - g_lastPollAt >= POLL_INTERVAL_MS) {
        g_lastPollAt = millis();
        pollAnswer();
      }
      if (g_state == UiState::Solving && millis() - g_triggerAt > SOLVE_TIMEOUT_MS) {
        g_errorMsg = "timed out";
        g_state = UiState::Error;
      }
      break;

    case UiState::Answer:
      renderAnswer();
      if (tapped) {  // tap again to solve the next question
        if (sendTrigger()) {
          g_triggerAt = millis();
          g_lastPollAt = 0;
          g_state = UiState::Solving;
        } else {
          g_errorMsg = "no backend";
          g_state = UiState::Error;
        }
      }
      break;

    case UiState::Error:
      renderError(g_errorMsg.length() ? g_errorMsg.c_str() : "unknown");
      if (tapped) g_state = UiState::Idle;
      break;

    case UiState::Connecting:
    default:
      g_state = UiState::Idle;
      break;
  }

  delay(10);
}
