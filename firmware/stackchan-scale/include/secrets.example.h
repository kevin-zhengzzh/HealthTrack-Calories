// Copy this file to secrets.h (git-ignored) and fill in your values.
#pragma once

#define WIFI_SSID     "your-wifi"
#define WIFI_PASSWORD "your-password"

// Backend base URL, no trailing slash. For a backend running on your PC,
// use the PC's LAN IP (not localhost) and start it with --urls http://0.0.0.0:5000
#define API_BASE_URL  "http://192.168.1.10:5000"

// From the web app: Food Log > Devices > Pair device (shown once)
#define DEVICE_KEY    "hk_paste-your-key-here"

// POSIX TZ string so meals are filed under your local date
// New Zealand: "NZST-12NZDT,M9.5.0,M4.1.0/3"   China: "CST-8"
#define TIMEZONE      "NZST-12NZDT,M9.5.0,M4.1.0/3"
