// Stack-chan food scale for HealthTrack.
//
// Flow:
//   1. Put the empty plate/bowl on the Mini Scales. It is zeroed automatically
//      once the reading settles after power-on; tap TARE on screen (or the
//      scale's own button) to zero it again.
//   2. Put the food on. When the weight is above MIN_FOOD_GRAMS and stays
//      steady for STABLE_MS, Stack-chan takes a 640x480 photo and uploads it
//      with the weight to POST /api/intake/device.
//   3. The result stays on screen until the food is taken off the scale.
//
// Screen: the full 4:3 camera frame scaled to 240x180 on the left, weight /
// status / TARE in the 80px column on the right, messages below the image.
//
// The camera's SCCB bus is the CoreS3's internal I2C, shared with touch and
// the power chip. The camera only needs it during init, so the bus is handed
// back to M5Unified afterwards to make touch work.

#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "esp_camera.h"
#include "driver/i2c.h"
#include "img_converters.h"
#include <Preferences.h>
#include "UNIT_SCALES.h"
#include "head.h"
#include "netsetup.h"

// Wi-Fi and the device key are set up on the device itself now (phone setup
// portal + pairing code). secrets.h is optional: API_BASE_URL / TIMEZONE
// override the defaults below, and WIFI_SSID / DEVICE_KEY, if present, are
// copied into NVS once on first boot (handy during development).
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef API_BASE_URL
#define API_BASE_URL "https://healthtrack-backend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io"
#endif
#ifndef TIMEZONE
#define TIMEZONE "NZST-12NZDT,M9.5.0,M4.1.0/3"
#endif

// ---- Tuning ----
static constexpr float MIN_FOOD_GRAMS   = 5.0f;   // below this the scale counts as empty
static constexpr float EMPTY_GRAMS      = 5.0f;   // food is "taken off" below this
static constexpr uint32_t RESULT_PHOTO_MS = 3000; // show the uploaded photo this long, then live view
static constexpr float STABLE_BAND      = 1.0f;   // max wobble (g) while counting as steady
static constexpr uint32_t STABLE_MS     = 1500;   // steady this long before taking the photo
static constexpr int JPEG_QUALITY       = 80;     // 0-100; ~40-70KB at 640x480
static constexpr uint32_t HTTP_TIMEOUT  = 30000;  // recognition can take a while once enabled

// Port A on CoreS3
static constexpr int SCALE_SDA = 2;
static constexpr int SCALE_SCL = 1;

static constexpr int CAM_W = 640, CAM_H = 480;
static constexpr int LCD_W = 320, LCD_H = 240;

// Layout: full frame at 3/8 scale keeps the 4:3 ratio (no crop)
static constexpr int PREV_W = 240, PREV_H = 180;
static constexpr int PANEL_X = PREV_W;                 // right column, 80px
static constexpr int PANEL_W = LCD_W - PREV_W;
static constexpr int MSG_Y = PREV_H;                   // strip under the image, 60px
static constexpr int TARE_X = PANEL_X + 6, TARE_Y = MSG_Y + 6, TARE_W = PANEL_W - 12, TARE_H = 48;
static constexpr int GEAR_X = TARE_X, GEAR_Y = TARE_Y - 46, GEAR_W = TARE_W, GEAR_H = 38;

// Settings screen (gear): brightness in the strip under the image, head
// control and power in the right column, live camera view kept for aiming
struct Rect { int x, y, w, h; };
static constexpr Rect BTN_DONE  = {PANEL_X + 6, 6, PANEL_W - 12, 34};
static constexpr Rect BTN_WIFI  = {PANEL_X + 6, 46, PANEL_W - 12, 34};
static constexpr Rect BTN_CENTER = {PANEL_X + 6, 142, PANEL_W - 12, 34};
// On-device Wi-Fi: network list (4 rows per page), keyboard, connecting
static constexpr int WL_ROW_Y = 32, WL_ROW_H = 38, WL_ROWS = 4;
static constexpr Rect BTN_WL_UP    = {LCD_W - 40, 32, 34, 72};
static constexpr Rect BTN_WL_DOWN  = {LCD_W - 40, 110, 34, 72};
static constexpr Rect BTN_WL_RESCAN = {4, LCD_H - 42, 74, 38};
static constexpr Rect BTN_WL_PHONE  = {82, LCD_H - 42, 74, 38};
static constexpr Rect BTN_WL_RESET  = {160, LCD_H - 42, 74, 38};
static constexpr Rect BTN_WL_EXIT   = {238, LCD_H - 42, 78, 38};
static constexpr int KB_Y = 62, KB_KEY_H = 42;   // keyboard rows at 62, 106, 150, 194
static constexpr Rect BTN_JOIN_RETYPE = {4, LCD_H - 46, 100, 40};
static constexpr Rect BTN_JOIN_SAVE   = {110, LCD_H - 46, 100, 40};
static constexpr Rect BTN_JOIN_BACK   = {216, LCD_H - 46, 100, 40};
// Phone-portal screen and pairing screen
static constexpr Rect BTN_SETUP_EXIT  = {LCD_W - 80, LCD_H - 42, 74, 36};
static constexpr Rect BTN_SETUP_RESET = {LCD_W - 160, LCD_H - 42, 74, 36};
static constexpr Rect BTN_PAIR_WIFI   = {LCD_W - 80, LCD_H - 42, 74, 36};
static constexpr Rect BTN_POWER = {PANEL_X + 6, MSG_Y + 6, PANEL_W - 12, 48};
// Aim joystick on the main screen: tap the camera view to show it in the
// middle, drag the knob to turn the head (further = faster), let go to stop.
static constexpr Rect PREVIEW_AREA = {0, 0, PREV_W, PREV_H};
static constexpr int JOY_X = PREV_W / 2, JOY_Y = PREV_H / 2;
static constexpr int JOY_BASE_R = 56;          // translucent base
static constexpr int JOY_KNOB_R = 22;
static constexpr int JOY_KNOB_TRAVEL = JOY_BASE_R - JOY_KNOB_R;  // how far the knob is drawn from centre
static constexpr int JOY_INPUT_R = 60;         // finger distance that means full speed
static constexpr int JOY_DEADZONE = 8;         // px; smaller drags do nothing
static constexpr int JOY_MAX_SPEED = 30;       // tenths of a degree per update at full deflection
static constexpr uint32_t JOY_UPDATE_MS = 60;  // servo command rate while dragging
static constexpr uint32_t AIM_HIDE_MS = 5000;  // hide after this long untouched
static constexpr uint16_t BTN_GREY = 0x39E7;   // same as the gear button
static constexpr uint8_t JOY_BASE_ALPHA = 110; // 0..255 opacity
static constexpr uint8_t JOY_KNOB_ALPHA = 200;
static constexpr Rect BTN_DIM   = {70, MSG_Y + 6, 48, 48};
static constexpr Rect BTN_BRIGHT = {184, MSG_Y + 6, 48, 48};
static constexpr int HOME_PITCH = head::PITCH_MIN;  // Home = facing forward, lowest tilt (also the first-boot pose)
static constexpr int BRIGHT_STEP = 25, BRIGHT_MIN = 10, BRIGHT_MAX = 255;

// Scale zeroing
static constexpr float ZERO_BAND        = 0.5f;   // reading must stay within this (g)...
static constexpr uint32_t ZERO_STABLE_MS = 2000;  // ...for this long before zeroing
static constexpr uint32_t ZERO_TIMEOUT_MS = 10000; // zero anyway after this
static constexpr float TRACK_MAX_GRAMS  = 2.0f;   // empty-scale drift below this is auto-corrected
static constexpr uint32_t TRACK_MS      = 5000;

// CoreS3 GC0308 wiring, from M5Stack's StackChan camera example
static camera_config_t cameraConfig = {
    .pin_pwdn     = -1,
    .pin_reset    = -1,
    .pin_xclk     = -1,
    .pin_sscb_sda = 12,
    .pin_sscb_scl = 11,
    .pin_d7 = 47, .pin_d6 = 48, .pin_d5 = 16, .pin_d4 = 15,
    .pin_d3 = 42, .pin_d2 = 41, .pin_d1 = 40, .pin_d0 = 39,
    .pin_vsync = 46,
    .pin_href  = 38,
    .pin_pclk  = 45,
    // 10MHz, not 20: at 640x480 RGB565 (600KB/frame) 20MHz overruns the
    // PSRAM DMA and the driver logs EV-EOF-OVF / drops frames
    .xclk_freq_hz = 10000000,
    .ledc_timer   = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_RGB565,  // GC0308 has no hardware JPEG
    .frame_size   = FRAMESIZE_VGA,     // 640x480, the sensor's maximum
    .jpeg_quality = 0,
    .fb_count     = 2,
    .fb_location  = CAMERA_FB_IN_PSRAM,
    .grab_mode    = CAMERA_GRAB_LATEST, // always the newest frame, never a stale one
    .sccb_i2c_port = -1,
};

// What the device as a whole is doing. Normal = the weighing state machine below.
enum class Mode { Normal, WifiSetup, Pairing };
static Mode mode = Mode::Normal;

// Device key from pairing, stored in NVS namespace "dev"
static String deviceKey;
static String ownerName;  // account this device logs meals to (from pairing)

// On-device Wi-Fi setup
enum class WifiScreen { List, Password, Joining, Phone };
static WifiScreen wifiScreen = WifiScreen::List;
static std::vector<net::Network> wifiList;
static bool wifiScanning = false;
static int wifiPage = 0;
static String chosenSsid, typedPass, kbNote;
static int kbLayer = 0;                 // 0 lower, 1 upper, 2 digits & symbols
static net::JoinState joinResult = net::JoinState::Trying;
static uint32_t joinShownAt = 0;
static constexpr uint32_t JOIN_TIMEOUT_MS = 20000;

