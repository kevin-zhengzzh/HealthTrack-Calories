#include "netsetup.h"

#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_random.h>
#include <algorithm>
#include <vector>

namespace net {
namespace {

// ---- Saved networks (NVS namespace "net": count, s0..s4, p0..p4) ----

struct Saved { String ssid, pass; };
std::vector<Saved> saved;

void load() {
    saved.clear();
    Preferences p;
    if (!p.begin("net", true)) return;
    int n = min((int)p.getUChar("count", 0), MAX_NETWORKS);
    for (int i = 0; i < n; i++) {
        String s = p.getString(("s" + String(i)).c_str(), "");
        if (s.length()) saved.push_back({s, p.getString(("p" + String(i)).c_str(), "")});
    }
    p.end();
}

void store() {
    Preferences p;
    p.begin("net", false);
    p.clear();
    p.putUChar("count", saved.size());
    for (size_t i = 0; i < saved.size(); i++) {
        p.putString(("s" + String(i)).c_str(), saved[i].ssid);
        p.putString(("p" + String(i)).c_str(), saved[i].pass);
    }
    p.end();
}

// Newest first; re-adding a network moves it to the front with the new password
void remember(const String& ssid, const String& pass) {
    for (size_t i = 0; i < saved.size(); i++) {
        if (saved[i].ssid == ssid) { saved.erase(saved.begin() + i); break; }
    }
    saved.insert(saved.begin(), {ssid, pass});
    if ((int)saved.size() > MAX_NETWORKS) saved.resize(MAX_NETWORKS);
    store();
}

const Saved* findSaved(const String& ssid) {
    for (auto& s : saved) if (s.ssid == ssid) return &s;
    return nullptr;
}

// Known networks visible in the last scan, strongest first
std::vector<const Saved*> visibleKnown(int found) {
    std::vector<std::pair<int, const Saved*>> hits;
    for (int i = 0; i < found; i++) {
        const Saved* s = findSaved(WiFi.SSID(i));
        if (!s) continue;
        bool dup = false;
        for (auto& h : hits) if (h.second == s) { h.first = max(h.first, (int)WiFi.RSSI(i)); dup = true; }
        if (!dup) hits.push_back({WiFi.RSSI(i), s});
    }
    std::sort(hits.begin(), hits.end(),
              [](const std::pair<int, const Saved*>& a, const std::pair<int, const Saved*>& b) { return a.first > b.first; });
    std::vector<const Saved*> out;
    for (auto& h : hits) out.push_back(h.second);
    return out;
}

// ---- Connection attempts and why they fail ----

constexpr uint32_t RETRY_MS = 20000;
uint32_t lastTry = 0;
bool scanning = false;

String attemptSsid;            // network we're currently trying
uint8_t lastReason = 0;        // last disconnect reason from the driver
uint32_t lastReasonAt = 0;
bool offByUser = false;        // disconnected from the Wi-Fi list on purpose

void join(const String& ssid, const String& pass) {
    offByUser = false;
    attemptSsid = ssid;
    WiFi.disconnect(false);
    WiFi.begin(ssid.c_str(), pass.c_str());
}

bool paused = false;

// On-device scan results
bool uiScanRunning = false;
std::vector<Network> uiResults;
uint32_t joinStartedAt = 0;

// ---- Portal ----

DNSServer dns;
WebServer server(80);
bool active = false;
String ssidAp, passAp;
PortalState state = PortalState::Idle;
String message;
uint32_t savedAt = 0, lastActivity = 0;
constexpr uint32_t REPLY_GRACE_MS = 3000;          // let the phone get the "saved" page
constexpr uint32_t IDLE_EXIT_MS = 5 * 60 * 1000UL; // leave setup if nobody uses it
// A fixed, common channel keeps the hotspot easy to find. The station side
// stays idle while the portal is up, so nothing makes the radio hop away.
constexpr int AP_CHANNEL = 6;

struct Seen { String ssid; int rssi; bool open; };
std::vector<Seen> seen;

void scanForPage() {
    int n = WiFi.scanNetworks();
    seen.clear();
    for (int i = 0; i < n; i++) {
        String s = WiFi.SSID(i);
        if (!s.length()) continue;  // hidden networks: use the manual field
        bool dup = false;
        for (auto& x : seen) if (x.ssid == s) { x.rssi = max(x.rssi, (int)WiFi.RSSI(i)); dup = true; }
        if (!dup) seen.push_back({s, WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN});
    }
    WiFi.scanDelete();
    std::sort(seen.begin(), seen.end(), [](const Seen& a, const Seen& b) { return a.rssi > b.rssi; });
    if (seen.size() > 20) seen.resize(20);
}

String esc(const String& s) {
    String o;
    for (char c : s) {
        switch (c) {
            case '&': o += "&amp;"; break;
            case '<': o += "&lt;"; break;
            case '>': o += "&gt;"; break;
            case '"': o += "&quot;"; break;
            case '\'': o += "&#39;"; break;
            default: o += c;
        }
    }
    return o;
}

const char* PAGE_HEAD = R"(<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Stack-chan Wi-Fi</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f4f6f5;color:#1a1a1a}
main{max-width:420px;margin:0 auto;padding:20px 16px}h1{font-size:1.4em;margin:.2em 0 .1em}
p.sub{color:#666;margin:0 0 1em}.net{display:flex;align-items:center;gap:10px;padding:12px;background:#fff;
border-radius:10px;margin-bottom:8px;border:2px solid transparent}.net input{margin:0}
.net:has(input:checked){border-color:#16a34a}.name{flex:1;word-break:break-all}.bars{color:#16a34a;letter-spacing:-2px}
label.f{display:block;margin:14px 0 4px;font-weight:600}input[type=text],input[type=password]{width:100%;box-sizing:border-box;
padding:12px;font-size:16px;border:1px solid #ccc;border-radius:10px}button{width:100%;padding:14px;font-size:16px;
font-weight:600;color:#fff;background:#16a34a;border:0;border-radius:10px;margin-top:16px}
a{color:#16a34a}.saved{color:#666;font-size:.9em;margin-top:24px}.msg{padding:14px;border-radius:10px;background:#fff;margin-top:12px}
.ok{background:#dcfce7}.bad{background:#fee2e2}</style></head><body><main>)";

String bars(int rssi) {
    int n = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -75 ? 2 : 1;
    String b;
    for (int i = 0; i < 4; i++) b += i < n ? "&#9608;" : "&#9617;";
    return b;
}

void handleRoot() {
    lastActivity = millis();
    if (server.hasArg("rescan")) scanForPage();
    String h = PAGE_HEAD;
    h += "<h1>Connect Stack-chan to Wi-Fi</h1><p class=sub>Pick the network Stack-chan should use. "
         "Only 2.4&nbsp;GHz networks are shown &mdash; that's all it can see.</p>";
    h += "<form method=post action=/connect>";
    if (seen.empty()) h += "<p>No networks found. <a href=/?rescan=1>Scan again</a></p>";
    for (size_t i = 0; i < seen.size(); i++) {
        h += "<label class=net><input type=radio name=ssid value=\"" + esc(seen[i].ssid) + "\"";
        if (i == 0) h += " checked";
        h += "><span class=name>" + esc(seen[i].ssid);
        if (findSaved(seen[i].ssid)) h += " <small>(saved)</small>";
        h += "</span><span class=bars>" + bars(seen[i].rssi) + "</span>";
        if (!seen[i].open) h += "&#128274;";
        h += "</label>";
    }
    h += "<label class=f>Not listed? Network name</label><input type=text name=manual maxlength=32 "
         "placeholder=\"Leave empty to use the one picked above\" autocapitalize=off autocorrect=off>";
    h += "<label class=f>Password</label><input type=password name=pass maxlength=63 "
         "placeholder=\"Empty for open networks\">";
    h += "<button>Save</button></form><p><a href=/?rescan=1>Scan again</a></p>";
    if (!saved.empty()) {
        h += "<div class=saved>Saved networks: ";
        for (size_t i = 0; i < saved.size(); i++) h += (i ? ", " : "") + esc(saved[i].ssid);
        h += "<form method=post action=/forget><button style=\"background:#999\">Forget all saved networks</button></form></div>";
    }
    h += "</main></body></html>";
    server.send(200, "text/html", h);
}

void handleConnect() {
    lastActivity = millis();
    String ssid = server.arg("manual");
    ssid.trim();
    if (!ssid.length()) ssid = server.arg("ssid");
    String pass = server.arg("pass");
    if (!ssid.length() || ssid.length() > 32 || (pass.length() && (pass.length() < 8 || pass.length() > 63))) {
        server.send(400, "text/html", String(PAGE_HEAD) +
            "<div class='msg bad'>Check the network name, and that the password is 8&ndash;63 characters.</div>"
            "<p><a href=/>Back</a></p></main></body></html>");
        return;
    }
    // Save now and let the device connect in the background. Testing the
    // network here would keep the phone waiting — and once the device joins
    // a router on another channel, the hotspot moves and the phone drops
    // before it ever sees the result.
    remember(ssid, pass);
    state = PortalState::Saved;
    message = "Saved " + ssid;
    savedAt = millis();
    Serial.printf("Portal: saved '%s'\n", ssid.c_str());
    server.send(200, "text/html", String(PAGE_HEAD) +
        "<h1>Saved</h1><div class='msg ok'>Stack-chan will now connect to <b>" + esc(ssid) + "</b>. "
        "Watch its screen: it shows if the password is wrong or the signal is too weak.</div>"
        "<p class=sub>This hotspot closes in a moment and your phone goes back to its usual network. "
        "You can close this page.</p></main></body></html>");
}

void handleForget() {
    lastActivity = millis();
    forgetAll();
    server.sendHeader("Location", "/", true);
    server.send(303, "text/plain", "");
}

// Phones probe these URLs to detect a sign-in page; send them to ours
void redirectHome() {
    lastActivity = millis();
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    server.send(302, "text/plain", "");
}

}  // namespace

void begin() {
    load();
    WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
        uint8_t r = info.wifi_sta_disconnected.reason;
        if (r == WIFI_REASON_ASSOC_LEAVE) return;  // our own disconnect() before a retry
        lastReason = r;
        lastReasonAt = millis();
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
}

void addNetwork(const String& ssid, const String& pass) { remember(ssid, pass); }
int savedCount() { return saved.size(); }
String savedSsid(int i) { return i >= 0 && i < (int)saved.size() ? saved[i].ssid : String(); }

void forgetAll() {
    saved.clear();
    store();
}

void forget(const String& ssid) {
    for (size_t i = 0; i < saved.size(); i++) {
        if (saved[i].ssid != ssid) continue;
        saved.erase(saved.begin() + i);
        store();
        break;
    }
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == ssid) {
        attemptSsid = "";
        WiFi.disconnect(false, true);  // also drops the SDK's stored credentials
    }
}

void disconnect() {
    offByUser = true;
    attemptSsid = "";
    scanning = false;
    WiFi.disconnect(false);
}

bool isOffByUser() { return offByUser; }

bool connectBest(uint32_t timeoutMs) {
    if (saved.empty()) return false;
    WiFi.mode(WIFI_STA);
    uint32_t start = millis();
    int found = WiFi.scanNetworks();
    auto candidates = visibleKnown(found);
    WiFi.scanDelete();
    // Nothing visible (or a hidden network): still try the most recent one
    if (candidates.empty()) candidates.push_back(&saved[0]);
    for (auto* c : candidates) {
        Serial.printf("Wi-Fi: trying '%s'\n", c->ssid.c_str());
        join(c->ssid, c->pass);
        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000 && millis() - start < timeoutMs) delay(200);
        if (WiFi.status() == WL_CONNECTED) return true;
        if (millis() - start >= timeoutMs) break;
    }
    lastTry = millis();
    return false;
}

void startScan() {
    scanning = false;  // the watchdog's own scan, if any, is abandoned
    // A connection attempt in progress makes the scan fail; stop it (an
    // existing connection is kept, so switching networks still works)
    if (WiFi.status() != WL_CONNECTED) WiFi.disconnect(false);
    WiFi.scanDelete();
    uiResults.clear();
    uiScanRunning = WiFi.scanNetworks(true) == WIFI_SCAN_RUNNING;
}

bool scanDone() {
    if (!uiScanRunning) return true;
    int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING) return false;
    uiScanRunning = false;
    for (int i = 0; i < n; i++) {
        String s = WiFi.SSID(i);
        if (!s.length()) continue;
        bool dup = false;
        for (auto& x : uiResults) if (x.ssid == s) { x.rssi = max(x.rssi, (int)WiFi.RSSI(i)); dup = true; }
        if (!dup) uiResults.push_back({s, WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN, findSaved(s) != nullptr});
    }
    WiFi.scanDelete();
    std::sort(uiResults.begin(), uiResults.end(), [](const Network& a, const Network& b) { return a.rssi > b.rssi; });
    if (uiResults.size() > 20) uiResults.resize(20);
    return true;
}

std::vector<Network> scanResults() { return uiResults; }

String savedPassword(const String& ssid) {
    const Saved* s = findSaved(ssid);
    return s ? s->pass : String();
}

void pause(bool p) {
    paused = p;
    if (p) scanning = false;
    lastTry = millis();
}

void tryJoin(const String& ssid, const String& pass) {
    lastReason = 0;
    lastReasonAt = 0;
    joinStartedAt = millis();
    join(ssid, pass);
}

JoinState joinState(uint32_t timeoutMs) {
    if (WiFi.status() == WL_CONNECTED) return JoinState::Connected;
    uint32_t elapsed = millis() - joinStartedAt;
    if (lastReasonAt >= joinStartedAt && lastReasonAt) {
        switch (lastReason) {
            case WIFI_REASON_AUTH_FAIL:
            case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
            case WIFI_REASON_HANDSHAKE_TIMEOUT:
            case WIFI_REASON_MIC_FAILURE:
                return JoinState::WrongPassword;
            case WIFI_REASON_NO_AP_FOUND:
                if (elapsed > 6000) return JoinState::NotFound;
                break;
        }
    }
    return elapsed > timeoutMs ? JoinState::Failed : JoinState::Trying;
}

void maintain() {
    if (paused || active || offByUser || saved.empty() || WiFi.status() == WL_CONNECTED) {
        scanning = false;
        return;
    }
    if (scanning) {
        int found = WiFi.scanComplete();
        if (found == WIFI_SCAN_RUNNING) return;
        scanning = false;
        if (found < 0) return;  // failed; try again next round
        auto candidates = visibleKnown(found);
        WiFi.scanDelete();
        if (!candidates.empty()) {
            Serial.printf("Wi-Fi watchdog: joining '%s'\n", candidates[0]->ssid.c_str());
            join(candidates[0]->ssid, candidates[0]->pass);
        } else {
            attemptSsid = "";
            lastReason = WIFI_REASON_NO_AP_FOUND;
            lastReasonAt = millis();
        }
        return;
    }
    if (millis() - lastTry < RETRY_MS) return;
    lastTry = millis();
    if (saved.size() == 1) {
        // One network: no need to scan, just retry it (the library gives up
        // on some disconnect reasons, e.g. ASSOC_LEAVE)
        Serial.println("Wi-Fi watchdog: retrying");
        join(saved[0].ssid, saved[0].pass);
    } else {
        WiFi.disconnect(false);
        WiFi.scanNetworks(true);  // async; picked up above
        scanning = true;
    }
}

String statusText() {
    if (WiFi.status() == WL_CONNECTED) return "Online: " + WiFi.SSID();
    if (offByUser) return "Wi-Fi disconnected: Settings > Wi-Fi";
    if (saved.empty()) return "No Wi-Fi saved: Settings > Wi-Fi";
    String name = attemptSsid.length() ? attemptSsid : saved[0].ssid;
    if (!lastReasonAt || millis() - lastReasonAt > 60000) return "Connecting to " + name + "...";
    switch (lastReason) {
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_MIC_FAILURE:
            return "Wrong password for " + name + "?";
        case WIFI_REASON_NO_AP_FOUND:
            return attemptSsid.length() ? name + " not found" : "No saved Wi-Fi in range";
        default:
            return "Weak signal, retrying " + name;
    }
}

void startPortal() {
    if (active) return;
    // Keep the station side quiet while the hotspot is up: background
    // reconnects make the radio change channel, and phones then fail to join
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(false);
    scanning = false;
    WiFi.mode(WIFI_AP_STA);
    scanForPage();

    uint8_t mac[6];
    WiFi.macAddress(mac);
    char id[5];
    snprintf(id, sizeof id, "%02X%02X", mac[4], mac[5]);
    ssidAp = String("StackChan-") + id;
    passAp = String(10000000 + esp_random() % 90000000);  // 8 digits, new each time
    WiFi.softAP(ssidAp.c_str(), passAp.c_str(), AP_CHANNEL);
    delay(100);
    IPAddress ip = WiFi.softAPIP();
    dns.start(53, "*", ip);

    server.on("/", HTTP_GET, handleRoot);
    server.on("/connect", HTTP_POST, handleConnect);
    server.on("/forget", HTTP_POST, handleForget);
    for (const char* probe : {"/generate_204", "/gen_204", "/hotspot-detect.html", "/library/test/success.html",
                              "/connecttest.txt", "/ncsi.txt", "/redirect", "/fwlink", "/canonical.html"})
        server.on(probe, redirectHome);
    server.onNotFound(redirectHome);
    server.begin();

    state = PortalState::Idle;
    message = "";
    lastActivity = millis();
    active = true;
    Serial.printf("Portal: %s up at %s (ch %d)\n", ssidAp.c_str(), ip.toString().c_str(), AP_CHANNEL);
}

void stopPortal() {
    if (!active) return;
    server.stop();
    dns.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    active = false;
    // Try the newest network right away instead of waiting for the watchdog
    lastReason = 0;
    lastReasonAt = 0;
    if (!saved.empty() && WiFi.status() != WL_CONNECTED) join(saved[0].ssid, saved[0].pass);
    lastTry = millis();
    Serial.println("Portal: closed");
}

bool portalActive() { return active; }

void portalLoop() {
    if (!active) return;
    dns.processNextRequest();
    server.handleClient();
    if (WiFi.softAPgetStationNum() > 0) lastActivity = millis();
}

PortalState portalState() { return state; }
String portalMessage() { return message; }

bool portalFinished() {
    if (state == PortalState::Saved) return millis() - savedAt > REPLY_GRACE_MS;
    return !saved.empty() && millis() - lastActivity > IDLE_EXIT_MS;
}

String apSsid() { return ssidAp; }
String apPassword() { return passAp; }
String apQrText() { return "WIFI:T:WPA;S:" + ssidAp + ";P:" + passAp + ";;"; }

}  // namespace net
