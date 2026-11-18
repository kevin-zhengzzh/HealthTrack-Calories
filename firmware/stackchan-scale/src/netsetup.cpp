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
    std::sort(hits.begin(), hits.end(), [](const std::pair<int, const Saved*>& a, const std::pair<int, const Saved*>& b) { return a.first > b.first; });
    std::vector<const Saved*> out;
    for (auto& h : hits) out.push_back(h.second);
    return out;
}

// ---- Reconnect watchdog ----

constexpr uint32_t RETRY_MS = 20000;
uint32_t lastTry = 0;
bool scanning = false;

// ---- Portal ----

DNSServer dns;
WebServer server(80);
bool active = false;
String ssidAp, passAp;
PortalState state = PortalState::Idle;
String message;
// Network being tried from the portal; saved only once it actually connects
String pendingSsid, pendingPass;
uint32_t connectStart = 0, connectedAt = 0;
constexpr uint32_t CONNECT_TIMEOUT_MS = 20000;

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
    h += "<button>Connect</button></form><p><a href=/?rescan=1>Scan again</a></p>";
    if (!saved.empty()) {
        h += "<div class=saved>Saved networks: ";
        for (size_t i = 0; i < saved.size(); i++) h += (i ? ", " : "") + esc(saved[i].ssid);
        h += "<form method=post action=/forget><button style=\"background:#999\">Forget all saved networks</button></form></div>";
    }
    h += "</main></body></html>";
    server.send(200, "text/html", h);
}

void handleConnect() {
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
    pendingSsid = ssid;
    pendingPass = pass;
    state = PortalState::Connecting;
    message = "Connecting to " + ssid + "...";
    connectStart = millis();
    WiFi.disconnect(false);
    WiFi.begin(ssid.c_str(), pass.c_str());
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "text/html", String(PAGE_HEAD) +
        "<h1>Connecting&hellip;</h1><div id=m class=msg>Trying " + esc(ssid) + "</div>"
        "<p id=back hidden><a href=/>Try again</a></p>"
        "<script>const t=setInterval(async()=>{try{const r=await(await fetch('/status')).json();"
        "const m=document.getElementById('m');m.textContent=r.message;"
        "if(r.state==='ok'){m.className='msg ok';clearInterval(t)}"
        "if(r.state==='fail'){m.className='msg bad';document.getElementById('back').hidden=false;clearInterval(t)}"
        "}catch(e){}},1000)</script></main></body></html>");
}

void handleStatus() {
    const char* s = state == PortalState::Connected ? "ok"
                  : state == PortalState::Failed ? "fail"
                  : state == PortalState::Connecting ? "connecting" : "idle";
    String m = message;
    m.replace("\"", "'");
    server.send(200, "application/json", String("{\"state\":\"") + s + "\",\"message\":\"" + m + "\"}");
}

void handleForget() {
    forgetAll();
    server.sendHeader("Location", "/", true);
    server.send(303, "text/plain", "");
}

// Phones probe these URLs to detect a sign-in page; send them to ours
void redirectHome() {
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    server.send(302, "text/plain", "");
}

}  // namespace

void begin() { load(); }
void addNetwork(const String& ssid, const String& pass) { remember(ssid, pass); }
int savedCount() { return saved.size(); }
String savedSsid(int i) { return i >= 0 && i < (int)saved.size() ? saved[i].ssid : String(); }

void forgetAll() {
    saved.clear();
    store();
}

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
        WiFi.begin(c->ssid.c_str(), c->pass.c_str());
        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000 && millis() - start < timeoutMs) delay(200);
        if (WiFi.status() == WL_CONNECTED) return true;
        WiFi.disconnect(false);
        if (millis() - start >= timeoutMs) break;
    }
    lastTry = millis();
    return false;
}

void maintain() {
    if (active || saved.empty() || WiFi.status() == WL_CONNECTED) {
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
            WiFi.begin(candidates[0]->ssid.c_str(), candidates[0]->pass.c_str());
        }
        return;
    }
    if (millis() - lastTry < RETRY_MS) return;
    lastTry = millis();
    if (saved.size() == 1) {
        // One network: no need to scan, just retry it (the library gives up
        // on some disconnect reasons, e.g. ASSOC_LEAVE)
        Serial.println("Wi-Fi watchdog: retrying");
        WiFi.disconnect(false);
        WiFi.begin(saved[0].ssid.c_str(), saved[0].pass.c_str());
    } else {
        WiFi.disconnect(false);
        WiFi.scanNetworks(true);  // async; picked up above
        scanning = true;
    }
}

void startPortal() {
    if (active) return;
    WiFi.disconnect(false);
    WiFi.mode(WIFI_AP_STA);
    scanForPage();

    uint8_t mac[6];
    WiFi.macAddress(mac);
    char id[5];
    snprintf(id, sizeof id, "%02X%02X", mac[4], mac[5]);
    ssidAp = String("StackChan-") + id;
    passAp = String(10000000 + esp_random() % 90000000);  // 8 digits, new each time
    WiFi.softAP(ssidAp.c_str(), passAp.c_str());
    delay(100);
    IPAddress ip = WiFi.softAPIP();
    dns.start(53, "*", ip);

    server.on("/", HTTP_GET, handleRoot);
    server.on("/connect", HTTP_POST, handleConnect);
    server.on("/status", HTTP_GET, handleStatus);
    server.on("/forget", HTTP_POST, handleForget);
    for (const char* probe : {"/generate_204", "/gen_204", "/hotspot-detect.html", "/library/test/success.html",
                              "/connecttest.txt", "/ncsi.txt", "/redirect", "/fwlink", "/canonical.html"})
        server.on(probe, redirectHome);
    server.onNotFound(redirectHome);
    server.begin();

    state = PortalState::Idle;
    message = "";
    active = true;
    Serial.printf("Portal: %s up at %s\n", ssidAp.c_str(), ip.toString().c_str());
}

void stopPortal() {
    if (!active) return;
    server.stop();
    dns.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);  // keeps the station connection if there is one
    active = false;
    lastTry = millis();
    Serial.println("Portal: closed");
}

bool portalActive() { return active; }

void portalLoop() {
    if (!active) return;
    dns.processNextRequest();
    server.handleClient();
    if (state != PortalState::Connecting) return;

    wl_status_t st = WiFi.status();
    if (st == WL_CONNECTED) {
        remember(pendingSsid, pendingPass);
        pendingPass = "";
        state = PortalState::Connected;
        message = "Connected to " + pendingSsid + ". You can close this page.";
        connectedAt = millis();
        Serial.printf("Portal: connected to '%s', saved\n", pendingSsid.c_str());
    } else if (st == WL_NO_SSID_AVAIL && millis() - connectStart > 5000) {
        state = PortalState::Failed;
        message = "Can't find " + pendingSsid + ". Is it 2.4 GHz and in range?";
    } else if (millis() - connectStart > CONNECT_TIMEOUT_MS) {
        state = PortalState::Failed;
        message = "Couldn't join " + pendingSsid + ". Check the password and try again.";
    }
    if (state == PortalState::Failed) WiFi.disconnect(false);
}

PortalState portalState() { return state; }
String portalMessage() { return message; }
bool portalFinished() { return state == PortalState::Connected && millis() - connectedAt > 6000; }
String apSsid() { return ssidAp; }
String apPassword() { return passAp; }
String apQrText() { return "WIFI:T:WPA;S:" + ssidAp + ";P:" + passAp + ";;"; }

}  // namespace net