static void enterWifiSetup();  // defined with the Wi-Fi setup screens

// Pairing-code flow
static String pairCode, pairToken, pairMsg;
static uint32_t pairExpiresAt = 0, nextPairPoll = 0;
static uint32_t resetArmedUntil = 0;

enum class State { Idle, Settling, Uploading, Result, Error };
// Steps inside State::Uploading, shown on screen
enum class UploadPhase { Photo, Sending, Recognizing };

static UNIT_SCALES scales;
static M5Canvas canvas(&M5.Display);
static uint16_t* preview = nullptr;  // PREV_W x PREV_H downscaled camera frame
static bool touchOk = false;

// Settings, persisted in NVS namespace "hts"
static Preferences prefs;
static bool settingsOpen = false;
static int brightness = 160;
static int headYaw = 0, headPitch = head::PITCH_MIN;
static uint32_t powerArmedUntil = 0;  // power-off needs a second tap within 3s
static bool aimVisible = false;
static uint32_t aimLastTap = 0;
static int savedYaw = 0, savedPitch = 0;  // what's in NVS, to skip needless writes

static bool headGliding = false;  // Center's eased move in progress
static bool atHome() { return headYaw == 0 && headPitch == HOME_PITCH; }

// "12.5" from tenths of a degree, so small offsets are visible
// (not named degrees(): Arduino defines that as a macro)
static String fmtTenths(int tenths) {
    return String(tenths / 10.0f, 1);
}

// Touch state, read once per loop()
static bool tapNow = false;          // finger just went down
static bool touchHeld = false;       // finger is down
static int tapX = 0, tapY = 0;       // current position
static bool dragging = false;        // this touch started on the joystick
static int joyDx = 0, joyDy = 0;     // knob offset from centre, for drawing
static uint32_t lastJoyMove = 0;
static bool tapped(const Rect& r) {
    return tapNow && tapX >= r.x && tapX < r.x + r.w && tapY >= r.y && tapY < r.y + r.h;
}

static State state = State::Idle;
static float weight = 0;
static float settleRef = 0;
static uint32_t settleSince = 0;
static uint32_t resultSince = 0;     // when the current Result/Error began
static String line1, line2;        // result / error text
static float uploadedWeight = 0;
static UploadPhase uploadPhase = UploadPhase::Photo;
static int uploadPct = 0;
static bool cameraOk = false, scaleOk = false;

// ---------------------------------------------------------------- helpers

static uint32_t ledColor = 0x002000;

static void setLed(uint32_t rgb) {
    ledColor = rgb;
    if (scaleOk) scales.setLEDColor(rgb);
}

// I2C address probe: is the Mini Scales on Port A right now?
static bool scalePresent() {
    Wire.beginTransmission(DEVICE_DEFAULT_ADDR);
    return Wire.endTransmission() == 0;
}

// Hot-plug: checks the scale every SCALE_CHECK_MS so it can be plugged in or
// pulled out at any time. Only reads the weight while the probe succeeds —
// the library's getWeight() returns garbage when the read fails, which
// could otherwise look like food and trigger an upload.
static constexpr uint32_t SCALE_CHECK_MS = 500;
static uint32_t lastScaleCheck = 0;

// Zeroing waits for the reading to settle first: right after power-on (or a
// plug-in) the load cell is still drifting, and zeroing a moving reading
// leaves a wrong offset behind.
static bool zeroPending = false;
static float zeroRef = 0;
static uint32_t zeroSince = 0, zeroStarted = 0;
static uint32_t zeroedAt = 0;          // for the brief "Zeroed" message
static float trackRef = 0;
static uint32_t trackSince = 0;

static void requestZero() {
    zeroPending = true;
    zeroStarted = zeroSince = millis();
    zeroRef = weight;
}

static void updateScale() {
    if (millis() - lastScaleCheck >= SCALE_CHECK_MS) {
        lastScaleCheck = millis();
        bool present = scalePresent();
        if (present && !scaleOk) {
            Serial.println("Scale connected");
            scaleOk = true;
            scales.setLEDColor(ledColor);
            requestZero();
        } else if (!present && scaleOk) {
            Serial.println("Scale disconnected");
            scaleOk = false;
            zeroPending = false;
        }
    }
    if (!scaleOk) {
        weight = 0;
        return;
    }

    float w = scales.getWeight();
    // Max load is 5kg; anything outside a sane range is a bad read
    if (!(isfinite(w) && w > -1000.0f && w < 6000.0f)) return;
    weight = w;

    if (zeroPending) {
        if (fabsf(w - zeroRef) > ZERO_BAND) {
            zeroRef = w;                 // still moving: restart the wait
            zeroSince = millis();
        } else if (millis() - zeroSince >= ZERO_STABLE_MS || millis() - zeroStarted >= ZERO_TIMEOUT_MS) {
            scales.setOffset();
            zeroPending = false;
            zeroedAt = millis();
            trackSince = millis();
            Serial.printf("Scale zeroed (was %.2f g)\n", w);
        }
        return;
    }

    // Zero tracking: a small, steady non-zero reading on an idle scale is
    // drift, not food — quietly re-zero it.
    if (state == State::Idle && fabsf(w) < TRACK_MAX_GRAMS) {
        if (fabsf(w - trackRef) > 0.3f) {
            trackRef = w;
            trackSince = millis();
        } else if (fabsf(w) >= 0.2f && millis() - trackSince >= TRACK_MS) {
            scales.setOffset();
            trackSince = millis();
            Serial.printf("Zero tracking: corrected %.2f g drift\n", w);
        }
    } else {
        trackRef = w;
        trackSince = millis();
    }
}

static bool zeroing() { return scaleOk && zeroPending; }

// 640x480 -> 240x180 (3/8 scale, nearest neighbour): the whole frame, same ratio
static void downscale(const uint16_t* src) {
    for (int y = 0; y < PREV_H; y++) {
        const uint16_t* row = src + (y * CAM_H / PREV_H) * CAM_W;
        uint16_t* out = preview + y * PREV_W;
        for (int x = 0; x < PREV_W; x++) out[x] = row[x * CAM_W / PREV_W];
    }
}

static String formatWeight(float w) {
    if (fabsf(w) < 0.3f) w = 0;  // don't flicker between -0.1 and 0.1
    return String(w, 1);
}

static void drawPanel() {
    const int cx = PANEL_X + PANEL_W / 2;
    canvas.fillRect(PANEL_X, 0, PANEL_W, LCD_H, 0x10A2);

    // Wi-Fi
    bool online = WiFi.status() == WL_CONNECTED;
    canvas.fillCircle(PANEL_X + 12, 14, 5, online ? TFT_GREEN : TFT_RED);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(middle_left);
    canvas.setTextColor(online ? TFT_WHITE : TFT_RED);
    canvas.drawString(online ? "Online" : "Offline", PANEL_X + 22, 14);

    // Weight
    canvas.setTextDatum(middle_center);
    if (!scaleOk) {
        canvas.setTextColor(TFT_ORANGE);
        canvas.setFont(&fonts::Font2);
        canvas.drawString("No", cx, 70);
        canvas.drawString("scale", cx, 88);
    } else {
        String w = formatWeight(state == State::Uploading ? uploadedWeight : weight);
        canvas.setTextColor(zeroing() ? TFT_DARKGREY : TFT_WHITE);
        canvas.setFont(w.length() <= 6 ? &fonts::Font4 : &fonts::Font2);
        canvas.drawString(w, cx, 72);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("grams", cx, 98);
    }

    // Settings (gear)
    if (touchOk) {
        canvas.fillRoundRect(GEAR_X, GEAR_Y, GEAR_W, GEAR_H, 8, 0x39E7);
        int gx = GEAR_X + GEAR_W / 2, gy = GEAR_Y + GEAR_H / 2;
        for (int i = 0; i < 8; i++) {  // teeth
            float a = i * PI / 4;
            canvas.fillCircle(gx + cosf(a) * 10, gy + sinf(a) * 10, 3, TFT_WHITE);
        }
        canvas.fillCircle(gx, gy, 9, TFT_WHITE);
        canvas.fillCircle(gx, gy, 4, 0x39E7);
    }

    // Tare
    if (touchOk) {
        bool busy = zeroing();
        canvas.fillRoundRect(TARE_X, TARE_Y, TARE_W, TARE_H, 8, busy ? TFT_DARKGREY : 0x2C4A);
        canvas.setTextColor(TFT_WHITE);
        canvas.setFont(&fonts::Font2);
        canvas.drawString(busy ? "..." : "TARE", cx, TARE_Y + TARE_H / 2);
    } else {
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.setFont(&fonts::Font0);
        canvas.drawString("Tare: press", cx, TARE_Y + 16);
        canvas.drawString("scale button", cx, TARE_Y + 30);
    }
}

// Draws text inside a box of width w with the current font and colour.
// If it fits it's drawn normally; if not it scrolls like a marquee: hold
// at the start, slide left until the end is visible, hold, jump back.
// align: top_left, middle_left or middle_center (x is the box's left edge).
static constexpr uint32_t SCROLL_HOLD_MS = 1200;
static constexpr int SCROLL_PX_PER_S = 40;

