// Arduino IDE entry point for the maintained PlatformIO firmware.
//
// Keeping one implementation prevents the Arduino and PlatformIO distributions
// from silently diverging. The included source resolves its local hardware
// configuration from firmware/src/lgfx_config.h.
#define SCREEN_WIDTH 240
#define SCREEN_HEIGHT 240
#include "../../src/main.cpp"
