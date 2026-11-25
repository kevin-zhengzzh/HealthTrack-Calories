# HealthTrack

A health-habit app: log meals and workouts, set calorie goals, check in daily, earn points and get help from an AI assistant. Meals can be logged automatically by a **smart food scale**: a Stack-chan robot (M5Stack CoreS3) with a scale that photographs the food once the weight settles, and the backend identifies it with Claude's vision model.

It started as my **MSA 2026 Phase 2** project (a gamified check-in and workout tracker). The original submission README is kept at [`specs/07-phase2-submission-readme.md`](./specs/07-phase2-submission-readme.md).

## Live

| Service | URL |
|---|---|
| Web app | https://healthtrack-frontend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io |
| API (Scalar docs) | https://healthtrack-backend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io/scalar/ |
| Self-hosted copy | https://kevinzheng.dev |

The first two are on Azure Container Apps, which scales to zero when idle, so the first request after a quiet period takes 20–30 seconds to cold-start. The self-hosted copy runs on a small Linux server (see [Deployment](#deployment)) and has its own accounts and data.

## How meal logging works

```
 Stack-chan + scale                       Backend (.NET)                         Web app
┌────────────────────┐  JPEG + grams   ┌──────────────────────────┐          ┌──────────────┐
│ weight stable 1.5s │ ──────────────► │ Claude vision: food name, │ ───────► │ Food Log,    │
│ → take photo       │   HTTPS,        │ kcal/100g, isFood         │  stored  │ Dashboard,   │
│ → upload           │   device key    │ kcal = grams × kcal/100g  │          │ Statistics   │
└────────────────────┘                 └──────────────────────────┘          └──────────────┘
```

- **The model names the food, the code does the maths.** The model only returns the food name and kcal per 100 g. The total is calculated from the weight the scale measured, which is more reliable than estimating portion size from a photo.
- **No scale?** Take a photo with your phone on the website. The model also estimates the weight, and you confirm or correct it before saving. You can also type a meal in by hand.
- **Non-food photos are not stored.**

## Features

**Web app**
- **Dashboard**: today's net calories (eaten − burned), intake and burn rings against your goals, daily check-in. Switch between Today and This week.
- **Plan**: daily or weekly intake and exercise goals (enter either, the other is converted), optional body data for a maintenance-calorie estimate, and a rough one-year weight projection with warnings for unsafe targets.
- **Statistics**: intake or burn by week, month or year, with top foods and workout types.
- **History**: Food Log, Workouts, Check-ins (with a heatmap) and Points, each searchable by day.
- **Device**: pair a scale with a 6-digit code, see its firmware version, Wi-Fi signal and pending uploads, and remove it.
- **AI assistant** (DeepSeek): answers questions from your own workout and meal records, gives workout advice, and can suggest goals. Suggested goals are only saved when you press Apply. A weekly AI summary appears in the sidebar.
- Points, streaks, leaderboard and unlockable themes from the original project. Mobile-friendly, with light and dark themes.

**Stack-chan firmware** ([`firmware/stackchan-scale/`](./firmware/stackchan-scale/))
- Live camera preview, weight display, automatic photo and upload, with progress shown in stages (Taking photo → Uploading → Recognizing).
- Wi-Fi set up on the device's touch screen, or from a phone through a temporary hotspot and QR code.
- Pairs with an account using a code shown on screen, with no password stored on the device.
- When offline, meals are kept in flash memory and uploaded later with their original time.
- A "Today" page on the device lists today's meals and lets you delete wrong ones.
- The head can be turned with an on-screen joystick.

## Design choices

Full decision log, with reasons and trade-offs: [`AGENTS.md`](./AGENTS.md) ([中文](./AGENTS.cn.md)).

- **The device never talks to Claude directly.** It only uploads to the backend, so no AI key is stored on the device, and prompts or models can change without re-flashing.
- **Each device has its own key.** It's created when the device is paired, shown once, stored only as a hash, and can be revoked from the web app.
- **The AI can't change data on its own.** Goal suggestions go through the user's Apply button, and every tool reads only the signed-in user's data.
- **Costs are capped.** Every AI call is logged with its tokens, and each user has a daily limit.
- **Tests don't call real models.** The backend uses fake AI implementations behind interfaces (`IChatModel`, `IFoodRecognizer`).

## Tech stack

- **Backend**: C# / .NET 10 · ASP.NET Core · EF Core · PostgreSQL · JWT · BCrypt · FluentValidation · Scalar
- **Frontend**: React 19 · TypeScript · Vite · Tailwind CSS v4 · React Router · Zustand
- **AI**: Claude Haiku (food recognition) · DeepSeek (chat assistant, weekly summary)
- **Firmware**: C++ (Arduino on ESP32-S3) · PlatformIO · M5Unified
- **DevOps**: Docker · GitHub Actions · Docker Hub · Azure Container Apps · Neon Postgres · Caddy (self-hosted option)

## Repository layout

```
software/backend/          .NET API; Tests/ is xUnit (in-memory DB, fake AI)
software/frontend/         React app
software/scripts/          demo data, a script that simulates a device upload
firmware/stackchan-scale/  Stack-chan firmware (PlatformIO)
deploy/vps/                self-hosted deployment on one Linux server
specs/                     Phase 2 planning, design notes, AI feature spec
```

## Running locally

### Docker Compose (whole stack)
From `software/`:
```bash
cp .env.example .env   # set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY to enable AI
docker compose up --build
```
Web app at http://localhost:5173, API at http://localhost:5000 (docs at `/scalar`).

### Backend and frontend separately
```bash
# software/backend/ (needs a local PostgreSQL, see appsettings.json)
dotnet run

# software/frontend/
npm install
npm run dev            # talks to http://localhost:5000 unless VITE_API_URL is set
```

AI keys for a native backend go in user-secrets, so they never land in the repo (`dotnet user-secrets set "DeepSeek:ApiKey" "<key>"`, and `Anthropic:ApiKey`). User-secrets only load when `ASPNETCORE_ENVIRONMENT=Development`. Without keys the app still works: the assistant reports it's unavailable, and scale photos are saved without a name so you can fill it in.

### Firmware
Copy `firmware/stackchan-scale/include/secrets.example.h` to `secrets.h` (optional, it's git-ignored), then from `firmware/stackchan-scale/`:
```bash
pio run -t upload
```
Without a device you can simulate an upload with [`software/scripts/send-meal.ps1`](./software/scripts/send-meal.ps1).

### Tests
```bash
dotnet test                     # software/backend/Tests/
npm test && npx oxlint src      # software/frontend/
```

## Deployment

- **Azure** ([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)): after CI passes on `main`, the images are built once, pushed to Docker Hub with the commit SHA as the tag, and rolled out to Azure Container Apps. EF Core migrations run when the backend starts.
- **Self-hosted** ([`deploy/vps/`](./deploy/vps/)): Docker Compose on one Linux server, with Caddy for automatic HTTPS, the site and API on one domain, and a local Postgres with daily backups. The same workflow deploys it in parallel: it SSHes in with a key that can only run the deploy script, the server pulls the new images, and the job waits until `/api/health` reports the new version.

## Disclaimer

Calorie figures, maintenance estimates, projections and AI suggestions are estimates, not medical advice. See the in-app Disclaimer page.