static void drawFit(const String& s, int x, int y, int w, textdatum_t align) {
    int tw = canvas.textWidth(s);
    if (tw <= w) {
        canvas.setTextDatum(align);
        canvas.drawString(s, align == middle_center ? x + w / 2 : x, y);
        return;
    }
    int overflow = tw - w;
    uint32_t scrollMs = (uint32_t)overflow * 1000 / SCROLL_PX_PER_S;
    uint32_t t = millis() % (SCROLL_HOLD_MS * 2 + scrollMs);
    int off = t < SCROLL_HOLD_MS ? 0
            : t < SCROLL_HOLD_MS + scrollMs ? (int)((t - SCROLL_HOLD_MS) * SCROLL_PX_PER_S / 1000)
            : overflow;
    int fh = canvas.fontHeight();
    bool middle = align != top_left;
    canvas.setClipRect(x, middle ? y - fh / 2 : y, w, fh + 1);
    canvas.setTextDatum(middle ? middle_left : top_left);
    canvas.drawString(s, x - off, y);
    canvas.clearClipRect();
}

static void drawMessage(const String& head, uint16_t headColor, const String& sub) {
    canvas.fillRect(0, MSG_Y, PREV_W, LCD_H - MSG_Y, 0x18E3);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(headColor);
    drawFit(head, 8, MSG_Y + 6, PREV_W - 16, top_left);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(TFT_WHITE);
    drawFit(sub, 8, MSG_Y + 36, PREV_W - 16, top_left);
}

static void drawButton(const Rect& r, const char* label, uint16_t bg, bool enabled = true) {
    canvas.fillRoundRect(r.x, r.y, r.w, r.h, 8, enabled ? bg : (uint16_t)0x4208);
    canvas.setTextDatum(middle_center);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(enabled ? TFT_WHITE : TFT_DARKGREY);
    canvas.drawString(label, r.x + r.w / 2, r.y + r.h / 2);
}

// Translucent rounded rectangle, blended straight into the canvas buffer
// (M5GFX has no alpha fill for rounded shapes). The 16-bit canvas stores
// RGB565 byte-swapped, so pixels are swapped on the way in and out.
static void fillRoundRectAlpha(const Rect& r, int radius, uint16_t color, uint8_t alpha) {
    auto* buf = (uint16_t*)canvas.getBuffer();
    const int cr = (color >> 11) & 0x1F, cg = (color >> 5) & 0x3F, cb = color & 0x1F;
    const int a = alpha, ia = 256 - alpha;
    for (int y = r.y; y < r.y + r.h; y++) {
        if (y < 0 || y >= LCD_H) continue;
        for (int x = r.x; x < r.x + r.w; x++) {
            if (x < 0 || x >= LCD_W) continue;
            // Skip pixels outside the rounded corners
            int dx = x < r.x + radius ? r.x + radius - x : (x >= r.x + r.w - radius ? x - (r.x + r.w - radius - 1) : 0);
            int dy = y < r.y + radius ? r.y + radius - y : (y >= r.y + r.h - radius ? y - (r.y + r.h - radius - 1) : 0);
            if (dx && dy && dx * dx + dy * dy > radius * radius) continue;

            uint16_t v = buf[y * LCD_W + x];
            v = (v >> 8) | (v << 8);
            int pr = (((v >> 11) & 0x1F) * ia + cr * a) >> 8;
            int pg = (((v >> 5) & 0x3F) * ia + cg * a) >> 8;
            int pb = ((v & 0x1F) * ia + cb * a) >> 8;
            v = (pr << 11) | (pg << 5) | pb;
            buf[y * LCD_W + x] = (v >> 8) | (v << 8);
        }
    }
}

// A circle is a rounded rect whose radius is half its size
static void fillCircleAlpha(int cx, int cy, int r, uint16_t color, uint8_t alpha) {
    fillRoundRectAlpha({cx - r, cy - r, 2 * r + 1, 2 * r + 1}, r, color, alpha);
}

// Translucent base with small direction marks, and the knob at its offset
static void drawJoystick() {
    fillCircleAlpha(JOY_X, JOY_Y, JOY_BASE_R, BTN_GREY, JOY_BASE_ALPHA);
    canvas.drawCircle(JOY_X, JOY_Y, JOY_BASE_R, 0xBDF7);
    const int m = JOY_BASE_R - 9, s = 5;
    uint16_t c = 0xDEFB;
    canvas.fillTriangle(JOY_X, JOY_Y - m - s, JOY_X - s, JOY_Y - m + s, JOY_X + s, JOY_Y - m + s, c);
    canvas.fillTriangle(JOY_X, JOY_Y + m + s, JOY_X - s, JOY_Y + m - s, JOY_X + s, JOY_Y + m - s, c);
    canvas.fillTriangle(JOY_X - m - s, JOY_Y, JOY_X - m + s, JOY_Y - s, JOY_X - m + s, JOY_Y + s, c);
    canvas.fillTriangle(JOY_X + m + s, JOY_Y, JOY_X + m - s, JOY_Y - s, JOY_X + m - s, JOY_Y + s, c);

    int kx = JOY_X + joyDx, ky = JOY_Y + joyDy;
    fillCircleAlpha(kx, ky, JOY_KNOB_R, TFT_WHITE, JOY_KNOB_ALPHA);
    canvas.drawCircle(kx, ky, JOY_KNOB_R, TFT_WHITE);
}

// Whose account meals go to: a translucent tag in the image's top-left corner
static void drawAccountTag() {
    if (ownerName.isEmpty()) return;
    canvas.setFont(&fonts::Font2);
    const int x = 6, y = 6, h = 22;
    int tw = min((int)canvas.textWidth(ownerName), PREV_W / 2);
    fillRoundRectAlpha({x, y, tw + 32, h}, h / 2, TFT_BLACK, 150);
    // Person icon
    canvas.fillCircle(x + 13, y + 8, 4, TFT_LIGHTGREY);
    canvas.fillRoundRect(x + 7, y + 13, 13, 7, 3, TFT_LIGHTGREY);
    canvas.setTextColor(TFT_WHITE);
    drawFit(ownerName, x + 24, y + h / 2, tw, middle_left);
}

static void drawSettings() {
    // Brightness row under the image
    canvas.fillRect(0, MSG_Y, PREV_W, LCD_H - MSG_Y, 0x18E3);
    canvas.setTextDatum(middle_left);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString("Light", 10, MSG_Y + 30);
    drawButton(BTN_DIM, "-", 0x2C4A, brightness > BRIGHT_MIN);
    drawButton(BTN_BRIGHT, "+", 0x2C4A, brightness < BRIGHT_MAX);
    canvas.setTextDatum(middle_center);
    canvas.setFont(&fonts::Font4);
    canvas.drawString(String(brightness * 100 / 255) + "%", 151, MSG_Y + 30);

    bool h = head::ok();

    // Right column: done, Wi-Fi, head angles, home, power
    const int cx = PANEL_X + PANEL_W / 2;
    canvas.fillRect(PANEL_X, 0, PANEL_W, LCD_H, 0x10A2);
    drawButton(BTN_DONE, "Done", 0x2C4A);
    drawButton(BTN_WIFI, "Wi-Fi", 0x2C4A);
    canvas.setTextDatum(middle_center);
    canvas.setFont(&fonts::Font0);
    if (h) {
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("HEAD", cx, 90);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("tilt " + fmtTenths(headPitch), cx, 106);
        canvas.drawString("turn " + fmtTenths(headYaw), cx, 124);
    } else {
        canvas.setTextColor(TFT_ORANGE);
        canvas.drawString("NO SERVOS", cx, 110);
    }
    drawButton(BTN_CENTER, "Center", 0x2C4A, h && !atHome() && !headGliding);
    bool armed = millis() < powerArmedUntil;
    drawButton(BTN_POWER, armed ? "Sure?" : "Power", armed ? (uint16_t)0xF800 : (uint16_t)0x9000);
}

static void drawScreen() {
    if (cameraOk) {
        canvas.pushImage(0, 0, PREV_W, PREV_H, preview);
    } else {
        canvas.fillRect(0, 0, PREV_W, PREV_H, TFT_BLACK);
    }
    drawAccountTag();
    if (settingsOpen) {
        drawSettings();
        canvas.pushSprite(0, 0);
        return;
    }

    bool online = WiFi.status() == WL_CONNECTED;
    switch (state) {
        case State::Idle:
        case State::Settling: {
            bool steady = state == State::Settling && millis() - settleSince >= STABLE_MS;
            if (!scaleOk)
                drawMessage("No scale", TFT_ORANGE, "Plug it into Port A (red)");
            else if (zeroing())
                drawMessage("Zeroing...", TFT_YELLOW, "Keep the scale still");
            else if (aimVisible)
                drawMessage("Aim camera", TFT_WHITE, "Drag stick; tap outside = done");
            else if (millis() - zeroedAt < 1500)
                drawMessage("Zeroed", TFT_GREEN, "Put food on the plate");
            else if (steady && !online)
                drawMessage("Waiting for Wi-Fi", TFT_ORANGE, net::statusText());
            else if (state == State::Settling)
                drawMessage("Hold still...", TFT_WHITE, "Taking photo when steady");
            else
                drawMessage("Ready", TFT_WHITE, online ? "Put food on the plate" : net::statusText());
            if (state == State::Settling) {
                // Progress bar towards the photo, along the bottom of the image
                uint32_t t = min<uint32_t>(millis() - settleSince, STABLE_MS);
                canvas.fillRect(0, PREV_H - 4, PREV_W * t / STABLE_MS, 4, TFT_GREEN);
            }
            break;
        }
        case State::Uploading:
            switch (uploadPhase) {
                case UploadPhase::Photo:
                    drawMessage("Taking photo...", TFT_CYAN, String(uploadedWeight, 1) + " g");
                    break;
                case UploadPhase::Sending:
                    drawMessage("Uploading " + String(uploadPct) + "%", TFT_CYAN, String(uploadedWeight, 1) + " g");
                    canvas.fillRect(0, PREV_H - 4, PREV_W * uploadPct / 100, 4, TFT_CYAN);
                    break;
                case UploadPhase::Recognizing:
                    drawMessage("Recognizing...", TFT_YELLOW, "Working out what it is");
                    canvas.fillRect(0, PREV_H - 4, PREV_W, 4, TFT_YELLOW);
                    break;
            }
            break;
        case State::Result:
        case State::Error:
            drawMessage(line1, state == State::Error ? TFT_RED : TFT_GREEN, line2);
            break;
    }

    if (aimVisible) drawJoystick();
    drawPanel();  // last, so long message text can't spill into the column
    canvas.pushSprite(0, 0);
}

