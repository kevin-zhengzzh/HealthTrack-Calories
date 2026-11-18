// Mirrors what M5Stack's official StackChan firmware does in hal_servo.cpp and
// hal_io_expander.cpp (github.com/m5stack/StackChan), minus the animation layer.
#include "head.h"

#include <M5Unified.h>
#include <Preferences.h>
#include "SCSCL.h"

namespace head {
namespace {

// PY32 IO expander in the StackChan body; its pin 0 switches servo power (VM_EN)
constexpr uint8_t IOE_ADDR = 0x6F;
constexpr uint8_t REG_VERSION = 0x02, REG_DIR_L = 0x03, REG_OUT_L = 0x05, REG_PU_L = 0x09, REG_PD_L = 0x0B;
// 100kHz like the official driver: at 400kHz the PY32 answers an address
// scan but register reads come back 0 on most boots
constexpr uint32_t I2C_FREQ = 100000;
constexpr uint8_t VM_EN = 1 << 0;

// Servo bus: UART1 at 1Mbps on GPIO 6 (TX) / 7 (RX)
constexpr int YAW_ID = 1, PITCH_ID = 2;
constexpr uint8_t MODE_POSITION = 0;

SCSCL bus;
bool ready = false;
bool busStarted = false;
// Raw servo position (0..1000, 0.3125° per step) that corresponds to angle 0.
// Factory-calibrated values live in NVS, written by the original firmware.
int zeroYaw = 460, zeroPitch = 620;

int toRaw(int zero, int tenths) {
    return constrain(zero + tenths * 16 / 50, 0, 1000);
}

bool powerOnServos(uint32_t waitMs) {
    uint8_t version = 0;
    uint32_t start = millis();
    do {  // the PY32 can boot slowly after a cold start
        version = M5.In_I2C.readRegister8(IOE_ADDR, REG_VERSION, I2C_FREQ);
        if (version != 0 && version != 0xFF) break;
        if (waitMs) delay(200);
    } while (millis() - start < waitMs);
    if (version == 0 || version == 0xFF) {
        Serial.printf("Head: IO expander not found (read 0x%02X)\n", version);
        if (waitMs) {  // diagnostics, boot only
            bool found[128] = {};
            M5.In_I2C.scanID(found, 100000);
            Serial.print("Head: internal I2C devices:");
            for (int a = 8; a < 120; a++) if (found[a]) Serial.printf(" 0x%02X", a);
            Serial.println();
        }
        return false;
    }
    M5.In_I2C.bitOn(IOE_ADDR, REG_DIR_L, VM_EN, I2C_FREQ);   // output
    M5.In_I2C.bitOff(IOE_ADDR, REG_PD_L, VM_EN, I2C_FREQ);
    M5.In_I2C.bitOn(IOE_ADDR, REG_PU_L, VM_EN, I2C_FREQ);    // pull-up
    M5.In_I2C.bitOn(IOE_ADDR, REG_OUT_L, VM_EN, I2C_FREQ);   // power on
    delay(200);
    Serial.printf("Head: servo power on (IO expander v0x%02X)\n", version);
    return true;
}

void loadCalibration() {
    Preferences p;
    if (!p.begin("servo", true)) return;  // namespace of the original firmware
    int y = p.getInt("zero_pos_1", -1);
    int t = p.getInt("zero_pos_2", -1);
    p.end();
    if (y >= 0 && y <= 1000) zeroYaw = y;
    if (t >= 0 && t <= 1000) zeroPitch = t;
}

}  // namespace

bool begin(uint32_t waitMs) {
    if (ready) return true;
    if (!powerOnServos(waitMs)) return false;
    if (!busStarted) {  // safe to call begin() again after a failed attempt
        if (!bus.begin(UART_NUM_1, 1000000, 6, 7)) {
            Serial.println("Head: servo bus init failed");
            return false;
        }
        busStarted = true;
    }
    loadCalibration();
    // Freshly powered servos need a moment before they answer
    bool yawOk = false, pitchOk = false;
    for (int i = 0; i < 6 && !(yawOk && pitchOk); i++) {
        if (i) delay(200);
        yawOk = yawOk || bus.Ping(YAW_ID) != -1;
        pitchOk = pitchOk || bus.Ping(PITCH_ID) != -1;
    }
    Serial.printf("Head: yaw servo %s, pitch servo %s, zero yaw=%d pitch=%d\n",
                  yawOk ? "ok" : "MISSING", pitchOk ? "ok" : "MISSING", zeroYaw, zeroPitch);
    ready = yawOk && pitchOk;
    if (ready) {
        bus.SwitchMode(YAW_ID, MODE_POSITION);
        bus.SwitchMode(PITCH_ID, MODE_POSITION);
    }
    return ready;
}

bool ok() { return ready; }

void setPose(int yawTenths, int pitchTenths) {
    if (!ready) return;
    yawTenths = constrain(yawTenths, YAW_MIN, YAW_MAX);
    pitchTenths = constrain(pitchTenths, PITCH_MIN, PITCH_MAX);
    // Same call as the official firmware (time 20, default speed)
    bus.WritePos(YAW_ID, toRaw(zeroYaw, yawTenths), 20, 0);
    bus.WritePos(PITCH_ID, toRaw(zeroPitch, pitchTenths), 20, 0);
}

}  // namespace head
