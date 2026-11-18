// Stack-chan head (two Feetech SCS0009 bus servos in the official M5Stack
// StackChan body). Angles are in tenths of a degree, as in M5Stack's API.
#pragma once

#include <stdint.h>

namespace head {

// Yaw: left/right. Pitch: 0 = the official "home" pose, larger = head up.
constexpr int YAW_MIN = -900, YAW_MAX = 900;    // kept inside the official ±128° to spare the cable
constexpr int PITCH_MIN = 50, PITCH_MAX = 850;  // M5Stack advises 5°..85° to avoid stalling

// Powers the servos (via the body's PY32 IO expander), opens the servo bus
// and loads the factory zero calibration from NVS. Needs M5.In_I2C.
// waitMs: how long to keep looking for the IO expander (0 = one quick try,
// for retries from loop() that mustn't freeze the screen).
bool begin(uint32_t waitMs = 3000);
bool ok();

// Clamps to the limits above and moves both servos.
void setPose(int yawTenths, int pitchTenths);

}  // namespace head