// Head angles go to NVS only when they actually changed (flash wear)
static void saveHead() {
    if (headYaw != savedYaw) prefs.putInt("yaw", savedYaw = headYaw);
    if (headPitch != savedPitch) prefs.putInt("pitch", savedPitch = headPitch);
}

// Gentle move for Center: eased over ~0.4-1.6s instead of the servos' full
// speed, which snapped the head round fast enough to startle
static int glideFromYaw, glideFromPitch, glideToYaw, glideToPitch;
static uint32_t glideStart, glideMs;

static void moveHeadTo(int yaw, int pitch) {
    headGliding = false;  // a manual move (joystick) takes over
    if (!head::ok()) return;
    yaw = constrain(yaw, head::YAW_MIN, head::YAW_MAX);
    pitch = constrain(pitch, head::PITCH_MIN, head::PITCH_MAX);
    if (yaw == headYaw && pitch == headPitch) return;
    headYaw = yaw;
    headPitch = pitch;
    head::setPose(headYaw, headPitch);
}

static void moveHead(int dYaw, int dPitch) { moveHeadTo(headYaw + dYaw, headPitch + dPitch); }

static void glideHeadTo(int yaw, int pitch) {
    if (!head::ok()) return;
    yaw = constrain(yaw, head::YAW_MIN, head::YAW_MAX);
    pitch = constrain(pitch, head::PITCH_MIN, head::PITCH_MAX);
    int dist = max(abs(yaw - headYaw), abs(pitch - headPitch));  // tenths of a degree
    if (dist == 0) return;
    glideFromYaw = headYaw;
    glideFromPitch = headPitch;
    glideToYaw = yaw;
    glideToPitch = pitch;
    glideStart = millis();
    glideMs = constrain(dist * 3 / 2, 400, 1600);  // 90 degrees in about 1.4s
    headGliding = true;
}

// Called every loop: steps the head along the glide (smoothstep easing)
static void updateHeadGlide() {
    if (!headGliding) return;
    float t = (millis() - glideStart) / (float)glideMs;
    if (t >= 1) {
        t = 1;
        headGliding = false;
    }
    float e = t * t * (3 - 2 * t);
    headYaw = glideFromYaw + (int)lroundf((glideToYaw - glideFromYaw) * e);
    headPitch = glideFromPitch + (int)lroundf((glideToPitch - glideFromPitch) * e);
    head::setPose(headYaw, headPitch);
}

static void hideAim() {
    aimVisible = false;
    dragging = false;
    joyDx = joyDy = 0;
    saveHead();
}

static bool insideJoystick(int x, int y) {
    int dx = x - JOY_X, dy = y - JOY_Y;
    return dx * dx + dy * dy <= JOY_BASE_R * JOY_BASE_R;
}

// Main screen: tap the camera view to show the joystick, drag it to aim,
// tap outside it to hide it.
static void handleJoystick() {
    if (!aimVisible) {
        if (head::ok() && tapped(PREVIEW_AREA)) {
            aimVisible = true;
            aimLastTap = millis();
            if (state == State::Settling) state = State::Idle;  // no photos while aiming
        }
        return;
    }

    if (tapNow) {
        aimLastTap = millis();
        dragging = insideJoystick(tapX, tapY);
        if (!dragging && tapped(PREVIEW_AREA)) {
            hideAim();
            return;
        }
    }

    if (dragging && touchHeld) {
        aimLastTap = millis();
        int dx = tapX - JOY_X, dy = tapY - JOY_Y;
        float dist = sqrtf(dx * dx + dy * dy);

        // Knob follows the finger, held inside the base
        float k = dist > JOY_KNOB_TRAVEL ? JOY_KNOB_TRAVEL / dist : 1.0f;
        joyDx = dx * k;
        joyDy = dy * k;

        // Speed grows with distance from centre, capped at JOY_INPUT_R
        if (dist > JOY_DEADZONE && millis() - lastJoyMove >= JOY_UPDATE_MS) {
            lastJoyMove = millis();
            float scale = min(dist, (float)JOY_INPUT_R) / JOY_INPUT_R * JOY_MAX_SPEED / dist;
            // Finger left -> look left (+yaw); finger up -> look up (+pitch)
            moveHead((int)(-dx * scale), (int)(-dy * scale));
        }
    } else {
        dragging = false;
        joyDx = joyDy = 0;  // spring back to centre
    }

    if (!touchHeld && millis() - aimLastTap > AIM_HIDE_MS) hideAim();
}

// Settings screen taps. Changes apply immediately; NVS is written on Done.
static void handleSettingsTap() {
    if (tapped(BTN_DONE)) {
        settingsOpen = false;
        prefs.putInt("bright", brightness);
        saveHead();
        return;
    }
    if (tapped(BTN_DIM) || tapped(BTN_BRIGHT)) {
        brightness = constrain(brightness + (tapped(BTN_BRIGHT) ? BRIGHT_STEP : -BRIGHT_STEP), BRIGHT_MIN, BRIGHT_MAX);
        M5.Display.setBrightness(brightness);
    }
    if (tapped(BTN_WIFI)) {
        prefs.putInt("bright", brightness);
        saveHead();
        enterWifiSetup();
        return;
    }
    if (tapped(BTN_CENTER)) {
        glideHeadTo(0, HOME_PITCH);
        Serial.println("Head: center");
    }
    if (tapped(BTN_POWER)) {
        if (millis() < powerArmedUntil) {
            Serial.println("Powering off");
            prefs.putInt("bright", brightness);
            saveHead();
            M5.Display.fillScreen(TFT_BLACK);
            M5.Power.powerOff();
        } else {
            powerArmedUntil = millis() + 3000;
        }
    }
}

static void showBootMessage(const char* msg) {
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setTextColor(TFT_WHITE);
    M5.Display.setFont(&fonts::Font4);
    M5.Display.setTextDatum(middle_center);
    M5.Display.drawString(msg, LCD_W / 2, LCD_H / 2);
}

static String localDate() {
    struct tm t;
    if (!getLocalTime(&t, 100)) return "";
    char buf[11];
    strftime(buf, sizeof buf, "%Y-%m-%d", &t);
    return buf;
}

// ---------------------------------------------------------------- upload

// Request body as a Stream, so HTTPClient pulls it in chunks and we see how
// far the upload got. Once the last chunk is taken the photo is on its way
// to the server and the remaining wait is the server recognising it.
class ProgressStream : public Stream {
public:
    ProgressStream(const uint8_t* data, size_t size) : _data(data), _size(size) {}
    int available() override { return _size - _pos; }
    int read() override { return _pos < _size ? _data[_pos++] : -1; }
    int peek() override { return _pos < _size ? _data[_pos] : -1; }
    size_t readBytes(char* buffer, size_t length) override {
        size_t n = min(length, _size - _pos);
        memcpy(buffer, _data + _pos, n);
        _pos += n;
        report();
        return n;
    }
    size_t write(uint8_t) override { return 0; }

private:
    void report() {
        int pct = _size ? _pos * 100 / _size : 100;
        if (_pos >= _size) {
            uploadPhase = UploadPhase::Recognizing;
            drawScreen();
        } else if (pct - uploadPct >= 5 || millis() - _lastDraw > 300) {
            uploadPct = pct;   // redraw every 5% or 300ms, not on every chunk
            _lastDraw = millis();
            drawScreen();
        }
    }
    const uint8_t* _data;
    size_t _size, _pos = 0;
    uint32_t _lastDraw = 0;
};

// ---------------------------------------------------------------- HTTP + device key

static bool beginHttp(HTTPClient& http, WiFiClient& plain, WiFiClientSecure& secure, const String& url) {
    if (url.startsWith("https://")) {
        // TODO: verify the server certificate (CA bundle). Until then the
        // traffic is encrypted but a spoofed server isn't detected.
        secure.setInsecure();
        return http.begin(secure, url);
    }
    return http.begin(plain, url);
}

// Small JSON POST for the pairing endpoints; returns the HTTP status (<= 0 on network errors)
static int postJson(const char* path, const String& body, String& response) {
    if (WiFi.status() != WL_CONNECTED) return -1;
    HTTPClient http;
    WiFiClient plain;
    WiFiClientSecure secure;
    if (!beginHttp(http, plain, secure, String(API_BASE_URL) + path)) return -1;
    http.setTimeout(HTTP_TIMEOUT);
    http.addHeader("Content-Type", "application/json");
    int code = http.POST(body);
    response = code > 0 ? http.getString() : "";
    http.end();
    return code;
}

static void loadDeviceKey(bool importSecrets) {
    Preferences p;
    p.begin("dev", false);
    deviceKey = p.getString("key", "");
    ownerName = p.getString("owner", "");
#ifdef DEVICE_KEY
    // One-time migration from secrets.h (development builds)
    if (importSecrets && deviceKey.isEmpty() && String(DEVICE_KEY).startsWith("hk_")) {
        deviceKey = DEVICE_KEY;
        p.putString("key", deviceKey);
        Serial.println("Device key imported from secrets.h");
    }
#endif
    p.end();
}

