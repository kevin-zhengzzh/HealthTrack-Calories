// OPTIONAL. The firmware builds and works without this file:
//   - Wi-Fi is set up from a phone (Stack-chan shows a QR code on first boot,
//     or Settings > Wi-Fi later)
//   - the device key comes from pairing (Stack-chan shows a 6-digit code;
//     enter it on the website: Food Log > Add device)
//
// Copy to secrets.h (git-ignored) only to override defaults during
// development. WIFI_* and DEVICE_KEY are copied into the device's storage
// once, on the first boot that has none saved; after that the saved values
// win, so changing them here has no effect (use Wi-Fi > Reset on the device).
#pragma once

// Backend base URL, no trailing slash. Default: the production backend.
// #define API_BASE_URL  "http://192.168.1.10:5000"

// POSIX TZ string so meals are filed under your local date. Default: New Zealand.
// China: "CST-8"
// #define TIMEZONE      "NZST-12NZDT,M9.5.0,M4.1.0/3"

// Seed values for first boot (development only)
// #define WIFI_SSID     "your-wifi"
// #define WIFI_PASSWORD "your-password"
// #define DEVICE_KEY    "hk_..."
