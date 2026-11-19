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
#include <algorithm>
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

// Settings screen (gear): full screen, one row per setting, Back in the
// top-right corner. No camera view: aiming is done on the main screen.
struct Rect { int x, y, w, h; };
static constexpr Rect BTN_SET_BACK = {LCD_W - 78, 6, 72, 30};
static constexpr int SET_ROW_Y = 44, SET_ROW_STEP = 39, SET_ROW_H = 35;
static constexpr Rect setRow(int i) { return {6, SET_ROW_Y + i * SET_ROW_STEP, LCD_W - 12, SET_ROW_H}; }
// Button at the right end of row i
static constexpr Rect setRowButton(int i) { return {LCD_W - 6 - 86, SET_ROW_Y + i * SET_ROW_STEP + 3, 82, SET_ROW_H - 6}; }
enum SetRow { ROW_LIGHT, ROW_WIFI, ROW_ACCOUNT, ROW_HEAD, ROW_POWER };
static constexpr int SET_LABEL_X = 14, SET_VALUE_X = 86;
// Brightness slider in the first row
static constexpr int SLIDER_X = SET_VALUE_X + 8, SLIDER_W = LCD_W - 6 - 54 - SLIDER_X;
// On-device Wi-Fi: network list (4 rows per page), keyboard, connecting
// Scrollable list between the title and the bottom buttons; the tapped row
// opens to show its actions (connect, disconnect, password, forget)
static constexpr int WL_ROW_Y = 44, WL_VIEW_H = LCD_H - 46 - WL_ROW_Y;
static constexpr int WL_ROW_H = 38, WL_CARD_H = 34, WL_EXP_H = 42;
static constexpr int WL_X = 6, WL_W = LCD_W - 18;  // room for the scroll bar
static constexpr Rect BTN_WL_RESCAN = {4, LCD_H - 42, (LCD_W - 14) / 2, 38};
static constexpr Rect BTN_WL_PHONE  = {10 + (LCD_W - 14) / 2, LCD_H - 42, (LCD_W - 14) / 2, 38};
static constexpr int KB_Y = 62, KB_KEY_H = 42;   // keyboard rows at 62, 106, 150, 194
static constexpr Rect BTN_JOIN_RETYPE = {4, LCD_H - 46, 100, 40};
static constexpr Rect BTN_JOIN_SAVE   = {110, LCD_H - 46, 100, 40};
static constexpr Rect BTN_JOIN_BACK   = {216, LCD_H - 46, 100, 40};
// Phone-portal screen and pairing screen
static constexpr Rect BTN_SETUP_EXIT  = {LCD_W - 78, 6, 72, 30};  // same place as Settings' Back
static constexpr Rect BTN_PAIR_WIFI   = {LCD_W - 80, LCD_H - 42, 74, 36};
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
static constexpr int HOME_PITCH = head::PITCH_MIN;  // Home = facing forward, lowest tilt (also the first-boot pose)
static constexpr int BRIGHT_MIN = 10, BRIGHT_MAX = 255;

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
static Rect accountTagRect = {0, 0, 0, 0};  // where the tag was last drawn (tap target)
static bool accountMenuOpen = false;
static uint32_t unpairArmedUntil = 0;       // Unpair needs a second tap

// Today's intake for the ring on the main screen. Updated by every upload
// and every account check (boot, touches, every few hours); edits made on
// the website show up at the next of those.
static int intakeToday = -1;   // kcal, -1 = not known yet
static int intakeGoal = 0;     // daily goal in kcal, 0 = none set
static String intakeDate;      // local day intakeToday belongs to
static String localDate();
static Rect intakeRingRect = {0, 0, 0, 0};  // tap target, set when drawn
static bool todayOpen = false;              // "Today" list (opened from the ring)
static volatile bool todayBusy = false;     // its request is running
static void drawToday();

// On-device Wi-Fi setup
enum class WifiScreen { List, Password, Joining, Phone };
static WifiScreen wifiScreen = WifiScreen::List;
static std::vector<net::Network> wifiList;
static bool wifiScanning = false;
static int wifiScroll = 0;              // list scroll offset, px
static int wifiSel = -1;                // opened row, or -1
static uint32_t forgetArmedUntil = 0;   // Forget needs a second tap
static bool listTouching = false, listDragged = false;
static int listStartX = 0, listStartY = 0, listStartScroll = 0;
static String chosenSsid, typedPass, kbNote;
static int kbLayer = 0;                 // 0 lower, 1 upper, 2 digits & symbols
static net::JoinState joinResult = net::JoinState::Trying;
static uint32_t joinShownAt = 0;
static constexpr uint32_t JOIN_TIMEOUT_MS = 20000;

static void enterWifiSetup();  // defined with the Wi-Fi setup screens
static void unpairDevice();     // defined with the account check

// Pairing-code flow
static String pairCode, pairToken, pairMsg;
static uint32_t pairExpiresAt = 0, nextPairPoll = 0;

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

