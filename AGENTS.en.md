# AGENTS.md (English)

> English translation of [`AGENTS.md`](./AGENTS.md). The Chinese file is the original; when they differ, it wins. Update both together.

A handbook for AI agents working in this repo (and for me, looking back later): structure, commands, conventions, **key decisions** and **milestones**.

**Maintenance rule**: whenever a key decision is made, a milestone is reached or a pitfall worth remembering is hit, update the matching section. Decisions are only appended, never deleted; a reversed decision is marked "superseded by D-xx".

---

## 1. What the project is

HealthTrack is a health-habit app (check-ins, workout logging, points, leaderboard, skin store, AI assistant). It started as an MSA 2026 Phase 2 assignment (repo `kevin-zhengzzh/MSA-2026-Phase2`). This repo, `HealthTrack-Calories`, was copied from its commit `67fb2f4` to keep developing a **calorie intake** feature:

> Stack-chan robot (M5Stack CoreS3) + Mini Scales weighing → automatic photo → upload to the backend → Claude identifies the food and its kcal per 100 g → total calories from the measured weight → viewed on the web Food Log.

The original Phase 2 design docs are in `specs/` (`05-design-decisions.md` holds the Phase 2 decisions, `06-ai-features-spec.md` the AI assistant spec). This file records decisions **from this repo onwards**.

## 2. Repository layout

```
software/backend/    C# / .NET 10, EF Core + PostgreSQL, JWT. Tests/ is xUnit (in-memory DB + fake AI, never calls real models)
software/frontend/   React 19 + TypeScript + Vite + Tailwind v4 + Zustand
software/scripts/    seed-demo.sql (demo data), send-meal.ps1 (simulates a device upload)
firmware/stackchan-scale/   PlatformIO firmware (Arduino on ESP32-S3)
  src/main.cpp       weighing/photo/upload state machine, UI, touch, Wi-Fi
  src/head.cpp       servos (SCS0009) + power through the PY32 IO expander
  lib/FTServo/       Feetech servo library (MIT, from m5stack/StackChan, with an IDF 4.4 compatibility patch)
  include/secrets.h  Wi-Fi, backend address, device key (git-ignored; template secrets.example.h)
deploy/vps/          self-hosted deployment (Docker Compose + Caddy + Postgres, D-39)
.github/workflows/   ci.yml (every push/PR to main), deploy.yml (auto-deploys after CI passes on main; can also be triggered manually)
specs/               Phase 2 planning, prompt logs, design decisions
```

## 3. Common commands

```bash
# Backend tests (software/backend/Tests/)
dotnet test
# New migration (software/backend/)
dotnet ef migrations add <Name>
# Frontend (software/frontend/)
npm ci && npm run build && npm test && npx oxlint src
# Build + flash firmware (firmware/stackchan-scale/). PlatformIO lives on drive E because C: is short of space
PLATFORMIO_CORE_DIR='E:\.platformio' python -m platformio run -t upload --upload-port COM3
# Local backend for devices on the LAN (don't touch the Phase 2 healthtracker database). Add ASPNETCORE_ENVIRONMENT=Development to use AI (user-secrets only load in Development)
ConnectionStrings__DefaultConnection="Host=localhost;Port=5432;Database=healthtrack_calories_dev;Username=postgres;Password=postgres" \
  dotnet run --no-launch-profile --urls http://0.0.0.0:5000
```

Local secrets use `dotnet user-secrets` (`DeepSeek:ApiKey`, `Anthropic:ApiKey`), set by the user themselves, **never through the chat**.

## 4. Conventions