static void saveDeviceKey(const String& key, const String& owner) {
    Preferences p;
    p.begin("dev", false);
    p.putString("key", key);
    p.putString("owner", owner);
    p.end();
    deviceKey = key;
    ownerName = owner;
}

static void saveOwnerName(const String& owner) {
    Preferences p;
    p.begin("dev", false);
    p.putString("owner", owner);
    p.end();
    ownerName = owner;
}

static void clearDeviceKey() {
    Preferences p;
    p.begin("dev", false);
    p.remove("key");
    p.remove("owner");
    p.end();
    deviceKey = "";
    ownerName = "";
    Serial.println("Device key cleared");
}

// ---------------------------------------------------------------- account check

// Asks the backend whose account this key belongs to; a 401 means the device
// was removed on the website. Runs in its own task because a cold backend
// (scaled to zero) takes 20-30s to answer and the screen must stay live.
// Not a frequent heartbeat: every request wakes the backend and database,
// which then stay billed for several minutes.
static constexpr uint32_t ACCOUNT_CHECK_MS = 6UL * 60 * 60 * 1000;  // when idle
static constexpr uint32_t ACCOUNT_RECHECK_MIN_MS = 60 * 1000;        // on opening settings
static volatile bool accountCheckBusy = false;
static volatile int accountCheckResult = 0;  // HTTP status of a finished check, 0 = none
static String accountCheckUser;              // set by the task before accountCheckResult
static bool accountChecked = false;
static uint32_t lastAccountCheck = 0;

static void accountCheckTask(void* arg) {
    String* key = (String*)arg;
    String user;
    int code = -1;
    {
        HTTPClient http;
        WiFiClient plain;
        WiFiClientSecure secure;
        if (beginHttp(http, plain, secure, String(API_BASE_URL) + "/api/device/me")) {
            http.setTimeout(HTTP_TIMEOUT);
            http.addHeader("X-Device-Key", *key);
            code = http.GET();
            JsonDocument doc;
            if (code == 200 && !deserializeJson(doc, http.getString()))
                user = (const char*)(doc["username"] | "");
            http.end();
        }
    }
    delete key;
    accountCheckUser = user;
    accountCheckResult = code == 0 ? -1 : code;
    accountCheckBusy = false;
    vTaskDelete(nullptr);
}

static void startAccountCheck() {
    if (accountCheckBusy || deviceKey.isEmpty() || WiFi.status() != WL_CONNECTED || state == State::Uploading)
        return;
    accountCheckBusy = true;
    accountChecked = true;
    lastAccountCheck = millis();
    if (xTaskCreate(accountCheckTask, "account", 12288, new String(deviceKey), 1, nullptr) != pdPASS) {
        accountCheckBusy = false;
        Serial.println("Account check: no memory for task");
    }
}

static void accountLoop() {
    int code = accountCheckResult;
    if (code != 0) {
        accountCheckResult = 0;
        Serial.printf("Account check: %d '%s'\n", code, accountCheckUser.c_str());
        if (code == 200 && !accountCheckUser.isEmpty() && accountCheckUser != ownerName)
            saveOwnerName(accountCheckUser);
        else if (code == 401 && !deviceKey.isEmpty())
            clearDeviceKey();  // removed on the website: the loop switches to pairing
    }
    // Once after boot, then every few hours
    if (!accountChecked || millis() - lastAccountCheck >= ACCOUNT_CHECK_MS) startAccountCheck();
}

// ---------------------------------------------------------------- pairing code

// Ask the backend for a fresh 6-digit code; the private token stays here
static void startPairing() {
    String resp;
    int code = postJson("/api/device/pairing/start", "{\"name\":\"Stack-chan\"}", resp);
    JsonDocument doc;
    if (code == 200 && !deserializeJson(doc, resp)) {
        pairCode = (const char*)(doc["code"] | "");
        pairToken = (const char*)(doc["pairingToken"] | "");
        // Server sends an absolute expiry; the device clock may be off, so use the 10-minute lifetime locally
        pairExpiresAt = millis() + 10 * 60 * 1000UL;
        nextPairPoll = millis() + (doc["pollSeconds"] | 3) * 1000UL;
        pairMsg = "";
        Serial.printf("Pairing: code %s\n", pairCode.c_str());
    } else {
        pairCode = pairToken = "";
        pairMsg = code == 429 ? "Too many attempts, waiting..." : "Server unreachable, retrying...";
        nextPairPoll = millis() + (code == 429 ? 60000UL : 5000UL);
        Serial.printf("Pairing: start failed (%d)\n", code);
    }
}

// Check whether someone has entered our code on the website yet
static void pollPairing() {
    String body = String("{\"pairingToken\":\"") + pairToken + "\"}";
    String resp;
    int code = postJson("/api/device/pairing/poll", body, resp);
    JsonDocument doc;
    if (code != 200 || deserializeJson(doc, resp)) {
        pairMsg = "Server unreachable, retrying...";
        nextPairPoll = millis() + 5000;
        if (code == 404) pairCode = pairToken = "";  // unknown pairing: start over
        return;
    }
    pairMsg = "";
    String status = doc["status"] | "";
    if (status == "paired") {
        String owner = doc["username"] | "";
        saveDeviceKey(String((const char*)(doc["key"] | "")), owner);
        accountChecked = true;
        lastAccountCheck = millis();
        String name = doc["deviceName"] | "Stack-chan";
        Serial.printf("Pairing: done, now '%s' for '%s'\n", name.c_str(), owner.c_str());
        pairCode = pairToken = "";
        mode = Mode::Normal;
        state = State::Result;
        line1 = "Paired!";
        line2 = owner.isEmpty() ? "Now " + name : "Hi, " + owner + "!";
        resultSince = millis() - RESULT_PHOTO_MS;  // no photo to hold
        setLed(0x002000);
    } else if (status == "expired") {
        pairCode = pairToken = "";  // a new code is requested next loop
    } else {
        nextPairPoll = millis() + 3000;
    }
}

static void pairingLoop() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (millis() < nextPairPoll) return;
    if (pairToken.isEmpty() || millis() > pairExpiresAt) startPairing();
    else pollPairing();
}

// ---------------------------------------------------------------- on-device Wi-Fi setup

static void startWifiScan() {
    net::startScan();
    wifiScanning = true;
    wifiList.clear();
    wifiPage = 0;
}

static void enterWifiSetup() {
    mode = Mode::WifiSetup;
    wifiScreen = WifiScreen::List;
    settingsOpen = false;
    resetArmedUntil = 0;
    net::pause(true);  // no background reconnects while the user chooses
    startWifiScan();
}

static void exitWifiSetup() {
    if (net::portalActive()) net::stopPortal();
    net::pause(false);
    mode = Mode::Normal;
}

static void startJoin() {
    wifiScreen = WifiScreen::Joining;
    joinResult = net::JoinState::Trying;
    joinShownAt = 0;
    net::tryJoin(chosenSsid, typedPass);
}

static void drawSignalBars(int x, int y, int rssi) {
    int n = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -75 ? 2 : 1;
    for (int i = 0; i < 4; i++) {
        int h = 4 + i * 4;
        canvas.fillRect(x + i * 6, y + 16 - h, 4, h, i < n ? TFT_GREEN : (uint16_t)0x4208);
    }
}

static void drawLock(int x, int y) {
    canvas.drawRoundRect(x + 2, y, 8, 9, 3, TFT_LIGHTGREY);
    canvas.fillRect(x, y + 6, 12, 9, TFT_LIGHTGREY);
}

static void drawWifiList() {
    canvas.fillSprite(0x10A2);
    canvas.setTextDatum(top_left);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString("Choose Wi-Fi", 8, 4);

    int pages = max(1, ((int)wifiList.size() + WL_ROWS - 1) / WL_ROWS);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(top_right);
    canvas.setTextColor(TFT_LIGHTGREY);
    if (!wifiScanning && !wifiList.empty()) canvas.drawString(String(wifiPage + 1) + "/" + String(pages), LCD_W - 8, 8);

    canvas.setTextDatum(middle_center);
    if (wifiScanning) {
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Scanning...", (LCD_W - 44) / 2, 110);
    } else if (wifiList.empty()) {
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("No networks found", (LCD_W - 44) / 2, 100);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("Only 2.4 GHz Wi-Fi is visible", (LCD_W - 44) / 2, 122);
    }
    for (int r = 0; r < WL_ROWS && !wifiScanning; r++) {
        int i = wifiPage * WL_ROWS + r;
        if (i >= (int)wifiList.size()) break;
        const auto& n = wifiList[i];
        int y = WL_ROW_Y + r * WL_ROW_H;
        canvas.fillRoundRect(6, y, LCD_W - 52, WL_ROW_H - 4, 6, 0x2945);
        canvas.setTextDatum(middle_left);
        canvas.setTextColor(TFT_WHITE);
        // Up to the "saved" mark / signal bars
        drawFit(n.ssid, 14, y + (WL_ROW_H - 4) / 2, (n.saved ? LCD_W - 132 : LCD_W - 98) - 14, middle_left);
        if (n.saved) {
            canvas.setFont(&fonts::Font0);
            canvas.setTextColor(TFT_GREEN);
            canvas.drawString("saved", LCD_W - 128, y + (WL_ROW_H - 4) / 2);
            canvas.setFont(&fonts::Font2);
        }
        drawSignalBars(LCD_W - 92, y + 8, n.rssi);
        if (!n.open) drawLock(LCD_W - 64, y + 10);
    }

    drawButton(BTN_WL_UP, "^", 0x2C4A, wifiPage > 0);
    drawButton(BTN_WL_DOWN, "v", 0x2C4A, wifiPage < pages - 1);
    drawButton(BTN_WL_RESCAN, "Rescan", 0x2C4A, !wifiScanning);
    drawButton(BTN_WL_PHONE, "Phone", 0x2C4A);
    bool armed = millis() < resetArmedUntil;
    drawButton(BTN_WL_RESET, armed ? "Sure?" : "Reset", armed ? (uint16_t)0xF800 : (uint16_t)0x9000);
    drawButton(BTN_WL_EXIT, "Exit", 0x2C4A);
    canvas.pushSprite(0, 0);
}