static bool inRect(int x, int y, const Rect& r) {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

static bool sliderDragging = false;  // finger on the brightness slider
static bool wifiFromSettings = false; // Wi-Fi setup was opened from Settings

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

// Whose account meals go to: a translucent tag in the image's top-left
// corner. Tapping it opens the account card (with Unpair).
static void drawAccountTag() {
    accountTagRect = {0, 0, 0, 0};
    if (deviceKey.isEmpty()) return;
    // Devices paired before usernames were sent learn theirs from the account check
    String label = ownerName.isEmpty() ? String("Paired") : ownerName;
    canvas.setFont(&fonts::Font2);
    const int x = 6, y = 6, h = 22;
    int tw = min((int)canvas.textWidth(label), PREV_W / 2);
    accountTagRect = {x, y, tw + 32, h};
    fillRoundRectAlpha(accountTagRect, h / 2, TFT_BLACK, 150);
    // Person icon
    canvas.fillCircle(x + 13, y + 8, 4, TFT_LIGHTGREY);
    canvas.fillRoundRect(x + 7, y + 13, 13, 7, 3, TFT_LIGHTGREY);
    canvas.setTextColor(TFT_WHITE);
    drawFit(label, x + 24, y + h / 2, tw, middle_left);
}

// Local time (NTP, TIMEZONE) in the image's top-right corner, same style as
// the account tag. Hidden until the clock has been set.
static void drawClock() {
    time_t now = time(nullptr);
    if (now < 1700000000) return;  // not synced yet
    struct tm t;
    localtime_r(&now, &t);
    char buf[6];
    strftime(buf, sizeof buf, "%H:%M", &t);
    canvas.setFont(&fonts::Font2);
    const int h = 22, w = canvas.textWidth(buf) + 16;
    Rect r = {PREV_W - 6 - w, 6, w, h};
    fillRoundRectAlpha(r, h / 2, TFT_BLACK, 150);
    canvas.setTextColor(TFT_WHITE);
    canvas.setTextDatum(middle_center);
    canvas.drawString(buf, r.x + w / 2, r.y + h / 2);
}

// Today's intake vs the daily goal: a small ring in the image's bottom-right
// corner, "eaten/goal" in the middle. Green until the goal, then amber.
static void drawIntakeRing() {
    intakeRingRect = {0, 0, 0, 0};
    if (deviceKey.isEmpty() || intakeToday < 0) return;
    String today = localDate();
    int eaten = (!today.isEmpty() && today != intakeDate) ? 0 : intakeToday;  // a new day started
    const int R = 30, T = 6;
    const int cx = PREV_W - 6 - R, cy = PREV_H - 6 - R;
    intakeRingRect = {cx - R, cy - R, 2 * R, 2 * R};
    fillRoundRectAlpha(intakeRingRect, R, TFT_BLACK, 150);
    canvas.fillArc(cx, cy, R - T - 1, R - 2, 0, 360, 0x4208);
    if (intakeGoal > 0 && eaten > 0) {
        bool over = eaten > intakeGoal;
        uint16_t color = over ? (uint16_t)0xFD20 : (uint16_t)TFT_GREEN;
        int sweep = over ? 360 : max(4, (int)((long)eaten * 360 / intakeGoal));
        // Starts at 12 o'clock (270 degrees), clockwise
        if (sweep <= 90) {
            canvas.fillArc(cx, cy, R - T - 1, R - 2, 270, 270 + sweep, color);
        } else {
            canvas.fillArc(cx, cy, R - T - 1, R - 2, 270, 360, color);
            canvas.fillArc(cx, cy, R - T - 1, R - 2, 0, sweep - 90, color);
        }
    }
    canvas.setTextDatum(middle_center);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(intakeGoal > 0 && eaten > intakeGoal ? (uint16_t)0xFD20 : (uint16_t)TFT_WHITE);
    canvas.drawString(String(eaten), cx, cy - 5);
    canvas.setFont(&fonts::Font0);
    canvas.setTextColor(TFT_LIGHTGREY);
    canvas.drawString(intakeGoal > 0 ? "/" + String(intakeGoal) : String("kcal"), cx, cy + 9);
}

static constexpr Rect ACCOUNT_CARD = {14, 34, PREV_W - 28, 116};
static constexpr Rect BTN_UNPAIR = {ACCOUNT_CARD.x + 10, ACCOUNT_CARD.y + ACCOUNT_CARD.h - 44,
                                    (ACCOUNT_CARD.w - 30) / 2, 34};
static constexpr Rect BTN_ACCOUNT_CLOSE = {BTN_UNPAIR.x + BTN_UNPAIR.w + 10, BTN_UNPAIR.y, BTN_UNPAIR.w, 34};

static void drawAccountMenu() {
    if (!accountMenuOpen) return;
    const Rect& c = ACCOUNT_CARD;
    fillRoundRectAlpha(c, 10, TFT_BLACK, 210);
    canvas.drawRoundRect(c.x, c.y, c.w, c.h, 10, 0x4208);
    canvas.setTextDatum(top_left);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(TFT_LIGHTGREY);
    canvas.drawString("Logging meals for", c.x + 12, c.y + 10);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE);
    drawFit(ownerName.isEmpty() ? String("(checking...)") : ownerName, c.x + 12, c.y + 30, c.w - 24, top_left);
    bool armed = millis() < unpairArmedUntil;
    drawButton(BTN_UNPAIR, armed ? "Sure?" : "Unpair", armed ? (uint16_t)0xF800 : (uint16_t)0x9000);
    drawButton(BTN_ACCOUNT_CLOSE, "Close", 0x2C4A);
}

// One settings row: card, label on the left, value after it
static void drawSettingRow(int i, const char* label, const String& value, int valueW) {
    Rect r = setRow(i);
    canvas.fillRoundRect(r.x, r.y, r.w, r.h, 8, 0x2945);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(middle_left);
    canvas.setTextColor(TFT_LIGHTGREY);
    canvas.drawString(label, SET_LABEL_X, r.y + r.h / 2);
    if (value.length()) {
        canvas.setTextColor(TFT_WHITE);
        drawFit(value, SET_VALUE_X, r.y + r.h / 2, valueW, middle_left);
    }
}

static void drawSettings() {
    accountTagRect = {0, 0, 0, 0};  // the tag isn't on this screen
    canvas.fillSprite(0x10A2);
    canvas.setTextDatum(middle_left);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString("Settings", 10, 21);
    drawButton(BTN_SET_BACK, "Back", 0x2C4A);

    const int fullW = LCD_W - 6 - 10 - SET_VALUE_X;      // value with nothing after it
    const int besideBtnW = setRowButton(0).x - 8 - SET_VALUE_X;

    // Brightness: drag the slider
    drawSettingRow(ROW_LIGHT, "Light", "", 0);
    {
        Rect r = setRow(ROW_LIGHT);
        int cy = r.y + r.h / 2;
        int knobX = SLIDER_X + (brightness - BRIGHT_MIN) * SLIDER_W / (BRIGHT_MAX - BRIGHT_MIN);
        canvas.fillRoundRect(SLIDER_X, cy - 3, SLIDER_W, 6, 3, 0x4208);
        canvas.fillRoundRect(SLIDER_X, cy - 3, knobX - SLIDER_X, 6, 3, TFT_GREEN);
        canvas.fillCircle(knobX, cy, sliderDragging ? 10 : 8, TFT_WHITE);
        canvas.setFont(&fonts::Font2);
        canvas.setTextDatum(middle_right);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(String(brightness * 100 / 255) + "%", LCD_W - 14, cy);
    }

    // Wi-Fi: whole row opens the network list
    String wifi = WiFi.status() == WL_CONNECTED ? WiFi.SSID()
                : net::isOffByUser() ? String("Disconnected") : String("Not connected");
    drawSettingRow(ROW_WIFI, "Wi-Fi", wifi, fullW - 14);
    {
        Rect r = setRow(ROW_WIFI);
        canvas.setTextDatum(middle_right);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString(">", r.x + r.w - 10, r.y + r.h / 2);
    }

    // Account, with Unpair (two taps)
    drawSettingRow(ROW_ACCOUNT, "Account", ownerName.isEmpty() ? String("(checking...)") : ownerName, besideBtnW);
    bool unpairArmed = millis() < unpairArmedUntil;
    drawButton(setRowButton(ROW_ACCOUNT), unpairArmed ? "Sure?" : "Unpair",
               unpairArmed ? (uint16_t)0xF800 : (uint16_t)0x9000);

    // Head: current angles (moved with the joystick on the main screen), Center
    bool h = head::ok();
    drawSettingRow(ROW_HEAD, "Head", h ? "tilt " + fmtTenths(headPitch) + "  turn " + fmtTenths(headYaw)
                                       : String("No servos"), besideBtnW);
    drawButton(setRowButton(ROW_HEAD), "Center", 0x2C4A, h && !atHome() && !headGliding);

    // Power (two taps)
    drawSettingRow(ROW_POWER, "Power", "Battery " + String(M5.Power.getBatteryLevel()) + "%", besideBtnW);
    bool powerArmed = millis() < powerArmedUntil;
    drawButton(setRowButton(ROW_POWER), powerArmed ? "Sure?" : "Turn off",
               powerArmed ? (uint16_t)0xF800 : (uint16_t)0x9000);
}

