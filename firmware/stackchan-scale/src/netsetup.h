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
#include <vector>

namespace net {

constexpr int MAX_NETWORKS = 5;

// ---- On-device setup (pick a network on Stack-chan's own screen) ----

struct Network { String ssid; int rssi; bool open; bool saved; };
void startScan();                     // async; poll scanDone()
bool scanDone();
std::vector<Network> scanResults();   // strongest first, de-duplicated, max 20
String savedPassword(const String& ssid);  // "" if not saved
// Stop background reconnects while the user is choosing (they'd disturb scans)
void pause(bool paused);

enum class JoinState { Trying, Connected, WrongPassword, NotFound, Failed };
void tryJoin(const String& ssid, const String& pass);
JoinState joinState(uint32_t timeoutMs);

void begin();                         // load saved networks, hook Wi-Fi events
void addNetwork(const String& ssid, const String& pass);  // newest first, max MAX_NETWORKS
int savedCount();
String savedSsid(int i);
void forgetAll();
void forget(const String& ssid);      // remove one saved network (disconnects if it's the current one)
// Disconnect on purpose: stays offline (no background reconnects) until a
// network is joined again or Stack-chan restarts
void disconnect();
bool isOffByUser();

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