static void handleWifiListTap() {
    if (wifiScanning && net::scanDone()) {
        wifiScanning = false;
        wifiList = net::scanResults();
    }
    if (!tapNow) return;

    for (int r = 0; r < WL_ROWS && !wifiScanning; r++) {
        int i = wifiPage * WL_ROWS + r;
        if (i >= (int)wifiList.size()) break;
        if (!tapped({6, WL_ROW_Y + r * WL_ROW_H, LCD_W - 52, WL_ROW_H - 4})) continue;
        chosenSsid = wifiList[i].ssid;
        kbNote = "";
        if (wifiList[i].open) {
            typedPass = "";
            startJoin();
        } else if (wifiList[i].saved) {
            typedPass = net::savedPassword(chosenSsid);  // wrong one -> back to the keyboard
            startJoin();
        } else {
            typedPass = "";
            kbLayer = 0;
            wifiScreen = WifiScreen::Password;
        }
        return;
    }
    int pages = max(1, ((int)wifiList.size() + WL_ROWS - 1) / WL_ROWS);
    if (tapped(BTN_WL_UP) && wifiPage > 0) wifiPage--;
    else if (tapped(BTN_WL_DOWN) && wifiPage < pages - 1) wifiPage++;
    else if (tapped(BTN_WL_RESCAN) && !wifiScanning) startWifiScan();
    else if (tapped(BTN_WL_PHONE)) {
        wifiScreen = WifiScreen::Phone;
        net::startPortal();
    } else if (tapped(BTN_WL_RESET)) {
        if (millis() < resetArmedUntil) {
            net::forgetAll();
            clearDeviceKey();
            resetArmedUntil = 0;
            startWifiScan();  // refresh the "saved" marks
        } else {
            resetArmedUntil = millis() + 3000;
        }
    } else if (tapped(BTN_WL_EXIT)) {
        exitWifiSetup();
    }
}

// ---- keyboard ----

static const char* KB_ROWS[3][3] = {
    {"qwertyuiop", "asdfghjkl", "zxcvbnm"},
    {"QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"},
    {"1234567890", "@#$%&*-_+", "!?.,'\"/"},
};

static int kbRowY(int r) { return KB_Y + r * (KB_KEY_H + 2); }

static void drawKey(int x, int y, int w, const String& label, uint16_t bg = 0x39E7) {
    canvas.fillRoundRect(x + 1, y + 1, w - 2, KB_KEY_H - 2, 6, bg);
    canvas.setTextDatum(middle_center);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString(label, x + w / 2, y + KB_KEY_H / 2);
}

static void drawKeyboard() {
    canvas.fillSprite(0x10A2);
    canvas.setTextDatum(top_left);
    canvas.setFont(&fonts::Font2);
    if (kbNote.length()) {
        canvas.setTextColor(TFT_RED);
        drawFit(kbNote, 6, 4, LCD_W - 12, top_left);
    } else {
        canvas.setTextColor(TFT_WHITE);
        drawFit("Password for " + chosenSsid, 6, 4, LCD_W - 12, top_left);
    }
    // Shown in clear: easier to check on a tiny keyboard, and it's your screen
    canvas.fillRoundRect(6, 24, LCD_W - 12, 32, 6, TFT_WHITE);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_BLACK);
    String shown = typedPass.length() > 18 ? typedPass.substring(typedPass.length() - 18) : typedPass;
    canvas.drawString(shown + "_", 12, 28);

    canvas.setFont(&fonts::Font2);
    const char* const* rows = KB_ROWS[kbLayer];
    for (int i = 0; i < 10; i++) drawKey(i * 32, kbRowY(0), 32, String(rows[0][i]));
    for (int i = 0; i < 9; i++) drawKey(16 + i * 32, kbRowY(1), 32, String(rows[1][i]));
    int n3 = strlen(rows[2]);
    drawKey(0, kbRowY(2), 48, kbLayer == 2 ? "" : "Shift", kbLayer == 1 ? (uint16_t)0x2C4A : (uint16_t)0x39E7);
    for (int i = 0; i < n3; i++) drawKey(48 + i * 32, kbRowY(2), 32, String(rows[2][i]));
    drawKey(LCD_W - 48, kbRowY(2), 48, "Del");
    drawKey(0, kbRowY(3), 64, kbLayer == 2 ? "abc" : "123");
    drawKey(64, kbRowY(3), 128, "space");
    drawKey(192, kbRowY(3), 64, "Back");
    drawKey(256, kbRowY(3), 64, "Join", typedPass.length() >= 8 ? (uint16_t)0x2C4A : (uint16_t)0x4208);
    canvas.pushSprite(0, 0);
}

static void handleKeyboardTap() {
    if (!tapNow || tapY < KB_Y) return;
    int r = (tapY - KB_Y) / (KB_KEY_H + 2);
    const char* const* rows = KB_ROWS[kbLayer];
    auto type = [](char c) { if (typedPass.length() < 63) typedPass += c; kbNote = ""; };
    if (r == 0) {
        int i = tapX / 32;
        if (i >= 0 && i < 10) type(rows[0][i]);
    } else if (r == 1) {
        int i = (tapX - 16) / 32;
        if (tapX >= 16 && i >= 0 && i < 9) type(rows[1][i]);
    } else if (r == 2) {
        int n3 = strlen(rows[2]);
        if (tapX < 48) {
            if (kbLayer != 2) kbLayer = kbLayer == 0 ? 1 : 0;
        } else if (tapX >= LCD_W - 48) {
            if (typedPass.length()) typedPass.remove(typedPass.length() - 1);
        } else {
            int i = (tapX - 48) / 32;
            if (i >= 0 && i < n3) type(rows[2][i]);
        }
    } else if (r == 3) {
        if (tapX < 64) kbLayer = kbLayer == 2 ? 0 : 2;
        else if (tapX < 192) type(' ');
        else if (tapX < 256) wifiScreen = WifiScreen::List;
        else if (typedPass.length() >= 8) startJoin();  // WPA needs 8+
        else kbNote = "Wi-Fi passwords are at least 8 characters";
    }
}

// ---- connecting ----

static void drawJoining() {
    canvas.fillSprite(0x10A2);
    canvas.setTextDatum(top_left);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString("Wi-Fi", 8, 4);
    canvas.setTextDatum(middle_center);
    canvas.setFont(&fonts::Font2);
    drawFit(chosenSsid, 8, 60, LCD_W - 16, middle_center);

    canvas.setFont(&fonts::Font4);
    switch (joinResult) {
        case net::JoinState::Trying:
            canvas.setTextColor(TFT_YELLOW);
            canvas.drawString("Connecting...", LCD_W / 2, 110);
            break;
        case net::JoinState::Connected:
            canvas.setTextColor(TFT_GREEN);
            canvas.drawString("Connected!", LCD_W / 2, 110);
            break;
        default:
            canvas.setTextColor(TFT_ORANGE);
            canvas.drawString(joinResult == net::JoinState::NotFound ? "Network not found" : "Couldn't connect", LCD_W / 2, 100);
            canvas.setFont(&fonts::Font2);
            canvas.setTextColor(TFT_WHITE);
            canvas.drawString("Weak signal? Save it and Stack-chan", LCD_W / 2, 132);
            canvas.drawString("keeps trying in the background.", LCD_W / 2, 150);
            drawButton(BTN_JOIN_RETYPE, "Retype", 0x2C4A);
            drawButton(BTN_JOIN_SAVE, "Save anyway", 0x2C4A);
            drawButton(BTN_JOIN_BACK, "Back", 0x2C4A);
            break;
    }
    canvas.pushSprite(0, 0);
}

static void handleJoining() {
    if (joinResult == net::JoinState::Trying) {
        joinResult = net::joinState(JOIN_TIMEOUT_MS);
        if (joinResult == net::JoinState::Connected) {
            net::addNetwork(chosenSsid, typedPass);  // tested, so save it
            joinShownAt = millis();
            Serial.printf("Wi-Fi setup: joined and saved '%s'\n", chosenSsid.c_str());
        } else if (joinResult == net::JoinState::WrongPassword) {
            WiFi.disconnect(false);
            kbNote = "Wrong password - try again";
            kbLayer = 0;
            wifiScreen = WifiScreen::Password;
        }
        return;
    }
    if (joinResult == net::JoinState::Connected) {
        if (millis() - joinShownAt > 1500) exitWifiSetup();
        return;
    }
    // Not found / failed: let the user decide
    if (tapped(BTN_JOIN_RETYPE)) {
        WiFi.disconnect(false);
        kbNote = "";
        wifiScreen = WifiScreen::Password;
    } else if (tapped(BTN_JOIN_SAVE)) {
        net::addNetwork(chosenSsid, typedPass);
        exitWifiSetup();  // background reconnects take over
    } else if (tapped(BTN_JOIN_BACK)) {
        WiFi.disconnect(false);
        wifiScreen = WifiScreen::List;
        startWifiScan();
    }
}

