// Wi-Fi: saved networks (NVS) and the phone setup portal.
//
// Setup: Stack-chan starts its own hotspot (random password, shown as a QR
// code on screen). A phone that joins it gets a "sign in" page served from
// the device, picks one of the networks Stack-chan can see and types the
// password. The network is tested, then saved; up to MAX_NETWORKS are kept
// and the strongest known one is used at boot.
#pragma once

#include <Arduino.h>

namespace net {

constexpr int MAX_NETWORKS = 5;

void begin();                         // load saved networks from NVS
void addNetwork(const String& ssid, const String& pass);  // newest first, max MAX_NETWORKS
int savedCount();
String savedSsid(int i);
void forgetAll();

// Blocking scan + connect to the strongest known network (boot only)
bool connectBest(uint32_t timeoutMs);
// Non-blocking reconnect: async scan, then join the best known network
void maintain();

// Phone setup portal
enum class PortalState { Idle, Connecting, Connected, Failed };
void startPortal();
void stopPortal();
bool portalActive();
void portalLoop();                    // call every loop() while active
PortalState portalState();
String portalMessage();
bool portalFinished();                // connected and the phone has had time to see it
String apSsid();
String apPassword();
String apQrText();                    // WIFI:... payload for the QR code

}  // namespace net
