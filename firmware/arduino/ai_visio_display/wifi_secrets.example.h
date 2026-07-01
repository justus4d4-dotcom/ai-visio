#pragma once
// Copy this file to wifi_secrets.h and fill in your details so the device
// auto-connects to your WiFi without showing the setup portal/QR.
//
// If wifi_secrets.h is absent, the firmware falls back to the on-device setup
// portal (scan the QR to join "ai-exams-setup" and configure WiFi there).
#define WIFI_SSID "your-wifi-ssid"
#define WIFI_PASSWORD "your-wifi-password"

// Backend base URL used if none has been provisioned via the portal yet.
#define DEFAULT_BACKEND_URL "http://192.0.2.10:8000"