// ---------------------------------------------------------------- phone setup portal

static void drawSetupScreen() {
    canvas.fillSprite(0x10A2);
    canvas.setTextColor(TFT_WHITE);
    canvas.setTextDatum(top_left);
    canvas.setFont(&fonts::Font4);
    canvas.drawString("Wi-Fi setup", 8, 6);

    // QR joins the setup hotspot (it carries the password, so no typing)
    canvas.fillRoundRect(6, 36, 150, 150, 6, TFT_WHITE);
    canvas.qrcode(net::apQrText().c_str(), 11, 41, 140, 3);

    const int x = 166;
    canvas.setFont(&fonts::Font2);
    canvas.drawString("1. Scan with your", x, 38);
    canvas.drawString("   phone camera", x, 54);
    canvas.drawString("2. Join the network", x, 76);
    canvas.drawString("3. Pick your Wi-Fi", x, 98);
    canvas.drawString("   on the page", x, 114);
    canvas.setFont(&fonts::Font0);
    canvas.setTextColor(TFT_LIGHTGREY);
    canvas.drawString(net::apSsid(), x, 136);
    canvas.drawString("pw " + net::apPassword(), x, 148);

    // Status of the attempt started from the phone
    bool justSaved = net::portalState() == net::PortalState::Saved;
    uint16_t c = justSaved ? TFT_GREEN : TFT_YELLOW;
    String m = justSaved ? net::portalMessage()
             : net::savedCount() ? "Saved: " + net::savedSsid(0) : "No Wi-Fi saved yet";
    canvas.setTextColor(c);
    canvas.setFont(&fonts::Font2);
    drawFit(m, 8, LCD_H - 36, LCD_W - 176, top_left);  // left of the Reset/Exit buttons

    bool armed = millis() < resetArmedUntil;
    drawButton(BTN_SETUP_RESET, armed ? "Sure?" : "Reset", armed ? (uint16_t)0xF800 : (uint16_t)0x9000);
    drawButton(BTN_SETUP_EXIT, "Exit", 0x2C4A);
    canvas.pushSprite(0, 0);
}

static void handleSetupTap() {
    if (tapped(BTN_SETUP_EXIT)) {
        // Back to choosing on the device
        net::stopPortal();
        net::pause(true);
        wifiScreen = WifiScreen::List;
        startWifiScan();
    } else if (tapped(BTN_SETUP_RESET)) {
        if (millis() < resetArmedUntil) {
            // Factory reset: forget every network and the device key
            net::forgetAll();
            clearDeviceKey();
            resetArmedUntil = 0;
        } else {
            resetArmedUntil = millis() + 3000;
        }
    }
}

static void drawPairingScreen() {
    canvas.fillSprite(0x10A2);
    canvas.setTextColor(TFT_WHITE);
    canvas.setTextDatum(top_left);
    canvas.setFont(&fonts::Font4);
    canvas.drawString("Pair this Stack-chan", 8, 6);

    canvas.setTextDatum(middle_center);
    bool online = WiFi.status() == WL_CONNECTED;
    if (!online) {
        canvas.setFont(&fonts::Font4);
        canvas.setTextColor(TFT_ORANGE);
        canvas.drawString("No Wi-Fi", LCD_W / 2, 90);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_WHITE);
        drawFit(net::statusText(), 8, 124, LCD_W - 16, middle_center);
        canvas.setTextDatum(middle_center);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("Tap Wi-Fi to change network", LCD_W / 2, 146);
    } else if (pairCode.length() == 6) {
        // "483 920" in big seven-segment digits
        canvas.setFont(&fonts::Font7);
        canvas.setTextColor(TFT_GREEN);
        canvas.drawString(pairCode.substring(0, 3) + " " + pairCode.substring(3), LCD_W / 2, 84);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Enter this code in HealthTrack:", LCD_W / 2, 130);
        canvas.drawString("Food Log > Add device", LCD_W / 2, 148);
        uint32_t left = pairExpiresAt > millis() ? (pairExpiresAt - millis()) / 1000 : 0;
        canvas.setTextColor(TFT_LIGHTGREY);
        char buf[24];
        snprintf(buf, sizeof buf, "expires in %lu:%02lu", (unsigned long)(left / 60), (unsigned long)(left % 60));
        canvas.drawString(buf, LCD_W / 2, 170);
    } else {
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Getting a pairing code...", LCD_W / 2, 100);
    }

    if (pairMsg.length()) {
        canvas.setTextDatum(top_left);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_YELLOW);
        drawFit(pairMsg, 8, LCD_H - 34, LCD_W - 96, top_left);  // left of the Wi-Fi button
    }
    drawButton(BTN_PAIR_WIFI, "Wi-Fi", 0x2C4A);
    canvas.pushSprite(0, 0);
}

static void handlePairingTap() {
    if (tapped(BTN_PAIR_WIFI)) enterWifiSetup();
}

// One loop() step of Wi-Fi setup, whichever screen is showing
static void wifiSetupLoop() {
    switch (wifiScreen) {
        case WifiScreen::List:
            handleWifiListTap();
            if (mode == Mode::WifiSetup && wifiScreen == WifiScreen::List) drawWifiList();
            break;
        case WifiScreen::Password:
            handleKeyboardTap();
            if (wifiScreen == WifiScreen::Password) drawKeyboard();
            break;
        case WifiScreen::Joining:
            handleJoining();
            if (mode == Mode::WifiSetup && wifiScreen == WifiScreen::Joining) drawJoining();
            break;
        case WifiScreen::Phone:
            net::portalLoop();
            handleSetupTap();
            if (net::portalFinished()) exitWifiSetup();
            else if (wifiScreen == WifiScreen::Phone) drawSetupScreen();
            break;
    }
}

// ---------------------------------------------------------------- upload

// Builds the multipart body by hand (HTTPClient has no multipart helper)
// in PSRAM, then POSTs it with the device key.
static bool upload(const uint8_t* jpg, size_t jpgLen, float grams, String& outLine1, String& outLine2) {
    if (WiFi.status() != WL_CONNECTED) {
        outLine1 = "No Wi-Fi";
        outLine2 = "Settings > Wi-Fi to add one";
        return false;
    }

    const char* boundary = "----StackChanScaleBoundary7d1f";
    String date = localDate();
    String head;
    head += "--"; head += boundary; head += "\r\n";
    head += "Content-Disposition: form-data; name=\"weightGrams\"\r\n\r\n";
    head += String(grams, 1); head += "\r\n";
    if (date.length()) {
        head += "--"; head += boundary; head += "\r\n";
        head += "Content-Disposition: form-data; name=\"localDate\"\r\n\r\n";
        head += date; head += "\r\n";
    }
    head += "--"; head += boundary; head += "\r\n";
    head += "Content-Disposition: form-data; name=\"image\"; filename=\"meal.jpg\"\r\n";
    head += "Content-Type: image/jpeg\r\n\r\n";
    String tail = String("\r\n--") + boundary + "--\r\n";

    size_t total = head.length() + jpgLen + tail.length();
    uint8_t* body = (uint8_t*)ps_malloc(total);
    if (!body) {
        outLine1 = "Out of memory";
        outLine2 = "";
        return false;
    }
    memcpy(body, head.c_str(), head.length());
    memcpy(body + head.length(), jpg, jpgLen);
    memcpy(body + head.length() + jpgLen, tail.c_str(), tail.length());

    String url = String(API_BASE_URL) + "/api/intake/device";
    HTTPClient http;
    WiFiClient plain;
    WiFiClientSecure secure;
    if (!beginHttp(http, plain, secure, url)) {
        free(body);
        outLine1 = "Bad API_BASE_URL";
        outLine2 = "";
        return false;
    }
    http.setTimeout(HTTP_TIMEOUT);
    http.addHeader("X-Device-Key", deviceKey);
    http.addHeader("Content-Type", String("multipart/form-data; boundary=") + boundary);

    uploadPhase = UploadPhase::Sending;
    uploadPct = 0;
    drawScreen();
    ProgressStream bodyStream(body, total);
    int code = http.sendRequest("POST", &bodyStream, total);
    String resp = code > 0 ? http.getString() : "";
    http.end();
    free(body);
    Serial.printf("POST %s -> %d %s\n", url.c_str(), code, resp.c_str());

    JsonDocument doc;
    bool parsed = !deserializeJson(doc, resp);

    if (code == 200 && parsed) {
        const char* food = doc["foodName"] | "";
        int kcal = doc["calories"] | 0;
        int today = doc["todayCalories"] | 0;
        if (!(doc["isFood"] | true)) {
            outLine1 = "No food seen";
            outLine2 = "Nothing was logged";
        } else if (strlen(food) == 0) {
            outLine1 = "Saved " + String(grams, 1) + " g";
            outLine2 = "Name it in the Food Log";
        } else {
            outLine1 = food;  // long names scroll on screen
            outLine2 = String(kcal) + " kcal  (today " + String(today) + ")";
        }
        return true;
    }

    if (code == 401) {
        // The key was revoked on the website (or never valid): forget it and
        // go back to showing a pairing code
        clearDeviceKey();
        outLine1 = "Device removed";
        outLine2 = "Pair it again on the website";
        return false;
    }

    outLine1 = code > 0 ? "Error " + String(code) : "Server unreachable";
    outLine2 = parsed ? String((const char*)(doc["message"] | ""))
                      : (code > 0 ? "" : HTTPClient::errorToString(code));
    return false;
}

