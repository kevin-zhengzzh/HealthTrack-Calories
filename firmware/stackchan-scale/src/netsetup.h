// Wi-Fi: saved networks (NVS) and the phone setup portal.
//
// Setup: Stack-chan starts its own hotspot (random password, shown as a QR
// code on screen). A phone that joins it gets a "sign in" page served from
// the device and picks one of the networks Stack-chan can see.
//
// The page only collects the network: it's saved straight away and the
// hotspot closes, so the phone is never left waiting on a slow or failing
// connection. Joining then happens in the background (with retries), and
// the outcome — including "wrong password?" — is shown on Stack-chan's own
// screen via statusText().
#pragma once

#include <Arduino.h>

namespace net {

constexpr int MAX_NETWORKS = 5;

void begin();                         // load saved networks, hook Wi-Fi events
void addNetwork(const String& ssid, const String& pass);  // newest first, max MAX_NETWORKS
int savedCount();
String savedSsid(int i);
void forgetAll();

// Blocking scan + connect to the strongest known network (boot only)
bool connectBest(uint32_t timeoutMs);
// Non-blocking reconnect: async scan, then join the best known network
void maintain();
// One line for the screen while offline, e.g. "Wrong password for X?"
String statusText();

// Phone setup portal
enum class PortalState { Idle, Saved };
void startPortal();
void stopPortal();
bool portalActive();
void portalLoop();                    // call every loop() while active
PortalState portalState();
String portalMessage();
// True once a network was saved (and the phone has had its reply), or after
// a few idle minutes when a network is already saved — so a temporary
// outage doesn't leave the device parked in setup
bool portalFinished();
String apSsid();
String apPassword();
String apQrText();                    // WIFI:... payload for the QR code

}  // namespace net