- Talk to the user in **Chinese**; code, comments, commit messages and PR descriptions in English.
- Features are built on branches and merged to `main` through a PR (CI must be green). Commit messages end with a `Co-Authored-By` line.
- Before committing, check that keys, Wi-Fi passwords, device keys and connection strings don't go into git (`secrets.h` is ignored); if a key appears in a user's screenshot, remind them to rotate it.
- Business code depends only on the AI interfaces (`IChatModel`, `IFoodRecognizer`); tests use fakes.
- Numbers are computed by code; the model only supplies meaning (e.g. calories = measured weight × the model's kcal/100 g).

## 5. Live environment

| Resource | Value |
|---|---|
| Frontend | https://healthtrack-frontend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io |
| Backend | https://healthtrack-backend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io |
| Azure | resource group `msa-phase2`, environment `managedEnvironment-msaphase2-a491` (shared with Phase 2), Container Apps `healthtrack-backend` / `healthtrack-frontend`, 0–1 replicas |
| Images | Docker Hub `kevinzheng123/healthtrack-calories` (public), tags `backend-<sha>` / `frontend-<sha>` |
| Database | Neon project `msa-phase2`, separate database `healthtrack_calories` under the production branch |
| Backend secrets | `db-connection`, `jwt-key`, `deepseek-api-key`, `healthtrack-prod` (Anthropic key) → env vars `ConnectionStrings__DefaultConnection` / `Jwt__Key` / `DeepSeek__ApiKey` / `Anthropic__ApiKey` |
| GitHub Secrets | `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `AZURE_CREDENTIALS` (service principal, scoped to resource group `msa-phase2`) |

Phase 2's `msa-backend` / `msa-frontend` and its `neondb` database **stay untouched**.

---

## 6. Key decisions

Format: problem → decision → reason → cost/notes.

### D-01 Photo recognition happens on the backend; the device doesn't call Claude directly (2026-11-18)
- **Decision**: the device only uploads a JPEG + grams to `POST /api/intake/device`; the backend calls the vision model.
- **Reason**: the Anthropic key can't be burned into firmware (it can be read out of flash); the backend handles quotas, logging and storage in one place; prompts and models can change without re-flashing.
- **Cost**: one extra network hop.

### D-02 Devices authenticate with their own device key, not JWT (2026-11-18)
- **Decision**: a key starting with `hk_` is generated when pairing on the web, shown only once, and only its SHA-256 is stored; request header `X-Device-Key`; revocable; at most 5 devices per user.
- **Reason**: storing account credentials in firmware is unsafe, and JWTs expire; a leaked device key can be revoked on its own.
- **Note**: the key is 32 random bytes, so unsalted SHA-256 is enough and allows lookup by hash.

### D-03 Total calories are calculated in code from the measured weight (2026-11-18)
- **Decision**: the model only returns `foodName`, `caloriesPer100g`, `confidence`, `isFood` (constrained by a JSON schema); `Calories = round(weight × kcal/100g / 100)`.
- **Reason**: the weight is a real measurement from the scale, more reliable than the model estimating it from a photo.
- **Note**: the scale must be tared first; the prompt assumes the weight excludes the plate.

### D-04 Without an API key, only the photo and weight are stored (2026-11-18)
- **Decision**: when `IFoodRecognizer.IsAvailable == false`, recognition is skipped, the name is left empty, the web shows "Unnamed food" and the user fills it in. Daily limit 200 (60 when recognition is on).
- **Reason**: the user asked to "ignore recognition for now and just get the photo and weight back to the client"; it also lets environments without a key (CI, local) run end to end.

### D-05 Photos are stored as bytea in PostgreSQL (2026-11-18)
- **Decision**: `IntakeRecords.ImageData`, the same way avatars are stored; the photo endpoint requires JWT, and the frontend shows it via fetch + blob URL.
- **Reason**: a 640×480 JPEG is about 22 KB; Neon's free 0.5 GB holds about 20,000 photos, so object storage isn't worth adding yet.
- **Later**: when data grows, move to Blob Storage and keep only links in the database.
- **Privacy**: photos judged not to be food are not stored (only one `AiUsageLogs` metadata row).

### D-06 Recognition model is Claude Haiku 5.5 (2026-11-18, replaced the original Opus 5.5)
- **Decision**: default `claude-haiku-5-5`, `Effort.Low`, structured output; the model can be changed with `Anthropic:Model`.
- **Reason**: the user wanted the cheapest. Measured about **$0.00015 per photo** (about 25× cheaper than Opus); kcal/100 g for banana and apple match USDA, and non-food is correctly rejected.
- **Cost**: Haiku 5.5 doesn't support the server-side refusal fallback (that beta was removed); mixed dishes vary by about ±15%.
- **Prompt constraint**: food name ≤ 30 characters (a salad once came back as a 67-character ingredient list that didn't fit the screen).

### D-07 The firmware flow is driven by the scale; photo taken automatically once the weight is stable (2026-11-18)
- **Decision**: > 5 g and within ±1 g for 1.5 s → take a photo and upload; the result stays until the weight drops below 5 g (food removed), then back to idle.
- **Reason**: at first the camera initialisation held the internal I2C, so touch didn't work; automatic triggering is also more convenient. Touch was fixed later, but this flow was kept.

### D-08 Camera at 640×480 RGB565, JPEG compressed in software (2026-11-18)
- **Decision**: the GC0308 tops out at VGA and has no hardware JPEG; frames go in PSRAM (600 KB), `frame2jpg` quality 80; XCLK 10 MHz (20 MHz gives EV-EOF-OVF); the preview is scaled 3/8 to 240×180, keeping 4:3 without cropping.

### D-09 Scale: hot-plug + tare once stable + zero tracking (2026-11-18)
- **Decision**: probe address 0x26 every 0.5 s; read the weight only when the probe succeeds and discard values outside −1000 to 6000 g; at boot/plug-in, tare only after readings vary < 0.5 g over 2 s; on an empty scale, a stable offset within 2 g is zeroed after 5 s; display < 0.3 g as 0.0.
- **Reason**: the library's `getWeight()` returns an uninitialised value when a read fails, which could trigger an upload; taring right at boot captures a drifting zero.

### D-10 Hand the internal I2C back to M5Unified so touch and servos work (2026-11-18)
- **Decision**: after camera init, `i2c_driver_delete()` removes the camera's driver, then `M5.In_I2C.begin()`.
- **Reason**: with two drivers on one bus, reads and writes were unreliable; streaming from the camera doesn't need SCCB.

### D-11 Own servo control instead of the official animation framework (2026-11-18)
- **Decision**: UART1 1 Mbps on GPIO6/7, servo ID 1 (pan) / 2 (tilt), powered through pin 0 of the PY32 IO expander (0x6F); **I2C must be 100 kHz**; read the factory calibration (NVS `servo/zero_pos_1|2`); tilt limited to 5°–85° (M5Stack's recommendation), pan narrowed to ±90° (my choice; official ±128°).
- **Cost**: the official stall protection wasn't ported.
- **Interaction**: tapping the main screen shows a translucent joystick (the further you drag, the faster it turns); Settings has Center (pan 0°, tilt 5°; first called Home, but full-speed servo moves were too abrupt, so it now eases in software over 0.4–1.6 s).

### D-12 Upload progress is shown in stages (2026-11-18)
- **Decision**: the request body is wrapped in a Stream that reports progress to HTTPClient: Taking photo → Uploading N% → Recognizing… → result.
- **Reason**: previously the whole thing showed "Uploading", so you couldn't tell slow Wi-Fi from slow recognition.

### D-13 The new project is deployed separately, not over Phase 2 (2026-11-19)
- **Decision**: new `healthtrack-*` apps in the same Container Apps environment, with their own Docker Hub repo and Neon database, starting from an empty database.
- **Reason**: Phase 2 is assessed work and must stay as it was; the new project changes often and needs isolation. The shared environment is billed by usage, so it costs nothing extra, and the domain is known in advance.
- **Note**: code-wise the new repo is a superset of the old one and migrations only add tables, so deploying over it would also have been safe; that just wasn't the choice.

### D-15 Devices are bound with a pairing code instead of copying keys by hand (2026-11-19, partly supersedes the pairing method in D-02)
- **Decision**: the device calls `POST /api/device/pairing/start` and gets a 6-digit pairing code plus a **private device token**; the user enters the code on the web under Food Log → Add device (`/claim`), and the backend creates a Device for that user with a `pending-…` placeholder KeyHash; the device polls `/poll` with its token, and **only once claimed is the key generated**, returned once, with only its hash stored.
- **Reason**: once a device leaves the LAN, copying a key and re-flashing isn't practical.
- **Security**: knowing the code alone doesn't get the key (the token is also needed); codes expire after 10 minutes; each user gets at most 10 wrong attempts per hour, each IP at most 10 requests per 10 minutes (IMemoryCache, fine for a single replica); the plaintext key only appears in the final response.
- **Kept**: manually generating a key ("No screen? Create a key manually") as a fallback for screenless devices or scripts.
- **Device side**: a 401 on upload → clear the key and go back to the pairing screen (handles removal on the web automatically).

### D-16 Phone Wi-Fi setup via hotspot + captive portal, multiple networks saved (2026-11-19)
- **Decision**: with no usable network, Stack-chan starts a hotspot `StackChan-XXXX` with a **random 8-character password generated each time** (WPA2); the QR code `WIFI:T:WPA;S:…;P:…;;` contains the password, so scanning connects; the phone pops up the device's own page listing the 2.4 GHz networks **the device scanned**, and after entering a password it first tests the connection and saves only on success. NVS (`net` namespace) keeps up to 5 networks, newest first; at boot it scans and tries known networks from strongest to weakest; after a disconnect it rescans asynchronously in the background and reconnects (without blocking the UI).
- **Reason**: Wi-Fi can no longer be hard-coded in firmware; a phone is better than a 320×240 screen for typing passwords. A random password rather than an open hotspot stops someone nearby from joining during setup and changing the configuration, and scanning the QR code feels the same.
- **Entry points**: automatically on first boot (no saved networks); later from Settings → Wi-Fi and the Wi-Fi button on the pairing screen. Reset in Settings (tap twice) clears all networks and the device key (factory reset) (superseded by D-20).
- **Revision (same day, after real-device testing)**: originally it was "test the connection on the web page, save only on success", which led to: ① scanning often failed with "unable to join": background reconnects and scans made the single radio switch channels, so the hotspot briefly disappeared; ② with a weak home signal the phone sat at "connecting" forever, and once the device joined the router the hotspot followed it to another channel, the phone dropped and never saw the result. Changed to: during setup, STA auto-reconnect and scanning are off and the hotspot is fixed on channel 6; **on submit, save immediately and shut the hotspot 3 s later**, with the connection continuing in the background (retrying even on a weak signal); failure reasons (wrong password / network not found / weak signal) are derived from disconnect reason codes and shown **on Stack-chan's screen**; if networks are already saved, setup exits automatically after 5 minutes idle. Cost: a mistyped password is saved too, and you have to see "Wrong password?" on the device and re-enter it in Settings.
- **Compatibility**: `secrets.h` became optional; its `WIFI_*` / `DEVICE_KEY` are imported once on first boot when NVS is empty.

### D-17 Wi-Fi is mainly chosen and entered on the device screen; phone setup becomes the fallback (2026-11-19, adjusts the entry points of D-16)
- **Decision**: Settings → Wi-Fi (and first boot, and the Wi-Fi button on the pairing screen) first opens a **network list on the device**: async scan, 4 rows per page (signal strength, lock for encrypted, saved marker), paging and rescan; tapping an unsaved encrypted network → on-screen keyboard (lower case / upper case / digits and symbols, password shown in clear) → Join; open networks connect directly; saved networks connect with the saved password (wrong password goes back to the keyboard). The device **tests first and saves only once connected**; on a wrong password it returns to the keyboard with a hint; on network not found or timeout (20 s) you can re-enter, save anyway (keep retrying in the background) or go back. The **Phone** button on the list opens the original phone setup (D-16), handy for long passwords; **Reset** is also on the list page.
- **Reason**: after testing, the user preferred searching directly on the device. Offline, without a phone at hand, or when phone setup is flaky, this is the most direct; and testing on the device avoids the phone dropping or getting stuck.
- **Revision (same day)**: the list scrolls by dragging (no up/down buttons, scrollbar on the right); tapping a row expands action buttons: current network Disconnect / Password / Forget, other networks Connect / Password / Forget (Password and Forget only for encrypted/saved networks; Forget needs two taps). After Disconnect there's no auto-reconnect (`net::disconnect()`) until a network is connected again or the device restarts; the current network is pinned to the top and marked "connected".
- **Implementation**: `net::pause(true)` pauses background reconnects while choosing (otherwise they interfere with scanning); the result is judged from the disconnect reason code (`net::joinState`).

### D-18 Long text that doesn't fit the screen scrolls instead of being cut off (2026-11-19)
- **Decision**: `drawFit(text, x, y, width, align)`: draw normally if it fits; otherwise scroll like a marquee inside a clip box: pause 1.2 s, scroll left at 40 px/s to the end, pause 1.2 s, jump back. Used for the bottom message bar (results, status), network names in the Wi-Fi list, keyboard title, network name on the connect page, setup status and pairing hints. All earlier `substring` truncation (food names, error messages, etc.) was removed.
- **Reason**: the user reported cut-off text; network names, food names and error messages have unpredictable lengths.

### D-19 The device checks its account occasionally; no heartbeat (2026-11-19)
- **Decision**: new `GET /api/device/me` (`X-Device-Key`) returns the device name and username and updates LastSeenAt; 401 means the device was removed on the web. The device checks after boot, when opening Settings (at least 1 minute since the last check) and every 6 hours when idle; the request runs in a separate FreeRTOS task (a cold start takes 20–30 s and mustn't freeze the screen), and no upload starts during a check (to avoid two TLS connections at once). The account name is shown at the top left of the camera view.
- **Reason**: after removing a device on the web, it used to take until the next upload for the device to notice. A frequent heartbeat would keep the min-0-replica backend and Neon awake, which the free tiers can't absorb (once a minute ≈ always billed; once every 6 hours ≈ 120 wake-ups a month, about 10% of the Container Apps free grant).
- **Cost**: if nobody touches the device, it can take up to 6 hours to return to the pairing screen after removal.
- **Revision (same day)**: **any touch** on the main screen (at least 1 minute since the last check) triggers a background check. After removing a device on the web, people usually walk over to look at it, and one touch gets it to the pairing screen within 20–30 s; no extra requests when nobody touches it.
- **Retry**: when a check gets no answer (timeout, cold start, offline), retry after 2 minutes, doubling each time, up to 30 minutes; 200/401 are definite answers and aren't retried. Previously a failed boot check waited 6 hours and the ring never appeared.

### D-20 Reset becomes Unpair, which only removes the pairing; dedupe by hardware ID (2026-11-19, supersedes the Reset behaviour in D-16)
- **Decision**: Reset was removed from the Wi-Fi list and the phone setup page. Tapping the account label at the top left of the main screen opens an account card → (tap twice) **Unpair**: the device first calls `DELETE /api/device/me` in the background to revoke its own key (it disappears from the web list), then clears the local key and account name and goes to the pairing screen; Wi-Fi is untouched. Networks are removed with each network's Forget in the list.
- **Re-pairing**: when pairing, the device reports its MAC (`hardwareId`); when the same account claims the same device again, that account's old record for the device is revoked automatically (not counting toward the device limit). **Only within the same account**: a MAC isn't secret and can be faked, and revoking across accounts would let someone kick another person's device offline. Switching accounts relies on the device's own Unpair, or the original account removing it on the web.
- **Reason**: switching accounts is the most common need and shouldn't wipe Wi-Fi; mixing Reset with Wi-Fi made accidental deletion easy.
- **Cost**: Unpair while offline only clears the local side, leaving a dead record on the web that has to be removed by hand (it's replaced automatically when re-paired to the same account).

### D-21 The daily intake goal is one value on the user, carried forward automatically (2026-11-19; storage and settings entry superseded by D-24)
- **Decision**: `Users.DailyIntakeGoal` (nullable, null = not set), set/cleared in Food Log's "Eaten today" card (`PUT /api/user/intake-goal`, 1–20000); **not stored per day**: once set it applies every day until changed. The Dashboard gets a "Today's intake" ring: full circle = goal, one segment per meal (coloured in order through the day); over the goal, the circle is divided by the total and the number turns amber; without a goal it prompts to set one in Food Log.
- **Reason**: the user asked for "once set, it carries forward until changed"; only today matters, no history of goals is needed.
- **Cost**: after changing the goal, there's no way to know what the goal was on past days if that's ever shown; switch to a table with effective dates when needed.
- **On the device**: a small ring at the bottom right of the main screen, with `eaten/goal` in the middle (`kcal` without a goal), amber when over. Data comes from the upload response and `GET /api/device/me?localDate=` (both gained `todayCalories` / `dailyGoal`), **no extra polling**. Changes on the web show up at the next account check (touch, boot, every 6 hours); after local midnight it shows 0 automatically.
- **Label meanings** (Food Log): `Check me` = model confidence low; `AI estimate` = medium; nothing for high; `Edited` = changed by the user; `Add details` = not recognised (no name).

### D-22 View and delete today's records on the device; no "confirm before saving" after recognition (2026-11-20)
- **Decision**: tapping the intake ring at the bottom right of the main screen → full-screen "Today" page (same layout as Settings and Wi-Fi, Back at the top right): at the top `eaten / goal kcal`, a progress bar, and the amount left or over; below, a draggable list of today's records (time, name, kcal); tapping a row expands it like the Wi-Fi list (weight and a Delete button); tap twice to delete. Endpoints `GET /api/intake/device/today?localDate=` and `DELETE /api/intake/device/{id}?localDate=` (`X-Device-Key`), both return the updated list and total.
- **Refresh and order**: newest first (matching the web); while the page is open it reloads every 10 s (web deletions and edits show up, and an expanded row stays expanded by id); it closes automatically after 3 minutes without a touch, so the backend isn't kept awake.
- **Scope**: the device key **can only delete today's records for its own account** (from any device); a leaked key can't delete history.
- **Network**: background task, mutually exclusive with uploads and account checks (one TLS connection at a time); these two requests also validate the key (401 → back to pairing), so tapping the ring and touching inside the Today page don't trigger an extra account check.
- **Not done**: the user considered "after recognition, tap Save/Discard on the device before recording", but decided to keep automatic recording; mistakes can be deleted or edited on the device's Today page or on the web.

### D-23 Net calories are display only; the goal still compares "eaten" (2026-11-21; position and conditions see D-25)
- **Decision**: the Dashboard's "Today's intake" card gains a line Eaten / Burned / Net (intake − that day's workout burn); workout data comes from the workout records the Dashboard already loads (by the user's local date), no new endpoint. The ring and "how much is left" still compare **intake** with the daily goal.
- **Reason**: the daily goal is an "intake goal" (D-21); if it were based on net calories, the goal would "grow" after a workout and the meaning would get muddled. Net calories are more intuitive as a reference number.

### D-24 Goals move to a Plan page, stored weekly, with automatic day/week conversion (2026-11-21, supersedes the storage and entry point of D-21)
- **Decision**: new Plan page (in the sidebar under Dashboard), with two identical cards for the intake goal and the burn (workout) goal; each has "per day" and "per week" inputs, editing one converts the other (×7 / ÷7 rounded), and the last edited one is saved. Endpoint `PUT /api/user/goals/{intake|burn}`, body `{perDay}` or `{perWeek}` (one or the other; neither = clear, only intake can be cleared), returns `{perDay, perWeek}` for both goals. Food Log's "Edit goal" and the pencil on the weekly goal ring now jump to Plan; the old `weekly-goal` and `intake-goal` endpoints were removed.
- **Storage**: both goals **store only the weekly value** (`Users.WeeklyIntakeGoal` nullable, `Users.WeeklyCalorieGoal` default 2000); the daily value is always derived by `Goals.PerDay` = round(weekly ÷ 7). This way nothing drifts whichever side you set: daily 1,700 → stored 11,900 → read back 1,700; weekly 2,000 → daily ≈ 286 (storing 286 would give 2,002 when ×7).
- **Migration** `WeeklyIntakeGoal`: rename `DailyIntakeGoal` and ×7 (÷7 on rollback); upgrade and rollback verified on local PostgreSQL.
- **Unchanged**: the device, upload response and `/device/me` still get `dailyGoal`, converted by the backend, so no firmware change; the name `WeeklyCalorieGoal` is kept (the AI assistant's tools and weekly summary use it) and means "weekly burn goal".
- **Colours**: intake is consistently blue `#2a78d6` (`INTAKE_COLOR`), burn uses the theme colour.

### D-25 The Dashboard shows only "today"; trends move to a Statistics page (2026-11-21)
- **Decision**: the home page keeps four blocks: Points / Streak at the top (unchanged) → **net calories banner** (Eaten − Burned = Net) → two symmetrical ring cards for **today's intake** and **today's burn** → one horizontal **check-in card**. The AI weekly summary, workout bar chart, weekly goal ring and check-in heatmap move to a new **Statistics** page (sidebar: Dashboard / Statistics / Plan / Check-in History / Record History / Food Log), to be redone in step 3.
- **Net calories**: only calculated when the day has **both meal records and workout records**; otherwise Net shows "—" with a hint about which side is missing, so forgetting to log a workout doesn't inflate net calories. Cost: genuine rest days won't show net calories (no "rest day" flag for now).
- **Both cards share `TodayCard`**: full circle = daily goal (intake goal / weekly burn goal ÷ 7, D-24), one segment per record (same colour with gaps; intake blue, burn theme colour), the whole circle turns amber when over; on the right, "left / over" and today's list (newest first). The burn card has a this-week (from Monday) progress bar at the bottom, and "+ Record workout" at the top right opens the same modal as the floating button (its open state moved to the store's `recordModalOpen`).
- **Mobile order**: net calories → check-in → intake → burn (check-in is the only thing to "do"); on wide screens the two cards sit side by side with check-in below.
- **Revision (same day)**: removed the page title "Dashboard" and the date/clock; the check-in card moved to the top, on the same row as Points / Streak (on mobile check-in on top, the two number cards below); the floating chat button no longer covers the check-in button.
- **Data**: intake refreshes every 30 s on the Dashboard (the device uploads in the background); workouts keep using `workoutRefreshKey`.