static void captureAndUpload() {
    uploadedWeight = weight;
    state = State::Uploading;
    uploadPhase = UploadPhase::Photo;
    setLed(0x000020);
    drawScreen();

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        state = State::Error;
        line1 = "Camera error";
        line2 = "Could not take a photo";
        setLed(0x200000);
        return;
    }
    downscale((const uint16_t*)fb->buf);  // keep the uploaded shot on screen

    uint8_t* jpg = nullptr;
    size_t jpgLen = 0;
    bool converted = frame2jpg(fb, JPEG_QUALITY, &jpg, &jpgLen);
    esp_camera_fb_return(fb);
    if (!converted) {
        state = State::Error;
        line1 = "JPEG error";
        line2 = "";
        setLed(0x200000);
        return;
    }
    Serial.printf("Photo %u bytes, weight %.1f g\n", (unsigned)jpgLen, uploadedWeight);

    bool ok = upload(jpg, jpgLen, uploadedWeight, line1, line2);
    free(jpg);
    state = ok ? State::Result : State::Error;
    setLed(ok ? 0x002000 : 0x200000);
}

// ---------------------------------------------------------------- Wi-Fi

// Reconnecting (any saved network, strongest first) lives in net::maintain();
// this just logs changes.
static bool wasOnline = false;

static void logWifiChanges() {
    bool online = WiFi.status() == WL_CONNECTED;
    if (online == wasOnline) return;
    wasOnline = online;
    if (online) Serial.printf("Wi-Fi connected: '%s' %s (%d dBm)\n", WiFi.SSID().c_str(),
                              WiFi.localIP().toString().c_str(), WiFi.RSSI());
    else Serial.println("Wi-Fi lost");
}

// ---------------------------------------------------------------- setup/loop

void setup() {
    auto cfg = M5.config();
    M5.begin(cfg);
    Serial.begin(115200);
    // No setRotation: M5Unified's default is already landscape on CoreS3
    showBootMessage("Starting...");

    preview = (uint16_t*)ps_malloc(PREV_W * PREV_H * sizeof(uint16_t));
    memset(preview, 0, PREV_W * PREV_H * sizeof(uint16_t));
    canvas.setPsram(true);
    canvas.setColorDepth(16);
    canvas.createSprite(LCD_W, LCD_H);

    // The camera's SCCB bus is the CoreS3 internal I2C: hand it to the camera
    // driver for init (sensor register setup), then take it back so touch and
    // the power chip work. Streaming frames doesn't use SCCB at all.
    auto i2cPort = M5.In_I2C.getPort();
    auto i2cSda = M5.In_I2C.getSDA();
    auto i2cScl = M5.In_I2C.getSCL();
    M5.In_I2C.release();
    cameraOk = esp_camera_init(&cameraConfig) == ESP_OK;
    Serial.printf("Camera: %s\n", cameraOk ? "ok" : "FAILED");
    // The camera driver leaves its own I2C driver installed on this port.
    // Two drivers on one bus made reads intermittently fail (the servo IO
    // expander "disappeared" on some boots), so remove it before handing
    // the bus back. Streaming frames doesn't use it.
    i2c_driver_delete((i2c_port_t)i2cPort);
    M5.In_I2C.begin(i2cPort, i2cSda, i2cScl);
    touchOk = M5.Touch.isEnabled();
    Serial.printf("Internal I2C back: battery %d%%, touch %s\n",
                  M5.Power.getBatteryLevel(), touchOk ? "enabled" : "disabled");

    prefs.begin("hts", false);
    brightness = constrain(prefs.getInt("bright", brightness), BRIGHT_MIN, BRIGHT_MAX);
    headYaw = constrain(prefs.getInt("yaw", headYaw), head::YAW_MIN, head::YAW_MAX);
    headPitch = constrain(prefs.getInt("pitch", headPitch), head::PITCH_MIN, head::PITCH_MAX);
    savedYaw = headYaw;
    savedPitch = headPitch;
    M5.Display.setBrightness(brightness);
    if (head::begin()) head::setPose(headYaw, headPitch);

    scaleOk = scales.begin(&Wire, SCALE_SDA, SCALE_SCL, DEVICE_DEFAULT_ADDR);
    Serial.printf("Scale: %s\n", scaleOk ? "ok" : "FAILED");
    if (scaleOk) {
        Serial.printf("Scale filters: LP=%u avg=%u ema=%u fw=%u\n", scales.getLPFilter(),
                      scales.getAvgFilter(), scales.getEmaFilter(), scales.getFirmwareVersion());
        requestZero();  // zero once the reading has settled
    }
    setLed(0x002000);

    net::begin();
    // secrets.h is imported on the very first boot only. The flag lives in
    // "hts", which Reset doesn't clear — otherwise a reset device would pick
    // the old network and key straight back up on its next boot.
    bool importSecrets = !prefs.getBool("seeded", false);
#ifdef WIFI_SSID
    if (importSecrets && net::savedCount() == 0 && strlen(WIFI_SSID) > 0) {
        net::addNetwork(WIFI_SSID, WIFI_PASSWORD);
        Serial.println("Wi-Fi network imported from secrets.h");
    }
#endif
    loadDeviceKey(importSecrets);
    prefs.putBool("seeded", true);

    showBootMessage("Connecting Wi-Fi...");
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    bool online = net::connectBest(15000);
    Serial.printf("Wi-Fi: %s (%d saved)\n", online ? "connected" : "not connected", net::savedCount());
    wasOnline = online;

    if (!online && net::savedCount() == 0) {
        // First run: nothing to connect to, so go straight to choosing Wi-Fi
        enterWifiSetup();
    } else if (deviceKey.isEmpty()) {
        mode = Mode::Pairing;
    }

    configTzTime(TIMEZONE, "pool.ntp.org", "time.google.com");
}

void loop() {
    M5.update();
    {
        auto t = M5.Touch.getDetail();
        tapNow = touchOk && t.wasPressed();
        touchHeld = touchOk && t.isPressed();
        tapX = t.x;
        tapY = t.y;
    }
    updateScale();
    updateHeadGlide();

    // Servos missing at boot: keep retrying (quick, non-blocking) for 30s
    static uint32_t lastHeadRetry = 0;
    if (!head::ok() && millis() < 30000 && millis() - lastHeadRetry >= 3000) {
        lastHeadRetry = millis();
        if (head::begin(0)) head::setPose(headYaw, headPitch);
    }

    // Wi-Fi setup (on the device, or via the phone portal); afterwards we
    // carry on, to pairing if this device has no key yet
    if (mode == Mode::WifiSetup) {
        wifiSetupLoop();
        if (mode == Mode::WifiSetup) {
            delay(10);  // keeps the phone portal's web server responsive
            return;
        }
    }

    net::maintain();
    logWifiChanges();
    accountLoop();

    // No key yet (first run, or removed on the website): show a pairing code
    if (mode == Mode::Normal && deviceKey.isEmpty()) {
        mode = Mode::Pairing;
        settingsOpen = false;
        if (aimVisible) hideAim();
        state = State::Idle;
    }
    if (mode == Mode::Pairing) {
        pairingLoop();
        handlePairingTap();
        if (mode == Mode::Pairing) {
            drawPairingScreen();
            delay(50);
            return;
        }
    }

    if (settingsOpen) {
        handleSettingsTap();
    } else if (state != State::Uploading) {
        handleJoystick();
        if (tapped({GEAR_X, GEAR_Y, GEAR_W, GEAR_H})) {
            if (aimVisible) hideAim();
            settingsOpen = true;
            powerArmedUntil = 0;
            if (millis() - lastAccountCheck >= ACCOUNT_RECHECK_MIN_MS) startAccountCheck();
            if (state == State::Settling) state = State::Idle;  // no photos while adjusting
        } else if (scaleOk && tapped({TARE_X, TARE_Y, TARE_W, TARE_H})) {
            Serial.println("TARE tapped");
            requestZero();
            if (state == State::Settling) state = State::Idle;
        }
    }

    // Live preview, except for the first few seconds of a result, when the
    // photo that was just uploaded stays on screen
    bool holdingPhoto = (state == State::Result || state == State::Error)
                        && millis() - resultSince < RESULT_PHOTO_MS;
    if (cameraOk && state != State::Uploading && !holdingPhoto) {
        camera_fb_t* fb = esp_camera_fb_get();
        if (fb) {
            downscale((const uint16_t*)fb->buf);
            esp_camera_fb_return(fb);
        }
    }

    switch (state) {
        case State::Idle:
            if (!settingsOpen && !aimVisible && !zeroing() && weight >= MIN_FOOD_GRAMS) {
                state = State::Settling;
                settleRef = weight;
                settleSince = millis();
            }
            break;

        case State::Settling:
            if (weight < MIN_FOOD_GRAMS) {
                state = State::Idle;
            } else if (fabsf(weight - settleRef) > STABLE_BAND) {
                settleRef = weight;          // still moving: restart the timer
                settleSince = millis();
            } else if (millis() - settleSince >= STABLE_MS) {
                if (!cameraOk) {
                    state = State::Error;
                    line1 = "Camera not ready";
                    line2 = "Restart Stack-chan";
                    resultSince = millis();
                } else if (WiFi.status() == WL_CONNECTED && !accountCheckBusy) {
                    captureAndUpload();
                    resultSince = millis();
                }
                // Offline: stay here (live view, weight shown) and upload as
                // soon as Wi-Fi comes back while the food is still on the scale
            }
            break;

        case State::Uploading:
            break;

        case State::Result:
        case State::Error:
            // Wait for the plate to be cleared before weighing the next item
            // (a disconnected scale reads 0, so unplugging also resets)
            if (weight < EMPTY_GRAMS) {
                state = State::Idle;
                setLed(0x002000);
            }
            break;
    }

    drawScreen();
    delay(50);
}