static void drawScreen() {
    if (todayOpen) {
        accountTagRect = intakeRingRect = {0, 0, 0, 0};  // not on this screen
        drawToday();
        canvas.pushSprite(0, 0);
        return;
    }
    if (settingsOpen) {
        drawSettings();
        canvas.pushSprite(0, 0);
        return;
    }
    if (cameraOk) {
        canvas.pushImage(0, 0, PREV_W, PREV_H, preview);
    } else {
        canvas.fillRect(0, 0, PREV_W, PREV_H, TFT_BLACK);
    }
    drawAccountTag();
    drawClock();
    drawIntakeRing();

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
    drawAccountMenu();
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
static void closeSettings() {
    settingsOpen = false;
    sliderDragging = false;
    prefs.putInt("bright", brightness);
    saveHead();
}

static void handleSettingsTap() {
    // Brightness slider: follows the finger, saved on release
    Rect light = setRow(ROW_LIGHT);
    if (tapped({SLIDER_X - 14, light.y, SLIDER_W + 28, light.h})) sliderDragging = true;
    if (sliderDragging) {
        if (touchHeld) {
            int x = constrain(tapX, SLIDER_X, SLIDER_X + SLIDER_W);
            int b = BRIGHT_MIN + (x - SLIDER_X) * (BRIGHT_MAX - BRIGHT_MIN) / SLIDER_W;
            if (b != brightness) {
                brightness = b;
                M5.Display.setBrightness(brightness);
            }
        } else {
            sliderDragging = false;
            prefs.putInt("bright", brightness);
        }
        return;
    }

    if (tapped(BTN_SET_BACK)) {
        closeSettings();
    } else if (tapped(setRow(ROW_WIFI))) {
        closeSettings();
        enterWifiSetup();
        wifiFromSettings = true;
    } else if (tapped(setRowButton(ROW_ACCOUNT))) {
        if (millis() < unpairArmedUntil) {
            Serial.println("Unpair tapped");
            closeSettings();
            unpairDevice();
        } else {
            unpairArmedUntil = millis() + 3000;
        }
    } else if (tapped(setRowButton(ROW_HEAD))) {
        glideHeadTo(0, HOME_PITCH);
        Serial.println("Head: center");
    } else if (tapped(setRowButton(ROW_POWER))) {
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
    intakeToday = -1;
    intakeGoal = 0;
    Serial.println("Device key cleared");
}

// ---------------------------------------------------------------- account check

// Asks the backend whose account this key belongs to; a 401 means the device
// was removed on the website. Runs in its own task because a cold backend
// (scaled to zero) takes 20-30s to answer and the screen must stay live.
// Not a frequent heartbeat: every request wakes the backend and database,
// which then stay billed for several minutes.
static constexpr uint32_t ACCOUNT_CHECK_MS = 6UL * 60 * 60 * 1000;  // when idle
static constexpr uint32_t ACCOUNT_RECHECK_MIN_MS = 60 * 1000;        // on a touch, at most this often
static volatile bool accountCheckBusy = false;
static volatile int accountCheckResult = 0;  // HTTP status of a finished check, 0 = none
static String accountCheckUser;              // set by the task before accountCheckResult
static int accountCheckToday = 0, accountCheckGoal = 0;
static String accountCheckDate;
static bool accountChecked = false;
// A check that got no answer (timeout, cold backend, no network) is retried
// after 2 min, doubling up to 30 min, instead of waiting the full 6 hours.
// No retry after 200 or 401: those are real answers.
static constexpr uint32_t ACCOUNT_RETRY_MIN_MS = 2UL * 60 * 1000, ACCOUNT_RETRY_MAX_MS = 30UL * 60 * 1000;
static uint32_t accountRetryMs = 0;      // current back-off, 0 = no retry pending
static uint32_t accountRetryFrom = 0;    // when the failed check finished
static uint32_t lastAccountCheck = 0;

static void accountCheckTask(void* arg) {
    String* key = (String*)arg;
    String user;
    String date = localDate();
    int today = 0, goal = 0;
    int code = -1;
    {
        HTTPClient http;
        WiFiClient plain;
        WiFiClientSecure secure;
        String url = String(API_BASE_URL) + "/api/device/me";
        if (!date.isEmpty()) url += "?localDate=" + date;
        if (beginHttp(http, plain, secure, url)) {
            http.setTimeout(HTTP_TIMEOUT);
            http.addHeader("X-Device-Key", *key);
            code = http.GET();
            JsonDocument doc;
            if (code == 200 && !deserializeJson(doc, http.getString())) {
                user = (const char*)(doc["username"] | "");
                today = doc["todayCalories"] | 0;
                goal = doc["dailyGoal"] | 0;
            }
            http.end();
        }
    }
    delete key;
    accountCheckUser = user;
    accountCheckToday = today;
    accountCheckGoal = goal;
    accountCheckDate = date;
    accountCheckResult = code == 0 ? -1 : code;
    accountCheckBusy = false;
    vTaskDelete(nullptr);
}

// Tells the backend to revoke this device's key (DELETE /api/device/me), so
// the website stops listing it. Best effort: offline, it's only forgotten here.
static volatile bool unpairBusy = false;

static void unpairTask(void* arg) {
    String* key = (String*)arg;
    int code = -1;
    {
        HTTPClient http;
        WiFiClient plain;
        WiFiClientSecure secure;
        if (beginHttp(http, plain, secure, String(API_BASE_URL) + "/api/device/me")) {
            http.setTimeout(HTTP_TIMEOUT);
            http.addHeader("X-Device-Key", *key);
            code = http.sendRequest("DELETE");
            http.end();
        }
    }
    Serial.printf("Unpair: server answered %d\n", code);
    delete key;
    unpairBusy = false;
    vTaskDelete(nullptr);
}

static void unpairDevice() {
    String key = deviceKey;
    clearDeviceKey();  // the main loop now switches to the pairing screen
    if (key.isEmpty() || WiFi.status() != WL_CONNECTED || unpairBusy) return;
    unpairBusy = true;
    String* arg = new String(key);
    if (xTaskCreate(unpairTask, "unpair", 12288, arg, 1, nullptr) != pdPASS) {
        delete arg;
        unpairBusy = false;
    }
}

static void startAccountCheck() {
    if (accountCheckBusy || todayBusy || deviceKey.isEmpty() || WiFi.status() != WL_CONNECTED || state == State::Uploading)
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
        if (code == 200 || code == 401) {
            accountRetryMs = 0;
        } else {
            accountRetryMs = accountRetryMs ? min(accountRetryMs * 2, ACCOUNT_RETRY_MAX_MS) : ACCOUNT_RETRY_MIN_MS;
            accountRetryFrom = millis();
            Serial.printf("Account check: retrying in %lu s\n", (unsigned long)(accountRetryMs / 1000));
        }
        if (code == 200 && !deviceKey.isEmpty()) {
            if (!accountCheckUser.isEmpty() && accountCheckUser != ownerName) saveOwnerName(accountCheckUser);
            intakeToday = accountCheckToday;
            intakeGoal = accountCheckGoal;
            intakeDate = accountCheckDate;
        } else if (code == 401 && !deviceKey.isEmpty())
            clearDeviceKey();  // removed on the website: the loop switches to pairing
    }
    // Once after boot, then every few hours
    if (!accountChecked || millis() - lastAccountCheck >= ACCOUNT_CHECK_MS
        || (accountRetryMs && millis() - accountRetryFrom >= accountRetryMs))
        startAccountCheck();
}

// ---------------------------------------------------------------- today's list
// Tapping the ring opens today's meals (GET /api/intake/device/today); a meal
// can be deleted there (DELETE /api/intake/device/{id}, today's only). Both
// answer with the updated list and totals. Requests run in a task, one at a
// time, and never alongside an upload or an account check.
struct Meal { int id; String name; int kcal; float grams; time_t at; };
static std::vector<Meal> todayMeals;
static bool todayLoaded = false;        // list fetched since the screen opened
static String todayError;
static bool todayWantFetch = false;     // request waiting for the network
static int todayWantDelete = 0;         // meal id waiting to be deleted
static int todayDeleting = 0;           // meal id being deleted right now
static volatile int todayResult = 0;    // HTTP status of a finished request, 0 = none
static String todayBody;                // response, set before todayResult
static String todayReqDate;             // local day the request was made for
static int todayScroll = 0, todaySel = -1;
// While the page is open it reloads every few seconds, so changes made on the
// website show up; left alone it closes itself (and stops asking).
static constexpr uint32_t TODAY_REFRESH_MS = 10 * 1000, TODAY_IDLE_CLOSE_MS = 3UL * 60 * 1000;
static uint32_t todayLastRequest = 0, todayLastTouch = 0;
static uint32_t deleteArmedUntil = 0;
static bool todayTouching = false, todayDragged = false;
static int todayStartX = 0, todayStartY = 0, todayStartScroll = 0;

static constexpr int TD_ROW_Y = 84, TD_VIEW_H = LCD_H - 4 - TD_ROW_Y;
static constexpr int TD_ROW_H = 36, TD_CARD_H = 32, TD_EXP_H = 42, TD_X = 6, TD_W = LCD_W - 18;

struct TodayReq { String key, date; int deleteId; };

static void todayTask(void* arg) {
    TodayReq* req = (TodayReq*)arg;
    int code = -1;
    String body;
    {
        HTTPClient http;
        WiFiClient plain;
        WiFiClientSecure secure;
        String url = String(API_BASE_URL) + "/api/intake/device/"
                   + (req->deleteId ? String(req->deleteId) : String("today"));
        if (!req->date.isEmpty()) url += "?localDate=" + req->date;
        if (beginHttp(http, plain, secure, url)) {
            http.setTimeout(HTTP_TIMEOUT);
            http.addHeader("X-Device-Key", req->key);
            code = req->deleteId ? http.sendRequest("DELETE") : http.GET();
            if (code > 0) body = http.getString();
            http.end();
        }
    }
    Serial.printf("Today %s: %d\n", req->deleteId ? "delete" : "list", code);
    delete req;
    todayBody = body;
    todayResult = code == 0 ? -1 : code;
    todayBusy = false;
    vTaskDelete(nullptr);
}

static void openToday() {
    todayOpen = true;
    todayLoaded = false;
    todayError = "";
    todayMeals.clear();
    todayScroll = 0;
    todaySel = -1;
    todayWantFetch = true;
    todayWantDelete = 0;
    deleteArmedUntil = 0;
    todayTouching = false;
    todayLastTouch = millis();
    if (aimVisible) hideAim();
    if (state == State::Settling) state = State::Idle;  // no photos while it's open
}

static void applyToday(const String& body, const String& date) {
    JsonDocument doc;
    if (deserializeJson(doc, body)) {
        todayError = "Bad answer from the server";
        return;
    }
    intakeToday = doc["todayCalories"] | 0;
    intakeGoal = doc["dailyGoal"] | 0;
    intakeDate = date;
    int selId = todaySel >= 0 && todaySel < (int)todayMeals.size() ? todayMeals[todaySel].id : 0;
    todayMeals.clear();
    for (JsonObject m : doc["meals"].as<JsonArray>()) {
        String name = (const char*)(m["foodName"] | "");
        if (name.isEmpty()) name = "Unnamed food";
        todayMeals.push_back({m["id"] | 0, name, m["calories"] | 0, m["weightGrams"] | 0.0f,
                              (time_t)(m["createdAtUnix"] | 0LL)});
    }
    todayLoaded = true;
    todayError = "";
    todaySel = -1;
    for (int i = 0; i < (int)todayMeals.size(); i++)
        if (todayMeals[i].id == selId) todaySel = i;
    if (todaySel < 0) deleteArmedUntil = 0;
}

// Top of row i on screen (rows below the opened one move down)
static int todayRowY(int i) {
    return TD_ROW_Y + i * TD_ROW_H + (todaySel >= 0 && i > todaySel ? TD_EXP_H : 0) - todayScroll;
}

static int todayMaxScroll() {
    int content = (int)todayMeals.size() * TD_ROW_H + (todaySel >= 0 ? TD_EXP_H : 0);
    return max(0, content - TD_VIEW_H);
}

static void todayLoop() {
    int code = todayResult;
    if (code != 0) {
        todayResult = 0;
        int deleted = todayDeleting;
        todayDeleting = 0;
        if (code == 200) {
            applyToday(todayBody, todayReqDate);
            // Counts as an account check: the key works
            lastAccountCheck = millis();
            accountRetryMs = 0;
            if (deleted) todaySel = -1;
            todayScroll = constrain(todayScroll, 0, todayMaxScroll());
        } else if (code == 401) {
            clearDeviceKey();  // removed on the website: the loop switches to pairing
        } else if (code == 404 && deleted) {
            todayWantFetch = true;  // already gone (deleted on the website?): reload
            todaySel = -1;
        } else {
            todayError = deleted ? "Couldn't delete, try again" : "Couldn't reach the server";
        }
    }

    if (todayOpen && millis() - todayLastTouch >= TODAY_IDLE_CLOSE_MS) {
        todayOpen = false;  // nobody's looking
        return;
    }
    if (todayOpen && todayLoaded && !todayTouching && millis() - todayLastRequest >= TODAY_REFRESH_MS)
        todayWantFetch = true;
    if (!todayOpen || todayBusy || (!todayWantFetch && !todayWantDelete)) return;
    if (WiFi.status() != WL_CONNECTED) {
        todayError = "Offline";
        return;
    }
    if (accountCheckBusy || state == State::Uploading || deviceKey.isEmpty()) return;  // one TLS connection at a time

    TodayReq* req = new TodayReq{deviceKey, localDate(), todayWantDelete};
    todayReqDate = req->date;
    todayBusy = true;
    if (xTaskCreate(todayTask, "today", 12288, req, 1, nullptr) != pdPASS) {
        delete req;
        todayBusy = false;
        todayError = "Out of memory";
        return;
    }
    todayDeleting = todayWantDelete;
    todayWantDelete = 0;
    todayWantFetch = false;
    todayLastRequest = millis();
}

// Delete button in the opened part of a row, on the right
static Rect todayDeleteRect(int rowY) {
    return {TD_X + TD_W / 2, rowY + TD_CARD_H + 4, TD_W / 2 - 8, TD_EXP_H - 8};
}

static void drawToday() {
    canvas.fillSprite(0x10A2);

    // Rows first; title and summary are painted over what scrolls under them
    if (todayLoaded) {
        for (int i = 0; i < (int)todayMeals.size(); i++) {
            int y = todayRowY(i);
            bool sel = i == todaySel;
            int h = TD_CARD_H + (sel ? TD_EXP_H : 0);
            if (y + h < TD_ROW_Y || y > TD_ROW_Y + TD_VIEW_H) continue;
            const Meal& m = todayMeals[i];
            canvas.fillRoundRect(TD_X, y, TD_W, h, 6, sel ? 0x3186 : 0x2945);
            int midY = y + TD_CARD_H / 2;
            // Time
            char hhmm[6] = "";
            if (m.at > 0) {
                struct tm t;
                localtime_r(&m.at, &t);
                strftime(hhmm, sizeof hhmm, "%H:%M", &t);
            }
            canvas.setFont(&fonts::Font0);
            canvas.setTextColor(TFT_LIGHTGREY);
            canvas.setTextDatum(middle_left);
            canvas.drawString(hhmm, TD_X + 8, midY);
            // Name, then kcal on the right
            int right = TD_X + TD_W - 8;
            canvas.setFont(&fonts::Font2);
            canvas.setTextColor(TFT_WHITE);
            canvas.setTextDatum(middle_right);
            String kcal = String(m.kcal) + " kcal";
            canvas.drawString(kcal, right, midY);
            int nameX = TD_X + 44;
            drawFit(m.name, nameX, midY, right - (int)canvas.textWidth(kcal) - 10 - nameX, middle_left);

            if (sel) {
                // Opened: weight on the left, Delete (two taps) on the right
                Rect del = todayDeleteRect(y);
                canvas.setFont(&fonts::Font2);
                canvas.setTextColor(TFT_LIGHTGREY);
                canvas.setTextDatum(middle_left);
                canvas.drawString(String(m.grams, 1) + " g", TD_X + 10, del.y + del.h / 2);
                bool busy = todayDeleting == m.id || todayWantDelete == m.id;
                bool armed = millis() < deleteArmedUntil;
                drawButton(del, busy ? "Deleting..." : armed ? "Sure?" : "Delete",
                           armed || busy ? (uint16_t)0xF800 : (uint16_t)0x9000, !busy);
            }
        }
        int maxScroll = todayMaxScroll();
        if (maxScroll > 0) {
            int content = TD_VIEW_H + maxScroll;
            int barH = max(16, TD_VIEW_H * TD_VIEW_H / content);
            int barY = TD_ROW_Y + (TD_VIEW_H - barH) * todayScroll / maxScroll;
            canvas.fillRoundRect(LCD_W - 7, barY, 4, barH, 2, TFT_DARKGREY);
        }
    }

    canvas.fillRect(0, 0, LCD_W, TD_ROW_Y - 2, 0x10A2);
    canvas.fillRect(0, TD_ROW_Y + TD_VIEW_H, LCD_W, LCD_H - TD_ROW_Y - TD_VIEW_H, 0x10A2);
    canvas.setTextDatum(middle_left);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString("Today", 10, 21);
    drawButton(BTN_SET_BACK, "Back", 0x2C4A);

    // Summary: eaten / goal, bar, kcal left or over
    if (intakeToday >= 0) {
        bool over = intakeGoal > 0 && intakeToday > intakeGoal;
        uint16_t accent = over ? (uint16_t)0xFD20 : (uint16_t)TFT_GREEN;
        canvas.setFont(&fonts::Font2);
        canvas.setTextDatum(middle_left);
        canvas.setTextColor(over ? accent : (uint16_t)TFT_WHITE);
        String head = String(intakeToday) + (intakeGoal > 0 ? " / " + String(intakeGoal) : String("")) + " kcal";
        canvas.drawString(head, 10, 54);
        if (intakeGoal > 0) {
            canvas.setTextDatum(middle_right);
            canvas.setTextColor(TFT_LIGHTGREY);
            canvas.drawString(over ? String(intakeToday - intakeGoal) + " over" : String(intakeGoal - intakeToday) + " left",
                              LCD_W - 10, 54);
            int w = LCD_W - 20;
            canvas.fillRoundRect(10, 68, w, 6, 3, 0x4208);
            int fill = over ? w : w * intakeToday / intakeGoal;
            if (fill > 0) canvas.fillRoundRect(10, 68, max(fill, 6), 6, 3, accent);
        }
    }

    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(middle_center);
    int msgY = TD_ROW_Y + 50;
    if (!todayError.isEmpty() && !todayLoaded) {
        canvas.setTextColor(TFT_ORANGE);
        canvas.drawString(todayError, LCD_W / 2, msgY);
    } else if (!todayLoaded) {
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Loading...", LCD_W / 2, msgY);
    } else if (todayMeals.empty()) {
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("Nothing logged yet today", LCD_W / 2, msgY);
    } else if (!todayError.isEmpty()) {
        // Loaded, but the last delete failed: say so over the bottom edge
        fillRoundRectAlpha({20, LCD_H - 30, LCD_W - 40, 24}, 12, TFT_BLACK, 200);
        canvas.setTextColor(TFT_ORANGE);
        canvas.drawString(todayError, LCD_W / 2, LCD_H - 18);
    }
}

static void handleTodayTap() {
    if (tapNow || touchHeld) todayLastTouch = millis();
    // List: drag to scroll; a press released without moving is a tap
    if (tapNow && tapY >= TD_ROW_Y && todayLoaded) {
        todayTouching = true;
        todayDragged = false;
        todayStartX = tapX;
        todayStartY = tapY;
        todayStartScroll = todayScroll;
        return;
    }
    if (todayTouching) {
        if (touchHeld) {
            int dy = tapY - todayStartY;
            if (abs(dy) > 8) todayDragged = true;
            if (todayDragged) todayScroll = constrain(todayStartScroll - dy, 0, todayMaxScroll());
            return;
        }
        todayTouching = false;
        if (todayDragged) return;
        int x = todayStartX, y = todayStartY;

        // Delete in the opened row
        if (todaySel >= 0 && todaySel < (int)todayMeals.size() && inRect(x, y, todayDeleteRect(todayRowY(todaySel)))) {
            if (todayDeleting || todayWantDelete) {
                // a delete is already on its way
            } else if (millis() < deleteArmedUntil) {
                todayWantDelete = todayMeals[todaySel].id;
                deleteArmedUntil = 0;
                todayError = "";
            } else {
                deleteArmedUntil = millis() + 3000;
            }
            return;
        }
        // A row: open it, or close it if it's the open one
        for (int i = 0; i < (int)todayMeals.size(); i++) {
            int rowY = todayRowY(i);
            int h = TD_CARD_H + (i == todaySel ? TD_EXP_H : 0);
            if (!inRect(x, y, {TD_X, rowY, TD_W, h})) continue;
            deleteArmedUntil = 0;
            todaySel = todaySel == i ? -1 : i;
            if (todaySel >= 0) {
                // Scroll so the opened row, with its button, is fully visible
                int top = i * TD_ROW_H, bottom = top + TD_CARD_H + TD_EXP_H;
                if (bottom - todayScroll > TD_VIEW_H) todayScroll = bottom - TD_VIEW_H;
                if (top < todayScroll) todayScroll = top;
            }
            todayScroll = constrain(todayScroll, 0, todayMaxScroll());
            return;
        }
        todaySel = -1;  // empty space closes the opened row
        deleteArmedUntil = 0;
        todayScroll = constrain(todayScroll, 0, todayMaxScroll());
        return;
    }
    if (tapped(BTN_SET_BACK)) {
        todayOpen = false;
        todayTouching = false;
    }
}

// ---------------------------------------------------------------- pairing code

// Pairing requests run in a background task: a cold backend (scaled to zero)
// takes 20-30s to answer, and the screen and its Wi-Fi button must stay live.
// Results are only handled from pairingLoop, i.e. while in Mode::Pairing.
static volatile bool pairBusy = false, pairDone = false;
static bool pairReqIsStart = false;
static String pairReqPath, pairReqBody, pairReqResponse;
static int pairReqCode = 0;

static void pairTask(void*) {
    String resp;
    int code = postJson(pairReqPath.c_str(), pairReqBody, resp);
    pairReqResponse = resp;
    pairReqCode = code;
    pairDone = true;
    pairBusy = false;
    vTaskDelete(nullptr);
}

static void startPairRequest(bool isStart, const String& path, const String& body) {
    pairReqIsStart = isStart;
    pairReqPath = path;
    pairReqBody = body;
    pairDone = false;
    pairBusy = true;
    if (xTaskCreate(pairTask, "pair", 12288, nullptr, 1, nullptr) != pdPASS) {
        pairBusy = false;
        nextPairPoll = millis() + 5000;
        Serial.println("Pairing: no memory for task");
    }
}

// Got a fresh 6-digit code; the private token stays here
static void onPairStart(int code, const String& resp) {
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

// Has someone entered our code on the website yet?
static void onPairPoll(int code, const String& resp) {
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
    if (pairBusy || unpairBusy) return;  // one TLS connection at a time
    if (pairDone) {
        pairDone = false;
        if (pairReqIsStart) onPairStart(pairReqCode, pairReqResponse);
        else onPairPoll(pairReqCode, pairReqResponse);
        return;
    }
    if (WiFi.status() != WL_CONNECTED) return;
    if (millis() < nextPairPoll) return;
    if (pairToken.isEmpty() || millis() > pairExpiresAt)
        startPairRequest(true, "/api/device/pairing/start",
                         "{\"name\":\"Stack-chan\",\"hardwareId\":\"" + WiFi.macAddress() + "\"}");
    else
        startPairRequest(false, "/api/device/pairing/poll", String("{\"pairingToken\":\"") + pairToken + "\"}");
}

// ---------------------------------------------------------------- on-device Wi-Fi setup

static void startWifiScan() {
    net::startScan();
    wifiScanning = true;
    wifiList.clear();
    wifiScroll = 0;
    wifiSel = -1;
}

static void enterWifiSetup() {
    wifiFromSettings = false;  // set by the Settings row after calling this
    mode = Mode::WifiSetup;
    wifiScreen = WifiScreen::List;
    settingsOpen = false;
    net::pause(true);  // no background reconnects while the user chooses
    startWifiScan();
}

static void exitWifiSetup() {
    if (net::portalActive()) net::stopPortal();
    net::pause(false);
    mode = Mode::Normal;
    // Opened from Settings: back to Settings (unless unpaired: pairing comes first)
    if (wifiFromSettings && !deviceKey.isEmpty()) {
        settingsOpen = true;
        powerArmedUntil = unpairArmedUntil = 0;
    }
    wifiFromSettings = false;
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

// The network we're on right now ("" when offline)
static String connectedSsid() { return WiFi.status() == WL_CONNECTED ? WiFi.SSID() : String(); }

enum class WlAction { Connect, Disconnect, Password, Forget };

// What the opened row offers, depending on the network's state
static std::vector<WlAction> wifiActions(const net::Network& n) {
    std::vector<WlAction> a;
    bool connected = n.ssid == connectedSsid();
    a.push_back(connected ? WlAction::Disconnect : WlAction::Connect);
    if (!n.open && (connected || n.saved)) a.push_back(WlAction::Password);
    if (n.saved) a.push_back(WlAction::Forget);
    return a;
}

static Rect wifiActionRect(int rowY, int k, int count) {
    const int gap = 6, inner = WL_W - 16;
    int w = (inner - gap * (count - 1)) / count;
    return {WL_X + 8 + k * (w + gap), rowY + WL_CARD_H + 4, w, WL_EXP_H - 8};
}

// Top of row i in screen coordinates (rows below the opened one move down)
static int wifiRowY(int i) {
    return WL_ROW_Y + i * WL_ROW_H + (wifiSel >= 0 && i > wifiSel ? WL_EXP_H : 0) - wifiScroll;
}

static int wifiMaxScroll() {
    int content = (int)wifiList.size() * WL_ROW_H + (wifiSel >= 0 ? WL_EXP_H : 0);
    return max(0, content - WL_VIEW_H);
}

static void drawWifiList() {
    canvas.fillSprite(0x10A2);
    String cur = connectedSsid();

    // Rows first; the title and button bars are painted over whatever
    // scrolls under them (drawFit's own clip rect rules out a list clip)
    for (int i = 0; i < (int)wifiList.size() && !wifiScanning; i++) {
        int y = wifiRowY(i);
        bool open = i == wifiSel;
        int h = WL_CARD_H + (open ? WL_EXP_H : 0);
        if (y + h < WL_ROW_Y || y > WL_ROW_Y + WL_VIEW_H) continue;
        const auto& n = wifiList[i];
        bool connected = n.ssid == cur;
        canvas.fillRoundRect(WL_X, y, WL_W, h, 6, connected ? 0x0B46 : open ? 0x3186 : 0x2945);
        if (connected) canvas.drawRoundRect(WL_X, y, WL_W, h, 6, TFT_GREEN);
        int right = WL_X + WL_W;
        int midY = y + WL_CARD_H / 2;
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_WHITE);
        // Name, up to the "connected"/"saved" mark, then signal bars and lock
        int markW = connected ? 62 : n.saved ? 34 : 0;
        drawFit(n.ssid, WL_X + 8, midY, right - 52 - markW - (WL_X + 8), middle_left);
        if (connected || n.saved) {
            canvas.setFont(&fonts::Font0);
            canvas.setTextColor(TFT_GREEN);
            canvas.setTextDatum(middle_right);
            canvas.drawString(connected ? "connected" : "saved", right - 52, midY);
            canvas.setFont(&fonts::Font2);
        }
        drawSignalBars(right - 46, y + 9, n.rssi);
        if (!n.open) drawLock(right - 18, y + 11);

        if (open) {
            auto acts = wifiActions(n);
            for (int k = 0; k < (int)acts.size(); k++) {
                Rect r = wifiActionRect(y, k, acts.size());
                bool armed = millis() < forgetArmedUntil;
                switch (acts[k]) {
                    case WlAction::Connect:    drawButton(r, "Connect", 0x2C4A); break;
                    case WlAction::Disconnect: drawButton(r, "Disconnect", 0x7A00); break;
                    case WlAction::Password:   drawButton(r, "Password", 0x2C4A); break;
                    case WlAction::Forget:
                        drawButton(r, armed ? "Sure?" : "Forget", armed ? (uint16_t)0xF800 : (uint16_t)0x9000);
                        break;
                }
            }
        }
    }

    // Scroll bar
    int maxScroll = wifiMaxScroll();
    if (maxScroll > 0 && !wifiScanning) {
        int content = WL_VIEW_H + maxScroll;
        int barH = max(16, WL_VIEW_H * WL_VIEW_H / content);
        int barY = WL_ROW_Y + (WL_VIEW_H - barH) * wifiScroll / maxScroll;
        canvas.fillRoundRect(LCD_W - 7, barY, 4, barH, 2, TFT_DARKGREY);
    }

    canvas.fillRect(0, 0, LCD_W, WL_ROW_Y - 2, 0x10A2);
    canvas.fillRect(0, WL_ROW_Y + WL_VIEW_H, LCD_W, LCD_H - WL_ROW_Y - WL_VIEW_H, 0x10A2);
    canvas.setTextDatum(middle_left);
    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString("Wi-Fi", 10, 21);
    drawButton(BTN_SET_BACK, "Back", 0x2C4A);

    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(middle_center);
    if (wifiScanning) {
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Scanning...", LCD_W / 2, 110);
    } else if (wifiList.empty()) {
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("No networks found", LCD_W / 2, 100);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("Only 2.4 GHz Wi-Fi is visible", LCD_W / 2, 122);
    }

    drawButton(BTN_WL_RESCAN, "Rescan", 0x2C4A, !wifiScanning);
    drawButton(BTN_WL_PHONE, "Phone setup", 0x2C4A);
    canvas.pushSprite(0, 0);
}


static void runWifiAction(const net::Network& n, WlAction a) {
    chosenSsid = n.ssid;
    kbNote = "";
    switch (a) {
        case WlAction::Connect:
            if (n.open) {
                typedPass = "";
                startJoin();
            } else if (n.saved) {
                typedPass = net::savedPassword(chosenSsid);  // wrong one -> back to the keyboard
                startJoin();
            } else {
                typedPass = "";
                kbLayer = 0;
                wifiScreen = WifiScreen::Password;
            }
            break;
        case WlAction::Password:
            typedPass = net::savedPassword(chosenSsid);  // edit the saved one ("" if none)
            kbLayer = 0;
            wifiScreen = WifiScreen::Password;
            break;
        case WlAction::Disconnect:
            Serial.printf("Wi-Fi: disconnected from '%s' by user\n", n.ssid.c_str());
            net::disconnect();
            break;
        case WlAction::Forget:
            if (millis() < forgetArmedUntil) {
                Serial.printf("Wi-Fi: forgot '%s'\n", n.ssid.c_str());
                net::forget(n.ssid);
                wifiList[wifiSel].saved = false;
                forgetArmedUntil = 0;
            } else {
                forgetArmedUntil = millis() + 3000;
            }
            break;
    }
}

// A tap (not a drag) inside the list
static void handleWifiListClick(int x, int y) {
    // Buttons of the opened row
    if (wifiSel >= 0 && wifiSel < (int)wifiList.size()) {
        auto acts = wifiActions(wifiList[wifiSel]);
        int rowY = wifiRowY(wifiSel);
        for (int k = 0; k < (int)acts.size(); k++) {
            if (!inRect(x, y, wifiActionRect(rowY, k, acts.size()))) continue;
            runWifiAction(wifiList[wifiSel], acts[k]);
            return;
        }
    }
    for (int i = 0; i < (int)wifiList.size(); i++) {
        int rowY = wifiRowY(i);
        int h = WL_CARD_H + (i == wifiSel ? WL_EXP_H : 0);
        if (!inRect(x, y, {WL_X, rowY, WL_W, h})) continue;
        forgetArmedUntil = 0;
        wifiSel = wifiSel == i ? -1 : i;  // tap again to close
        if (wifiSel >= 0) {
            // Scroll so the opened row, with its buttons, is fully visible
            int top = i * WL_ROW_H, bottom = top + WL_CARD_H + WL_EXP_H;
            if (bottom - wifiScroll > WL_VIEW_H) wifiScroll = bottom - WL_VIEW_H;
            if (top < wifiScroll) wifiScroll = top;
        }
        wifiScroll = constrain(wifiScroll, 0, wifiMaxScroll());
        return;
    }
    wifiSel = -1;  // empty space closes the opened row
    wifiScroll = constrain(wifiScroll, 0, wifiMaxScroll());
}

static void handleWifiListTap() {
    if (wifiScanning && net::scanDone()) {
        wifiScanning = false;
        wifiList = net::scanResults();
        // Current network first (added if the scan happened to miss it)
        String cur = connectedSsid();
        if (cur.length()) {
            auto it = std::find_if(wifiList.begin(), wifiList.end(),
                                   [&](const net::Network& n) { return n.ssid == cur; });
            net::Network c = it != wifiList.end() ? *it : net::Network{cur, (int)WiFi.RSSI(), false, true};
            if (it != wifiList.end()) wifiList.erase(it);
            wifiList.insert(wifiList.begin(), c);
        }
    }

    // List: drag to scroll; a press released without moving is a tap
    if (tapNow && tapY >= WL_ROW_Y && tapY < WL_ROW_Y + WL_VIEW_H && !wifiScanning) {
        listTouching = true;
        listDragged = false;
        listStartX = tapX;
        listStartY = tapY;
        listStartScroll = wifiScroll;
        return;
    }
    if (listTouching) {
        if (touchHeld) {
            int dy = tapY - listStartY;
            if (abs(dy) > 8) listDragged = true;
            if (listDragged) wifiScroll = constrain(listStartScroll - dy, 0, wifiMaxScroll());
        } else {
            listTouching = false;
            if (!listDragged) handleWifiListClick(listStartX, listStartY);
        }
        return;
    }

    if (!tapNow) return;
    if (tapped(BTN_WL_RESCAN) && !wifiScanning) startWifiScan();
    else if (tapped(BTN_WL_PHONE)) {
        wifiScreen = WifiScreen::Phone;
        net::startPortal();
    } else if (tapped(BTN_SET_BACK)) {
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
    canvas.drawString("Phone setup", 8, 6);

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
    drawFit(m, 8, LCD_H - 36, LCD_W - 16, top_left);

    drawButton(BTN_SETUP_EXIT, "Back", 0x2C4A);
    canvas.pushSprite(0, 0);
}

static void handleSetupTap() {
    if (tapped(BTN_SETUP_EXIT)) {
        // Back to choosing on the device
        net::stopPortal();
        net::pause(true);
        wifiScreen = WifiScreen::List;
        startWifiScan();
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
        intakeToday = today;
        intakeGoal = doc["dailyGoal"] | 0;
        intakeDate = date;
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
        // The tap that left setup is used up: Exit sits where the pairing
        // screen's Wi-Fi button is, and would send us straight back in
        tapNow = false;
    }

    net::maintain();
    logWifiChanges();
    accountLoop();

    // No key yet (first run, or removed on the website): show a pairing code
    if (mode == Mode::Normal && deviceKey.isEmpty()) {
        mode = Mode::Pairing;
        settingsOpen = false;
        accountMenuOpen = false;
        todayOpen = false;
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
        // Off to Wi-Fi setup: its screen is drawn next loop (don't flash
        // the weighing screen in between)
        if (mode == Mode::WifiSetup) return;
        tapNow = false;  // same for the tap (if any) that ended pairing
    }

    // Someone is using the device: a good moment to notice it was removed on
    // the website (a 401 sends it to the pairing screen). Costs nothing while
    // nobody touches it.
    if (tapNow && !todayOpen && !tapped(intakeRingRect) && millis() - lastAccountCheck >= ACCOUNT_RECHECK_MIN_MS)
        startAccountCheck();
    todayLoop();

    if (accountMenuOpen) {
        if (tapNow) {
            if (tapped(BTN_UNPAIR)) {
                if (millis() < unpairArmedUntil) {
                    Serial.println("Unpair tapped");
                    accountMenuOpen = false;
                    settingsOpen = false;
                    unpairDevice();
                } else {
                    unpairArmedUntil = millis() + 3000;
                }
            } else {
                accountMenuOpen = false;  // Close, or anywhere outside the buttons
            }
        }
    } else if (accountTagRect.w > 0 && state != State::Uploading && tapped(accountTagRect)) {
        accountMenuOpen = true;
        unpairArmedUntil = 0;
        if (aimVisible) hideAim();
        if (state == State::Settling) state = State::Idle;  // no photos while it's open
    } else if (todayOpen) {
        handleTodayTap();
    } else if (intakeRingRect.w > 0 && state != State::Uploading && !settingsOpen && tapped(intakeRingRect)) {
        openToday();
    } else if (settingsOpen) {
        handleSettingsTap();
        if (mode == Mode::WifiSetup) return;  // Wi-Fi button: draw its screen next loop
    } else if (state != State::Uploading) {
        handleJoystick();
        if (tapped({GEAR_X, GEAR_Y, GEAR_W, GEAR_H})) {
            if (aimVisible) hideAim();
            settingsOpen = true;
            powerArmedUntil = 0;
            unpairArmedUntil = 0;
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
    if (cameraOk && state != State::Uploading && !holdingPhoto && !settingsOpen && !todayOpen) {
        camera_fb_t* fb = esp_camera_fb_get();
        if (fb) {
            downscale((const uint16_t*)fb->buf);
            esp_camera_fb_return(fb);
        }
    }

    switch (state) {
        case State::Idle:
            if (!settingsOpen && !todayOpen && !aimVisible && !accountMenuOpen && !zeroing() && weight >= MIN_FOOD_GRAMS) {
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
                } else if (WiFi.status() == WL_CONNECTED && !accountCheckBusy && !todayBusy) {
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