### D-26 The burn goal can be cleared too; Plan page gains body data and a one-year projection (2026-11-21)
- **Left/right consistent**: the two goal cards are structurally identical, both with Clear. `Users.WeeklyCalorieGoal` became nullable (new accounts still default to 2,000/week); the AI tool `get_weekly_goal_progress` returns `goal: null` with an explanation when no goal is set (no longer treated as "user not found"), the weekly summary's `goalPercent` is null; the weekly goal ring shows "—" with a "set a goal" link, and the home burn card shows "No burn goal yet".
- **Body data** (optional, `PUT /api/user/profile`): sex, birth year, height, weight, daily activity level, stored on Users; `/user/me` returns `profile`. Limits in `Models/BodyProfile.cs`.
- **Maintenance calories** = Mifflin-St Jeor BMR × daily activity factor (1.2 / 1.3 / 1.45 / 1.6). The factor describes daily activity **excluding logged workouts**; workouts are added separately through the burn goal to avoid double counting.
- **One-year projection** (frontend `src/projection.ts`, unit tested; weight bottoms out at BMI 13, where the title shows "Dangerously low" in red, so negative weights no longer appear): each day, balance = intake goal − (maintenance at that day's weight + daily burn goal), 7,700 kcal ≈ 1 kg, with maintenance recalculated daily from the new weight (so the curve flattens). Shows a 12-month curve, weight after a year and a breakdown "eat − maintenance − exercise = daily balance"; amber warnings when the first month loses more than 1% of body weight per week, intake is below 1,200 (women) / 1,500 (men), or the end BMI is < 18.5; marked as a rough estimate, not medical advice. Missing goals or body data are listed.
- **Question-mark tooltip** `InfoTip`: one "?" used across the site: shows on hover; click (tap on mobile) pins it open, click elsewhere or Esc closes it, so links inside work (e.g. Store in the Points explanation). The bubble sits in a padded container touching the "?", so moving the mouse from "?" to the bubble doesn't close it. Used on home Points (the old modal was deleted), Net, the Plan card titles, daily activity level and maintenance calories.
- **Migration** `BurnGoalOptionalAndBodyProfile`; on rollback, empty burn goals are filled back with 2,000.

### D-27 Food Log / workout records / check-in records merge into one History page with tabs (2026-11-21)
- **Decision**: the sidebar is down to Dashboard / Statistics / Plan / **History**. To the right of the History title are three tabs **Food Log | Workouts | Check-ins** (Food Log by default), each with its own URL: `/history/food`, `/history/workouts`, `/history/check-ins` (nested routes + `<Outlet>`, `/history` redirects to food). The old URLs `/food-log` and `/record-history` redirect to the matching tab. The three original pages lost their own h1, the components are otherwise unchanged (device management still lives in the Food Log tab).
- **Reason**: all three are "view records", so grouping them shortens the sidebar (fits on one row on mobile); separate URLs keep the back button, bookmarks and the home page's "Food Log →" link working.
- **Implementation**: `App.tsx` uses `isDashboardSection(path)` to decide whether to show the sidebar (prefix match for `/history/*`) instead of a fixed list.

### D-28 The page scrollbar is replaced by an in-app overlay scrollbar (2026-11-21)
- **Decision**: hide the browser's page scrollbar (`html { scrollbar-width: none }` + `::-webkit-scrollbar` in `index.css`) and use `OverlayScrollbar` (mounted once in `App`): it floats over the content without taking width; appears on wheel, touch scrolling, keyboard scrolling or when the mouse nears the right edge, fades out after about 1 s, gets thicker on hover, can be dragged; hidden when the page doesn't scroll. Scroll areas inside pages (lists, chat) use a thin scrollbar of the same colour.
- **Reason**: the native scrollbar only appears on long pages and takes a dozen pixels, so content shifted sideways between long and short pages (e.g. Plan vs Check-ins).
- **Implementation notes**: `ResizeObserver` watches body size and `MutationObserver` watches body's style (modals lock scrolling with `overflow: hidden`, so it hides then); dragging maps proportionally to `scrollTo`.

### D-29 Burn on the home page includes base burn (2026-11-22, changes the net calories calculation of D-23 / D-25)
- **Decision**: once body data is filled in on the Plan page, home Burned = **base burn** + that day's workouts, Net = eaten − Burned. Base burn = the Plan page's maintenance calories (Mifflin-St Jeor BMR × daily activity factor, D-26), **counted for the whole day**, computed on the frontend from `user.profile`, no new endpoint. The Plan page renames that row "Base burn (maintenance)".
- **Net calories condition**: there are meal records, and the burn side has data (body data, or workout records). Without body data, the old D-25 rule applies (both meals and workouts required).
- **Unchanged**: the burn ring and burn goal still count only workouts (the goal is a workout goal); a line at the bottom of the burn card shows "With base burn X: Y kcal today", and without body data it points to Plan.
- **Cost**: counted for the whole day, so right after breakfast Net is a large negative number; not prorated by time so the number doesn't keep changing and stays easy to understand.

### D-30 Separate Device page; meals can be logged by hand on the web; floating + becomes a menu (2026-11-22)
- **Device page**: sidebar Dashboard / Statistics / Plan / History / **Device** (`/device`); pairing, the device list and removal moved here from Food Log ("device management still lives in the Food Log tab" in D-27 no longer holds). Future device status, firmware version, etc. go here too.
- **Manual meal**: `POST /api/intake?localDate=`, body the same as editing `{foodName, weightGrams, caloriesPer100g}`, calories still calculated by the backend as weight × kcal/100 g (the D-03 principle); `Confidence = "manual"`, no photo, Food Log label "Typed in". Only logs to today.
- **Entry points**: "+ Add meal" at the top right of the home intake card (symmetrical with the burn card's "+ Record workout"); the floating + at the bottom right opens a two-item menu Add meal / Record workout. Both modals' open state lives in the store (`mealModalOpen` / `recordModalOpen`); after saving, `intakeRefreshKey` / `workoutRefreshKey` increment and pages refresh from them.
- **Floating buttons** (chat, back to top, +) are 16 px from the right edge of the window (previously 64 px on wide screens, covering numbers on the right of wide pages).

### D-31 The three History tabs share the Food Log style (2026-11-22)
- **Decision**: shared `components/HistoryParts.tsx` (`GroupCard` card title + total on the right, `Row` 64 px square + name + grey details + number on the right + icon buttons, `Modal`, `SearchBox`, `ShowMore`) and `historyFormat.ts` (date formatting, grouping, fuzzy search, button styles). Food Log and Workouts have one card per day, both searchable; Check-ins has only one entry per day, so one card per month. The paginator became "Show older days/months" (10 cards at a time).
- The "Eaten today + goal" card at the top of Food Log was removed (goals are only set in Plan, and the home page already shows today's progress).
- **Points history** also became the 4th History tab **Points** (`/history/points`), likewise one card per day (earned green, spent red), with the balance at the top; the Points row in the user menu at the top right now jumps to this tab (the old `PointsHistoryModal` was deleted).
- **Revision (same day)**: the Points row was removed from the user menu entirely (user's request); the balance is visible on the home Points card and the History → Points tab. The menu is now avatar/username, Store, Sign out.

### D-32 Today / This week toggle on the two home cards (2026-11-22)
- **Decision**: one shared toggle above the two cards (remembered in the browser's localStorage). This week = Monday to today: full circle = weekly goal, one segment per record; "left/over" uses the weekly goal; base burn × days elapsed this week. Below the ring, the records for the period (with the weekday for this week). The net calories banner always shows today.

### D-33 Statistics page by calendar week/month/year (2026-11-22, step 3 of the three-step home redesign)
- **Decision**: Intake | Burned toggle at the top; Week (Monday–Sunday) / Month / Year, ‹ › to go back (not into the future). Shows the total and daily average (**counting only days with records**: a forgotten day isn't a day with nothing eaten), a bar chart (one bar per day for week and month; one per month for year, valued at that month's daily average), dashed line = daily goal, dotted line = daily average, values on hover, y-axis minimum 100. Below, rankings: intake = Top foods (by calories, up to 10, merged by name case-insensitively), burn = by workout type. The AI weekly summary and check-in heatmap stay below; the weekly goal ring and old workout bar chart were removed.
- **Data**: intake uses a new endpoint `GET /api/intake/stats?from=&to=` (daily totals + Top 10 foods, range up to 366 days), because the regular history endpoint only returns the latest 500 records, not enough for a year; all workout records are already returned and are aggregated on the frontend. Period maths in `src/stats.ts` (unit tested), the chart is `PeriodBarChart` (shared by intake and burn, only the colour differs).

### D-34 The AI assistant's presets are down to "Set my plan" and "Workout advice"; plans are proposed by the AI and only saved when the user clicks Apply (2026-11-22)
- **Removed**: the Weekly review / Rank / Points / Goal presets: their content is visible directly on pages (Statistics, Rank, History → Points, home). Without a preset you can still just ask, and the assistant can still look these up. **Kept**: Workout advice (generated content not found on any page).
- **New 🎯 Set my plan** (mode `plan`): tools `get_plan_context` (current goals, body data, base burn = the server version `BodyProfile.Maintenance` of the same formula as the Plan page, daily average intake over the last 28 days and weekly workout burn) and `propose_goals` (`intakePerDay` / `burnPerWeek`).
- **How it writes**: `propose_goals` **doesn't write to the database**; it only validates (intake not below 1,200 women / 1,500 men, `BodyProfile.MinSafeIntake`; otherwise within the `Goals` limits). When valid, the server sends an SSE event `{type:"proposal"}`, the chat shows an "old → new" card, and only when the user clicks **Apply** does the frontend call `PUT /api/user/goals/*` as the user (the same endpoint as the Plan page). A model saying the wrong thing or being prompt-injected can't change the data.
- **Only plan mode** can use `propose_goals`: without a preset only read-only tools are given (`ChatToolExecutor.ReadOnlyDefinitions`).
- **Sticky mode**: plan usually starts with asking "lose / maintain / gain", so after choosing Set my plan the input shows "Set my plan — your replies continue this · Done", every typed reply keeps sending `plan`, and Done ends it. Workout advice still applies to one message only.
- **Prompt**: the total daily change = intake − (base burn + weekly burn goal ÷ 7), at most about 500 kcal; in the first local test the model only used base burn, and with exercise added the deficit was about 690, so the prompt now states that exercise counts toward the deficit.
- Tested end to end locally with real DeepSeek: asked for goals → answered "lose slowly" → when the card appeared the database hadn't changed → after Apply both goals were written and the Plan page updated.

### D-35 Weekly summary and check-in heatmap move off Statistics; + button expands sideways on hover; disclaimer (2026-11-22)
- **Check-in heatmap** → top of the History → Check-ins tab (that tab now also loads workout records, and the heatmap is coloured by that day's workout burn).
- **"Last week" AI weekly summary** → on wide screens **under the sidebar navigation** (`WeeklySummaryCard compact`: date and "AI summary" on one line of small text, body scrolls inside the card when too tall); on mobile the sidebar is a top bar and putting it at the top of every page would be noisy, so it goes at the bottom of the home page. `hooks/useMediaQuery` renders only one of them, so it isn't fetched twice. The Statistics page keeps only the chart and rankings.
- **The + at the bottom right**: on mouse devices (`(hover: hover) and (pointer: fine)`) **hovering** expands Record workout · Add meal sideways to the left (collapses 250 ms after leaving, no flicker crossing the gap); touch screens still tap to expand. Expanding sideways no longer covers the "back to top" button above.
- **Add meal modal**: explains that manual entries have no photo and calories = grams × kcal/100 g; grey hint "Have a Stack-chan scale? … Pair it on the Device page →".
- **Disclaimer (all of items 1–5 from the to-do list)**: a public page `/disclaimer` (open before and after sign-in); `LegalFooter` "Estimates only, not medical advice · Disclaimer" at the bottom of all signed-in pages, the sign-in page and the register page, and added to the existing footer of the home page (Landing, when signed out); a line under the register button; a reminder above Apply on the AI plan card; a sentence under the Plan page title; under the Food Log search box, where calories come from and ✎ to correct.

### D-36 The AI assistant can see meal data; weekly summary covers meals; floating buttons rearranged (2026-11-22)
- **New tool `get_intake_summary`** (read-only, available without a preset): ranges today / yesterday / this_week / last_week / this_month / last_month; returns total intake, days with records, **daily average over days with records**, daily totals, daily intake goal, number of unrecognised entries, Top 5 foods. The general prompt adds "meals (calories eaten)". In testing, "what did I eat yesterday" and "how is my eating this week" are answered correctly.
- **Weekly summary**: the stats gain `meals` (days with meal records, total, daily average, days over goal, last week's daily average, minimum safe intake, Top 3 foods); the fixed text is only used when there are **neither** workouts nor meals (changed to "Nothing was logged last week…"). The prompt became a health coach, and explains that the daily average only counts days with records; `minimumSafeIntakePerDay` is a general safety line, not something the user set (in testing the model called it "the minimum you've set for yourself", corrected in the prompt), and below it the model may only suggest eating a bit more. Already-cached old summaries aren't regenerated.
- **Floating buttons**: from bottom to top + (bottom-6), chat (bottom-24), back to top (bottom-42); back to top only fades in after scrolling more than 400 px (same on the Rank page).
- **Dark theme check**: all new pages were screenshot-checked; only the "spent" cell on the Points tab used a light pink background that glared in dark mode, changed to translucent red.
- Removed the unused `Pagination` component and its tests.

### D-37 Log a meal from a phone photo on the web: recognise → user confirms → save (2026-11-22)
- **Flow**: the Add meal modal has **📷 Photo** / **Type it in**. Photo: `<input type=file accept=image/* capture=environment>` (opens the camera directly on phones) → resized in the browser to 1024 px on the long side and re-encoded as JPEG quality 0.8 (`src/imageResize.ts`; redrawing on a canvas **strips EXIF, including GPS location**; a 1.28 MB original was stored as 86 KB) → `POST /api/intake/recognize` (**not stored**) → the form is prefilled with name, kcal/100 g and grams → the user confirms with Add → `POST /api/intake/photo` (multipart, with the photo and the confirmed values).
- **Why confirm** (user's choice): without a scale reading the weight is a guess and recognition can be wrong, so a look before saving is safer. The scale keeps recording automatically (D-07).
- **Grams**: phone photos use their own prompt and schema (`FoodPhotoSource.Phone`), where the model also estimates the edible weight (`estimatedGrams`, 1–5000), used only as a default and labelled "AI estimate — adjust". This is a deliberate exception to D-03 (weight comes from measurement): the final number is confirmed by the user, and calories are still calculated by code as grams × kcal/100 g. The scale prompt is unchanged.
- **Source**: `IntakeRecords.Source` = `scale` / `photo` / `manual` (migration `AddIntakeSource`, default `scale`, older manual records backfilled from `Confidence = 'manual'`; upgrade and rollback verified locally). Photo records get an extra "Phone photo" label in Food Log (hover explains the weight wasn't measured by the scale). `corrected` = the user changed the model's name or kcal/100 g (changing only the grams doesn't count).
- **Limits**: recognition shares the 60-per-day limit with the scale (`AiUsageLogs`); saving uses the 200-records-per-day limit; no key → 503, over limit → 429, failure → 502, and the frontend offers "try again / type it in instead" for each. Non-food stores nothing.
- Tested locally with real Claude (Haiku) on two Wikimedia photos: egg fried rice → "fried rice with egg" 175 kcal/100 g, estimated 350 g; Greek salad → 95 kcal/100 g, estimated 350 g (both 350, so grams are only a hint and the user needs to adjust them).

### D-38 Firmware 0.6.0: device status, offline queue with later upload, HTTPS certificate validation (2026-11-22)
- **Device status**: requests the device makes anyway (account check, upload, Today page, queued uploads) carry headers `X-Firmware` (`FW_VERSION`, now 0.6.0), `X-Wifi-Rssi`, `X-Scale` (scale connected or not), `X-Queued` (number of offline-queued meals); the backend's `DeviceStatus.Apply` stores them on the Devices table (migration `AddDeviceStatus`: FirmwareVersion / WifiRssi / ScaleConnected / PendingUploads / StatusAt), and the Device page shows "Firmware 0.6.0 · Wi-Fi fair (−71 dBm) · Scale connected · 2 meals waiting to upload · as of …" (weak signal, scale disconnected and pending uploads in amber). **No extra requests**, so the backend isn't woken more often (the D-19 concern).
- **Offline queue**: when an upload fails because there's no network, a server 5xx / timeout (cold start), the daily limit 429, or HTTPS isn't possible because the clock isn't set yet, the photo + weight + time taken + local date are saved to flash (LittleFS, the spiffs partition of `default_16MB.csv`, `/q/<time taken>-<seq>.jpg/.txt`), up to 10 entries; the screen shows "Saved for later" and the LED turns amber. When idle and online, a background task (no drawing, one TLS connection at a time) uploads them in time order, backing off 1 → 30 minutes on failure; entries rejected with a 4xx are dropped; 401 goes back to pairing and clears the queue (it belongs to the old account). **No more waiting when offline**: once the weight is stable the photo is taken and saved (previously it waited for Wi-Fi). The Ready line on the main screen shows "2 meals waiting to upload / saved offline".
- **Backend**: `POST /api/intake/device` accepts an optional `takenAt` (Unix seconds): within two weeks and no more than 5 minutes in the future, the record's CreatedAt uses it, and the date uses the device's local date (accepted only if within 1 day of takenAt's UTC date, otherwise the UTC date is used), so an old queued meal isn't clamped to today by `ResolveToday`. **Dedupe**: if the same device already has a record with the same `takenAt`, that record is returned (no duplicate, no second paid recognition), covering the case where the first upload timed out but the server had actually saved it. Every upload carries `takenAt`, so the first attempt and retries match.
- **HTTPS**: `beginHttp` no longer calls `setInsecure()` but `setCACert(ROOT_CA)` (`include/root_ca.h`: DigiCert Global Root G2. The current chain is Microsoft TLS G2 RSA CA OCSP 16 → Microsoft TLS RSA Root G2 (cross-signed) → it; Microsoft RSA Root CA 2017 and DigiCert Global Root CA are included too in case Azure changes certificates; taken from certifi and verified with `openssl s_client -CAfile`). Certificate validation needs the correct time: wait at most 5 s for the clock, and if still not set, don't send HTTPS (the upload goes to the queue). **When the backend domain changes or Azure changes CA, update root_ca.h**, or the device can't connect (symptom: "HTTPS" on the serial log / every request -1).
- **Real-device verification (2026-11-22, after PR #16 was deployed)**: once online, the account check returned 200 (certificate validation passed); with the hotspot off, weighed twice → both saved to flash, survived a reboot → after turning the hotspot on they uploaded in order, both 200; the Device page showed "Firmware 0.6.0 · Wi-Fi strong (−31 dBm) · Scale connected". The backend was still the old version during that upload, so records got the upload time; later queued uploads should use the time taken (not re-verified).
- **Known issue (not fixed; the user said leave it for now)**: if a queued photo is judged "not food", the server returns 200 + isFood=false, records nothing and the device shows nothing, so that entry silently disappears (in testing only one of two was recorded, most likely for this reason; the queue task only printed the status code, not the response, so it couldn't be confirmed). Possible fixes: ① print the response for queued uploads + a main-screen hint "1 saved photo wasn't recognised as food"; ② store queued non-food photos as Unnamed food for the user to handle (would loosen D-05).

### D-39 A second, self-hosted deployment on a VPS, independent of Azure (2026-11-25)
- **Decision**: `deploy/vps/`: DigitalOcean Sydney 2 GB Ubuntu + my own .com domain (registered with Cloudflare, DNS only); Docker Compose runs Caddy + backend + frontend + Postgres. Caddy gets Let's Encrypt certificates automatically, and on one domain sends `/api/*` to the backend and everything else to the frontend (same origin, no CORS); only 22/80/443 are open and the database isn't reachable from outside. Starts from an empty database; `backup.sh` runs a daily pg_dump and keeps 14. Updates with `git pull && docker compose up -d --build` on the server (no automatic deploy for now).
- **Reason**: the user is applying to a web hosting company whose JD asks for Linux, hosting and domains/DNS; setting it up from scratch gives real experience to talk about. The Azure setup (D-13) stays as is.
- **Shared**: code and the DeepSeek/Anthropic keys (daily limits still apply). Accounts and data are not shared.
- **Device**: Stack-chan still connects to Azure. Pointing it at the VPS needs ISRG Root X1 added to `root_ca.h` (D-38).
- **Known**: the per-IP pairing rate limit sees Caddy's address behind the proxy (the same is true on Azure), so everyone shares one allowance; few users, so left for now (fix with `UseForwardedHeaders` if needed).

### D-14 The deploy workflow can only be triggered manually for now (2026-11-18; automatic deploy restored 2026-11-19)
- **Decision**: `deploy.yml` keeps only `workflow_dispatch`.
- **Reason**: at first the image and app names pointed at Phase 2, so an automatic deploy would have overwritten the live service. They are now `healthtrack-*`, and the first deploy succeeded.
- **Follow-up (2026-11-19)**: `workflow_run` restored: deploys automatically after CI passes on main (merging a PR ships it), manual trigger kept.

---

## 7. Milestones

| Date | Milestone |
|---|---|
| 2026-11-18 | New repo copied from Phase 2; deploy changed to manual only |
| 2026-11-18 | Backend: device pairing, upload endpoint, Claude recognition, migration `AddDevicesAndIntake`, 17 tests; frontend Food Log page |
| 2026-11-18 | Switched to "only send photo + weight first"; end-to-end test passed (photo bytes identical, no token returns 401) |
| 2026-11-18 | First firmware flashed to Stack-chan; screen rotation fixed; the real device uploaded its first photos over the LAN |
| 2026-11-18 | Scale hot-plug, offline tolerance, Wi-Fi fallback reconnect |
| 2026-11-18 | Full-frame preview layout, TARE, zero tracking; I2C handed back → touch works |
| 2026-11-18 | Servo control, settings page (brightness/Home/power off), joystick aiming |
| 2026-11-18 | First 5 commits, PR #1 opened |
| 2026-11-18 | Anthropic key added, web image tests recognised accurately; switched to Haiku; a mouse on the real device correctly judged not food |
| 2026-11-19 | Separate Azure deployment: new Neon database, two Container Apps, GitHub Secrets; PR #1 merged (`192148d`), deploy succeeded |
| 2026-11-19 | Stack-chan switched to the live HTTPS backend, re-flashed |
| 2026-11-19 | AGENTS.md created |
| 2026-11-19 | Branch `feature/device-setup`: pairing code endpoints + migration `AddDevicePairing` + 9 tests (112 total); web "Add device" with pairing code; firmware phone Wi-Fi setup, multiple saved networks, pairing screen, 401 back to pairing; flashed, old configuration imported into NVS automatically |
| 2026-11-19 | PR #2 merged, auto-deployed after CI passed (Deploy #3) |
| 2026-11-19 | Branch `fix/pairing-polish`: no re-import of `secrets.h` after Reset; device shows account name after pairing (top left of main screen); device self-check endpoint `/api/device/me` (D-19); Food Log refreshes every 5 s; Wi-Fi list scrolling + expandable actions; Reset → Unpair, hardware ID dedupe (D-20); settings page became a full-screen list (no camera view, Back at the top right, brightness slider, rows: Light / Wi-Fi / Account+Unpair / Head+Center / Power); Wi-Fi Password prefilled with the saved password |
| 2026-11-19 | PR #4 merged, auto-deployed (`8507426`, `/api/device/me` live); branch `feature/touch-account-check`: touch triggers account check |
| 2026-11-19 | Daily intake goal (migration `AddDailyIntakeGoal`, 124 tests total) + Dashboard ring; device live view shows local time at the top right (NTP, `TIMEZONE`) |
| 2026-11-19 | PR #5 merged and auto-deployed (`600048c`): daily goal, Dashboard ring, device clock and intake ring, touch-triggered account check |
| 2026-11-20 | Account check retries with backoff; device Today page: view/delete today's records (D-22, 131 tests total) — PR #6 merged and deployed (`16b952b`) |
| 2026-11-20 | Today page rows expand (like the Wi-Fi list), newest first, refresh every 10 s while open, close after 3 minutes idle — PR #7 merged and deployed (`d290b1c`) |
| 2026-11-20 | Real food photographed on the real device (tomato, stir-fried meat, fried rice, skewers, dragon fruit) recognised and stored, kcal/100 g reasonable |
| 2026-11-21 | Dashboard net calories (D-23); serial log filter script `tools/serial_log.py` |
| 2026-11-21 | Overlay scrollbar (D-28): same width on long and short pages; projection gets a BMI 13 floor (extreme inputs no longer give negative weight), y-axis not below 0, formula doesn't wrap |
| 2026-11-21 | Home page top: title removed, check-in card on one row with Points / Streak; question-mark tooltips unified as `InfoTip` (hover + click to pin), Points explanation moved from a modal to a tooltip |
| 2026-11-21 | History page: Food Log / Workouts / Check-ins tabs (D-27), old URLs redirect; redirects and mobile layout checked with local screenshots |
| 2026-11-21 | Net tooltip; Plan page left/right consistent (burn goal can be cleared), body data, one-year weight projection (D-26, migration `BurnGoalOptionalAndBodyProfile`, backend 153 / frontend 47 tests) |
| 2026-11-21 | Step 2: Dashboard shows only today (D-25): net calories banner, symmetrical today intake/burn ring cards, horizontal check-in card; temporary Statistics page holds the old charts; desktop and mobile layouts checked with local Playwright screenshots |
| 2026-11-22 | Home Burned / Net include base burn (D-29); three cases (body data ± workouts, no body data) and mobile layout checked with local screenshots |
| 2026-11-22 | Device page, manual meals, + menu (D-30); History unified style (D-31); home Today / This week (D-32); Statistics week/month/year rebuilt (D-33). Backend 159 / frontend 54 tests, wide and mobile checked with local Playwright screenshots |
| 2026-11-22 | AI assistant: Set my plan (proposal + Apply card, D-34); backend 164 / frontend 56 tests; verified end to end locally with a real model |
| 2026-11-22 | PR #10 (History tabs, overlay scrollbar), #11 (base burn, Statistics, Device page, unified History style, Points tab), #12 (AI Set my plan) merged, all auto-deployed (latest `b2fa03c`). Saved progress: 4 new to-dos (move the two blocks below Statistics, + button hover expands sideways, Add meal explanation and device entry, disclaimer), start from here next time |
| 2026-11-22 | The 4 to-dos done (D-35): weekly summary in the sidebar, heatmap in Check-ins, + expands sideways on hover, Add meal explanation, disclaimer page and reminders; frontend 57 tests, wide, mobile, register page and disclaimer page checked with local screenshots |
| 2026-11-22 | AI sees meals, weekly summary covers meals, floating buttons rearranged, dark theme check (D-36); backend 167 / frontend 51 tests (Pagination's 6 removed) |
| 2026-11-22 | Log a meal from a phone photo on the web (D-37, migration `AddIntakeSource`); backend 171 / frontend 57 tests; verified end to end locally with real Claude |
| 2026-11-22 | Fixed the Plan page being shrunk as a whole on mobile (`InfoTip`'s hidden bubble widened the page); all pages pass a width check at 375 px |
| 2026-11-22 | Firmware 0.6.0 (D-38): device status headers, offline queue with later upload, HTTPS certificate validation; backend `takenAt` + dedupe + migration `AddDeviceStatus` (177 tests); Device page status; flashed (boots fine; no Wi-Fi where the device is, network parts still to verify) |
| 2026-11-22 | PR #16 merged and deployed (`d744aec`): backend support for firmware 0.6.0, device status, Plan page mobile fix; real device verified HTTPS certificate validation, offline queue and Device page status. Saved progress: next the user wants to look into running AI locally (a separate new project, called by this one) |
| 2026-11-22 | Local AI research project `E:\CodeLearning\LocalAI` (Ollama + Qwen3 8B, models in `D:\LocalAI\models`): HealthTrack-style tool-calling tests all pass, 4.5 s per question with thinking off. **No code changed** in this project; a local backend can switch over by setting `DeepSeek__BaseUrl=http://localhost:11434/v1` etc. (see LocalAI's `docs/healthtrack.md`), and turning thinking off needs a new optional setting `DeepSeek:ReasoningEffort`. Saved progress: the user said not to integrate it for now |
| 2026-11-21 | Step 1 of the three-step statistics/home redesign: Plan page + goals stored weekly (D-24, migration `WeeklyIntakeGoal`, 141 tests total). Step 2 home redesign, step 3 statistics page (Intake/Burned toggle, calendar week/month/year with going back, daily average only over days with records, rankings) |
| 2026-11-25 | Self-hosted deployment files `deploy/vps/` (D-39); README rewritten for the current project (the Phase 2 submission README archived as `specs/07-phase2-submission-readme.md`); English AGENTS.en.md |

---

## 8. Pitfalls

- **Azure "save as a new revision" is based on the selected revision**: saving on the scale page based on `--0000001` (which had no env vars) produced a new revision that took 100% of traffic, connected to the default `localhost/healthtracker` and crashed (exit code 139). Before changing configuration, make sure "based on revision" is the latest correct one. **Changing secrets doesn't create a revision**; you need a restart or a new revision for it to take effect.
- **Connection string format**: Npgsql doesn't accept the `postgresql://` URL form; use `Host=…;Database=…;Username=…;Password=…;SSL Mode=Require`.
- **When a container crashes on start**, the live log stream can't connect (no replica); use "Monitoring → Logs" and query `ContainerAppConsoleLogs_CL` with KQL.
- **The PY32 IO expander at 400 kHz** answers an address scan but reads registers as 0; use 100 kHz (as the official code does).
- **Freshly powered servos** take a few hundred ms to answer Ping; retry at boot, plus background retries within 30 s.
- **Arduino's `degrees` is a macro**, so it can't be a function name.
- **FTServo uses IDF 5's `UART_SCLK_DEFAULT`**; Arduino-ESP32 2.x is IDF 4.4 and needs `UART_SCLK_APB`.
- **The Wi-Fi library's own auto-reconnect** doesn't retry for reasons like `ASSOC_LEAVE`; you need your own watchdog (every 20 s).
- **A full C: drive broke the toolchain install**; PlatformIO uses `PLATFORMIO_CORE_DIR='E:\.platformio'`.
- **`| tail` swallows the exit code**: a build looked successful but had failed; grep for SUCCESS/FAILED.
- **Wikimedia `Special:FilePath`** returns 404 HTML for missing files and 429 when requested often; check the content-type after downloading.
- **The firmware toolchain defaults to C++11**: lambda parameters can't be `auto`.
- **ESP32 only supports 2.4 GHz**: a dual-band network with one name (2.4G/5G) is visible and connects (only on 2.4G); with separate names only the 2.4G one is visible; 5G-only networks or extenders (e.g. the home `DN8245-2CD9_5GEXT`) aren't visible. Hidden networks don't appear in the device list and can currently only be typed in on the phone setup page.
- **ESP32 has a single radio**: in AP+STA mode the hotspot must use the same channel as STA. As soon as STA scans or joins a router on another channel, the hotspot follows and the connected phone drops. Keep STA quiet during setup.
- **"Import from `secrets.h` when NVS is empty" is not "import once"**: after Reset cleared NVS, the device re-imported the old Wi-Fi and old key on reboot, so no pairing code appeared. Now a `seeded` flag in the `hts` namespace (not cleared by Reset) makes it import only on first boot.
- **Synchronous HTTP in the main loop freezes the screen**: with min replicas 0 the backend takes 20–30 s to cold-start, during which the screen doesn't refresh and touch doesn't respond (e.g. after Reset, tapping Exit seemed not to work). Pairing requests and account checks run in FreeRTOS background tasks; the main loop only handles results.
- **`net::forgetAll()` only deletes saved networks, it doesn't disconnect**: Reset must also call `WiFi.disconnect(false, true)` (which also clears the SDK's own saved credentials).
- **One tap leaks through to the next screen**: `tapNow` stays valid for the whole `loop()`. The Wi-Fi list's Exit and the pairing screen's Wi-Fi button are in the same spot, so tapping Exit also triggered Wi-Fi in the same loop, which looked like "can't get back to the pairing code". Set `tapNow` to false after switching screens.
- **Python patch scripts in a Bash heredoc turn `\n` into real newlines**: `\n` inside C++ strings gets broken, assertions fail (or worse, the file is silently corrupted). Write patch scripts to a `.py` file in the scratchpad first; files are CRLF, so convert to LF in the script and back to CRLF when writing.
- **Read the serial port with python without `-I`**: pyserial is installed in user site-packages, which `python -I` can't see. Use `python firmware/stackchan-scale/tools/serial_log.py [COM3] [seconds]`, which filters the camera's dropped-frame warnings.
- **`cam_hal: EV-EOF-OVF` / `EV-VSYNC-OVF` flood the log and can't be turned off**: the precompiled camera driver prints them with "early log" inside an interrupt (several per second), which `esp_log_level_set` doesn't control; tried XCLK 6 MHz (more) and `CAMERA_GRAB_WHEN_EMPTY` (more), neither helped, reverted. Only preview frames drop, photos are unaffected; filter when reading logs.
- **A failed boot account check → no intake ring**: the ring needs data to draw; previously a failure waited 6 hours to retry (now retries with backoff, D-19).
- **Definition order of functions/variables in the firmware**: `main.cpp` is one file, and new code using something defined later (`inRect`, `todayBusy`, `localDate`) fails to compile; move the definition up or add a forward declaration.
- **Page width is hard-coded per route in `App.tsx`**: only `isWide` routes use `lg:max-w-5xl`, others `lg:max-w-2xl`. Add new pages with wide content to `isWide` (Statistics was first only 672 px wide).
- **Checking the frontend visually**: this machine has Playwright + Edge (`p.chromium.launch(channel='msedge')`). Local backend on `:5000` + `npx vite`, register a temporary account, write `token/userId/username` to `localStorage`, then screenshot; afterwards delete the temporary account and its records (`IntakeRecords`, `WorkoutRecords`, `Users`).
- **PowerShell 5.1 eats double quotes passed to native programs**: `psql -c 'DELETE FROM "Users" …'` reaches psql as `DELETE FROM Users` (table name lower-cased, "relation does not exist"). Run SQL with quotes from Bash.
- **Stopping a background `npx vite` task doesn't end its node child process** (left behind twice): next time `--strictPort` reports the port in use (the old process still serves pages from the new code on disk). Find the PID with `Get-NetTCPConnection -LocalPort 5173`, confirm its command line is this repo's vite, then stop it.
- **Local backend AI "unavailable"**: `dotnet run --no-launch-profile` sets no environment, so it defaults to Production and doesn't load user-secrets; the log says "DeepSeek API key is not configured". Add `ASPNETCORE_ENVIRONMENT=Development`.
- **Stop the local backend before running backend tests**: the `dotnet run` process locks `bin/Debug/net10.0/backend.exe`, so the `dotnet test` build fails (MSB3027).
- **Playwright screenshots of the dark theme**: the theme is a skin (`data-theme` is set by the equipped skin, there's no theme column on Users). Setting `data-theme` with `add_init_script` doesn't work (too early, the document isn't built yet); set it with `page.evaluate` after load, and use a MutationObserver to stop the app changing it back.
- **Playwright button names match substrings by default**: `get_by_role('button', name='Add')` matches both "+ Add meal" and "Add a meal or workout", and strict mode errors; add `exact=True`. Also, `post_data_buffer` of a multipart request has no size (it's 0); to see how big an upload was, check `length("ImageData")` in the database.
- **Hidden elements that still take layout can widen a mobile page**: `InfoTip` used to hide its bubble with `invisible` (visibility: hidden), so the bubble stayed in the layout; a 256 px bubble on a right-hand "?" stuck out 81 px past the screen, the Plan page became 456 px wide, and the mobile browser (opened inside WeChat) shrank the whole page, so text looked small with a blank strip on the right. Now the bubble only renders when open, and is measured and shifted back on screen (8 px margin each side). To hunt these: at mobile width compare `document.documentElement.scrollWidth` with `clientWidth`, then look for elements whose `getBoundingClientRect().right` goes past it.
- **Run frontend tests in PowerShell**: in Git Bash `npm test` reports "Vitest failed to find the runner" (everything fails, not a code problem).
- **EF Core's `ExecuteDeleteAsync`** isn't supported by the in-memory test database; code that tests reach must load and `RemoveRange` instead.

---

## 9. To-do / open questions

- [x] Test recognition with Stack-chan on **real food**: common foods are recognised; keep watching the share of `Check me` and the error on mixed dishes
- [ ] Camera aiming: scale 20–30 cm in front of Stack-chan, adjust with the joystick
- [x] Restore auto-deploy after CI passes (D-14)
- [x] Phone Wi-Fi setup (D-16), pairing code (D-15): verify the pairing flow on the real device after deploying
- [x] HTTPS certificate validation (D-38, to verify on a networked real device)
- [x] Queue failed uploads + upload later (with the real weighing time) (D-38, to verify on the real device)
- [ ] OTA firmware updates; timezone following the account setting; ~~show device status on the web (version, signal, scale, pending)~~ (D-38; battery not done, the device is always plugged in)
- [ ] The 2.4 GHz signal where Stack-chan sits is weak (−70 to −76 dBm)
- [ ] Add "Other network…" to the device's Wi-Fi list for typing in hidden network names; check whether WPA3-only networks can connect
- [x] Backend min replicas 0 → 20–30 s cold start: **keep 0** (user's decision, 2026-11-22). 1 would be billed all the time; upload timeouts caused by cold starts are now covered by the firmware's offline queue (D-38), so no data is lost
- [ ] Servo stall protection (the official firmware has it)
- [ ] Integration with existing features: ~~Dashboard intake~~ (D-21), ~~Dashboard net calories~~ (D-23), ~~AI assistant reads intake data~~ (D-36), points (user said to hold off)
- [x] Serial log flooded by `cam_hal: EV-EOF-OVF`: can't be turned off in firmware (see Pitfalls); filter with `tools/serial_log.py`
- [ ] Scale features: weigh leftovers after a meal (record what was actually eaten from the difference); add foods to one plate one by one (recognise each from the weight difference)
- [ ] The intake ring on the device only updates on upload/account check; web changes show after touching the device (D-21, acceptable for now)
- [x] README: describe the smart scale feature (2026-11-25, README rewritten)
- [ ] Whether photos that failed recognition (or were misjudged as not food) should be kept for manual review; most visible with queued uploads, see D-38's "Known issue"
- [x] **Move the two blocks below Statistics** (done 2026-11-22, see D-35) (raised by the user 2026-11-22): the "Last week" AI weekly summary and the check-in heatmap don't follow the page's week/month/year and Intake/Burned toggles, so they feel out of place on the statistics page. My first thoughts (not decided): check-in heatmap → top of History → Check-ins tab (they're check-in records anyway, and the heatmap has its own month/year toggle); AI weekly summary → bottom of the home page, or as "last week review" content in the AI assistant, or on its own in the sidebar. Confirm the placement with the user before doing it.
- [x] **Change the interaction of the + button at the bottom right** (done 2026-11-22, see D-35) (raised by the user 2026-11-22): on mouse **hover**, pop the Add meal / Record workout buttons out sideways **to the left** (currently they pop upwards on click and cover the "back to top" button above). Phones have no hover, so they still tap to expand.
- [x] **Add a device entry and explanation to the Add meal modal** (done 2026-11-22, see D-35) (raised by the user 2026-11-22): e.g. "Have a Stack-chan scale? Weigh food on it and it's logged with a photo automatically — pair it on the Device page →", explaining the difference between manual entries and automatic scale logging (manual entries have no photo, calories = grams × kcal/100 g).
- [x] **Disclaimer** (done 2026-11-22, see D-35) (discussed 2026-11-22, the user said "later"). Existing: "AI answers can be wrong. Not medical advice." at the bottom of the chat, and "A rough estimate, not medical advice." on the Plan projection. Planned additions (copy in English):
  1. New page `/disclaimer` + one line at the bottom of every page (including sign-in/register) "Not medical advice · Disclaimer": not a medical service; calories/base burn/projections/AI advice are all estimates; people who are pregnant or breastfeeding, under 18, have a chronic condition or a history of eating disorders should consult a professional first; stop exercising if unwell
  2. One line under the register button linking to the disclaimer page (no checkbox)
  3. Above Apply on the AI plan card: "A suggestion, not medical advice. Check with a professional if you're pregnant, under 18 or have a health condition." (the only place that writes data, so the most necessary)
  4. A reminder at the top of the Plan page
  5. Under the Food Log search box: "Calories are estimates from the photo and the scale's weight; tap ✎ to correct."
  — My suggestion was 1 + 3 required, 2, 4, 5 optional; the user hadn't decided which to do
- [ ] **Nutrients and recommended intake** (raised by the user 2026-11-23, idea stage, not decided): besides calories, record protein / carbs / fat (later maybe fibre, sugar, sodium), with recommended daily amounts. My first thoughts:
  1. **Recognition**: the model also returns protein, carbs and fat per 100 g (like kcal/100 g, it only supplies meaning), and grams are still multiplied by the measured weight in code (the D-03 principle); manual meals and the edit modal get these three fields too. `IntakeRecords` gets nullable columns; old records are empty, and statistics show "some records have no nutrient data"
  2. **Recommended amounts**: calculated from the Plan page's body data, not by the model: protein by body weight (e.g. 1.2–1.6 g/kg, higher when losing weight), fat about 20–35% of calories, carbs fill the remaining calories; on the Plan page (same card as the intake goal, or a new one), with three small progress bars under the home intake card
  3. **Display**: P/C/F in each Food Log entry's grey details; nutrient split in Statistics' Intake; the AI assistant's `get_intake_summary` and weekly summary include nutrients
  4. **Later: meal suggestions**: based on how many calories and how much protein are left today, have the AI suggest the next meal (e.g. "40 g protein and 600 kcal to go"); numbers calculated by code first and handed to the model, which only suggests dishes. Could start as an AI assistant preset that doesn't write to the database
  — Concern: estimating nutrients from a photo is less accurate than calories (especially mixed dishes) and needs labelling as an estimate; before doing it, test with real photos how reliable Haiku's nutrients are
