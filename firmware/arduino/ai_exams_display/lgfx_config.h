// LovyanGFX device configuration for the Waveshare ESP32-S3-Touch-LCD-1.28.
//
// Round 1.28" 240x240 panel using the GC9A01 controller over SPI, plus a
// CST816S capacitive touch controller on I2C. Pin assignments below match the
// Waveshare wiki for this exact board. If you use a different round display
// board, adjust the GPIOs here only.

#pragma once

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_GC9A01   _panel;
  lgfx::Bus_SPI        _bus;
  lgfx::Light_PWM      _light;
  lgfx::Touch_CST816S  _touch;

 public:
  LGFX() {
    {  // SPI bus -> GC9A01
      auto cfg = _bus.config();
      cfg.spi_host   = SPI2_HOST;
      cfg.spi_mode   = 0;
      cfg.freq_write = 40000000;
      cfg.freq_read  = 16000000;
      cfg.spi_3wire  = true;
      cfg.use_lock   = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk = 10;  // LCD SCL
      cfg.pin_mosi = 11;  // LCD SDA
      cfg.pin_miso = -1;  // not used
      cfg.pin_dc   = 8;   // LCD DC
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }

    {  // Panel
      auto cfg = _panel.config();
      cfg.pin_cs    = 9;
      cfg.pin_rst   = 14;
      cfg.pin_busy  = -1;
      cfg.panel_width   = 240;
      cfg.panel_height  = 240;
      cfg.offset_x      = 0;
      cfg.offset_y      = 0;
      cfg.offset_rotation = 0;
      cfg.readable      = false;
      cfg.invert        = true;
      cfg.rgb_order     = false;
      cfg.dlen_16bit    = false;
      cfg.bus_shared    = false;
      _panel.config(cfg);
    }

    {  // Backlight
      auto cfg = _light.config();
      cfg.pin_bl      = 2;
      cfg.invert      = false;
      cfg.freq        = 12000;
      cfg.pwm_channel = 7;
      _light.config(cfg);
      _panel.setLight(&_light);
    }

    {  // CST816S touch over I2C
      auto cfg = _touch.config();
      cfg.x_min = 0;
      cfg.x_max = 239;
      cfg.y_min = 0;
      cfg.y_max = 239;
      cfg.pin_int  = 5;
      cfg.pin_rst  = 13;
      cfg.bus_shared = false;
      cfg.offset_rotation = 0;
      cfg.i2c_port = 0;
      cfg.i2c_addr = 0x15;
      cfg.pin_sda  = 6;
      cfg.pin_scl  = 7;
      cfg.freq     = 400000;
      _touch.config(cfg);
      _panel.setTouch(&_touch);
    }

    setPanel(&_panel);
  }
};
