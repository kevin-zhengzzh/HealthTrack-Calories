> This is the README as submitted for **MSA 2026 Phase 2** (kept unchanged for reference). The live links below point to the original Phase 2 deployment. The current README is at the [repository root](../README.md).

# HealthTrack

A gamified daily check-in and workout-tracking app. Users log daily activity, build streaks, earn points, climb a leaderboard, and unlock cosmetic app skins — built for **MSA 2026 Phase 2 (Software Stream)**.

## 🔗 Live Deployment

| Service | URL |
|---|---|
| Frontend | https://msa-frontend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io |
| Backend API (Scalar docs) | https://msa-backend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io/scalar/ |

Deployed as Docker containers (backend + frontend) on **Azure Container Apps** (Australia East); the database is a managed **Neon** Postgres instance, not a container.

⏳ **Note:** these are hosted on Azure Container Apps' lowest tier, which scales to zero when idle — the first request after a period of inactivity may take a few seconds to cold-start. Subsequent requests are fast.

## Introduction

HealthTrack turns daily exercise into a habit-forming loop: check in, log a workout, keep your streak alive, and watch your points climb the leaderboard. It's a full-stack app with a C#/.NET 10 backend (EF Core + PostgreSQL) and a React + TypeScript frontend, built around a simple idea — make showing up every day feel rewarding.

Since submission it has gained an **AI assistant** that answers questions about your own activity using tool calling, an **AI weekly summary** on the Dashboard, and a **CI/CD pipeline** that tests and deploys every push — see [Post-Submission Additions](#post-submission-additions).

## How This Relates to the Theme — Gamification

- **Points & tasks** — users earn points by completing daily check-ins and logging workouts, turning a mundane habit into a small, repeated reward loop.
- **Leaderboard** — a ranked leaderboard encourages healthy competition between users, motivating them to stay active to keep or improve their rank.
- **Streaks & unlockable skins** — maintaining a check-in streak unlocks cosmetic app skins. Making the skins streak-gated (rather than just point-purchasable) gives users a reason to come back *every day* rather than binge-earning points once.

## What Makes This Project Unique

1. **Docker-native deployment** — the full stack (db/backend/frontend) is containerized locally via `docker-compose`; backend and frontend ship to Azure Container Apps using those exact images. The database specifically was deployed as a managed **Neon** Postgres instance instead of its container — a deployment-cost decision, not a Docker limitation (see the Dockerize section below).
2. **HCI-conscious details** — a "what are points?" info tooltip demystifies the points system for new users, and the leaderboard percentile stat on the dashboard is clickable, jumping straight to your position on the Rank page instead of just displaying a number.
3. **Multi-dimensional data visualization** — dashboard charts (bar chart, pie chart, and a check-in frequency/heatmap view) let users understand their activity from several angles at a glance, not just a single number.
4. **Skin system** — users can customize the app's appearance to their taste by unlocking and equipping cosmetic themes, adding a personalization layer that increases day-to-day engagement.
5. **Landing/overview page** — a public landing page explains what the app does and how it works *before* signup, so users know what they're getting into.
6. **Mobile-responsive UI** — layout, navigation, and sidebars were reworked to collapse gracefully on mobile, giving mobile users a experience on par with desktop rather than a cut-down afterthought.

## Advanced Features (3)

> Only the three features below should be marked, per the assessment brief.

### 1. Security Measures
- **Password hashing (BCrypt)** — user passwords are never stored in plaintext. `BCrypt.Net-Next` salts and hashes passwords on registration and verifies via hash comparison on login (`software/backend/Services/AuthService.cs`). This matters because a database leak (backup exposure, misconfigured access, etc.) would otherwise hand attackers plaintext credentials that are very often reused across other sites.
- **Data validation / sanitisation (FluentValidation)** — every request DTO (register, login, username update, workout record, etc.) is validated with FluentValidation rules before it reaches the database layer (`software/backend/Validators/`). This blocks malformed or malicious input early, preventing bad data from corrupting state or being used to probe the backend.

### 2. Dockerize the Project
The full stack — PostgreSQL, backend, and frontend — is containerized via `software/docker-compose.yml`, each service with its own `Dockerfile`, giving a fully reproducible local environment where all three services build and run as containers. Backend and frontend ship to production using those exact images. The Postgres container itself wasn't carried over to production: Azure's own managed Postgres was tried first and priced out impractically even at the smallest tier, so the database was moved to **Neon** (a free managed Postgres service) instead. That's a deployment-cost decision made after the fact, not a limitation of the Docker setup — the database containerizes and runs correctly like everything else locally.

### 3. State Management (Zustand)
Auth/session state, user points, and the equipped skin are managed through a Zustand store (`software/frontend/src/store.ts`) instead of prop-drilling or Context boilerplate — kept intentionally lightweight, and covered by `store.test.ts`.

## Post-Submission Additions

> Added after the assessment was submitted. They are **not** part of the three marked advanced features above.

### AI Assistant (DeepSeek)

**What users get**
- **Chat assistant** — a chat button on every signed-in page. Ask things like *"How did I do last week?"* or *"How many check-ins until the reward skin?"* and get an answer built from your own data, streamed word by word. Replies follow the language you write in.
- **Topic pills** — one-click 📊 Weekly review, 💡 Workout advice, 🏆 Rank, 🪙 Points and 🎯 Goal above the chat input.
- **AI weekly summary** — a Dashboard card summarizing last Monday–Sunday: workouts, calories against your goal, the change from the week before, and one concrete suggestion.

**How it works**
- **Tool calling / agent loop** — the model chooses from five read-only tools (workout summary, check-in status, weekly goal progress, leaderboard rank, points). The backend runs them, sends the results back, and repeats until the model answers, capped at five model calls per message.
- **Streaming** — `POST /api/ai/chat` responds with Server-Sent Events. The frontend reads them with `fetch` + `ReadableStream` (`EventSource` can't send a POST body or the auth header) and an incremental parser that copes with events split across network chunks.
- **Topic modes** — each pill sends a `mode` that adds topic-specific instructions and narrows the tool list for that message, so the model has fewer ways to pick the wrong tool.
- **Numbers from code, words from the model** — every total and percentage is computed in C#; the model only writes prose. The weekly summary is cached per user per week, and a week with no workouts gets a fixed message without calling the model.

**Engineering decisions**
- **Per-user data isolation** — tools never take a user id. They always read the signed-in user from the JWT, so a prompt-injected *"show me user 2's data"* has nothing to work with; a test covers exactly that. Client-sent chat history can't claim the system role.
- **Privacy** — only aggregates (counts, calories, workout types) are sent to the model provider; never names, emails or notes. Conversation content isn't stored.
- **Provider-agnostic** — business code depends on an `IChatModel` interface. DeepSeek is one implementation: a small typed `HttpClient` over its OpenAI-compatible API, handling streaming tool-call fragments and the provider-specific `thinking` flag.
- **Cost control and observability** — a decorator records tokens, latency and tools used for every request in an `AiUsageLog` table, which also enforces a 30-messages-per-day quota. Failed requests don't count against it.
- **Tested without a model** — unit tests use a scripted fake, so CI never calls a real API. Separate smoke tests against the real model caught two problems the unit tests couldn't — the model answering a follow-up from memory instead of calling a tool, and calling last week "this week" — both fixed in the prompts.

Full requirements, design decisions and test results: [`specs/06-ai-features-spec.md`](../specs/06-ai-features-spec.md) ([中文版](../specs/06-ai-features-spec.zh-CN.md)).

### CI/CD (GitHub Actions)

- **CI** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs on every push and pull request to `main`: backend xUnit tests, frontend lint (oxlint), Vitest and a type-checked production build, then a build of both Docker images.
- **Deploy** ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) runs after CI passes on `main`: it builds both images, pushes them to Docker Hub tagged with the commit SHA (`backend-<sha>`, `frontend-<sha>`), and points the Azure Container Apps at the new images, which rolls out a new revision. EF Core migrations apply automatically when the new backend starts.
- Every running revision traces back to a commit through its image tag, and a bad release can be rolled back by reactivating the previous revision in Azure.
- Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and `AZURE_CREDENTIALS` (a service principal scoped to the app's resource group) live in GitHub Actions secrets. Runtime settings — the database connection string, `Jwt__Key` and `DeepSeek__ApiKey` — are Azure Container Apps secrets.

### Streak Timezone Fix

Streak continuation used to compare the **UTC** date of the last check-in with the user's **local** "yesterday". In New Zealand (UTC+12/13), a morning check-in falls on the previous UTC day, so checking in the next morning reset the streak to 1. Continuation is now judged from the stored check-in dates, which are already local, with regression tests reproducing the bug in both directions.

## Self-Reflection

If I were to do this project again:
1. **Spend more time designing more genuinely fun/engaging gamification mechanics** rather than the fairly standard points/streak/leaderboard set — e.g. badges/achievements for specific milestones, or time-limited challenges, to make the loop more interesting beyond raw repetition.
2. **Close the timezone double check-in edge case properly.** "Today" is currently resolved from the client's local date (clamped to ±1 day of server UTC time to block casual spoofing), but a user who physically changes timezone between two check-ins (e.g. flying across the date line) can still get two different valid `Date` values in the same real-world day, double-paying streak/points. The correct fix is a minimum-elapsed-time cooldown (~18–20h) against `User.LastCheckIn` — a real UTC timestamp immune to timezone spoofing — layered on top of the existing per-calendar-day check. This was identified during development but deliberately deferred in favor of finishing the core feature set before the deadline.
3. **Implement email-based password reset.** There's currently no "forgot password" flow. Because passwords are stored as one-way BCrypt hashes, the server can never recover or email a user's original password — the only correct approach is a *reset*, not a *recovery*: email a single-use, short-lived, high-entropy token (itself stored hashed, so a database leak can't be replayed into an account takeover), let the user set a new password through that link, and hash it the same way as at registration. It would also need to respond identically whether or not the email is registered, to avoid leaking which emails have accounts. This was left out mainly because it requires standing up an actual email-sending service (SMTP/SendGrid/etc.), which was out of scope for the time available.

## Tech Stack

**Backend:** C# / .NET 10 · EF Core · PostgreSQL · JWT auth · BCrypt · FluentValidation · Scalar API docs
**Frontend:** React 19 · TypeScript · Vite · Tailwind CSS v4 · React Router v7 · Zustand · react-markdown
**AI:** DeepSeek (`deepseek-flash`, OpenAI-compatible API) · tool calling · Server-Sent Events
**DevOps:** Docker · GitHub Actions · Docker Hub · Azure Container Apps · Neon Postgres

## Local Development

### Prerequisites
- .NET 10 SDK
- Node.js (18+) and npm
- Docker Desktop (for the Docker-Compose option, or if you don't want to install PostgreSQL locally)

### Option A — Docker Compose (full stack, closest to production)
From the `software/` directory:
```bash
cp .env.example .env   # adjust POSTGRES_PASSWORD / JWT_KEY if you like; set DEEPSEEK_API_KEY to enable AI
docker compose up --build
```
- Frontend: http://localhost:5173
- Backend: http://localhost:5000 (Scalar docs at http://localhost:5000/scalar)

### Option B — Run backend and frontend natively

**Backend** (from `software/backend/`):
```bash
dotnet restore
dotnet ef database update   # applies migrations to the local Postgres in appsettings.json
dotnet run
```
Runs at `http://localhost:5000`, Scalar docs at `http://localhost:5000/scalar`. Requires a local PostgreSQL instance matching `ConnectionStrings:DefaultConnection` in `appsettings.json` (defaults to `Host=localhost;Port=5432;Database=healthtracker;Username=postgres;Password=postgres`), or point `docker-compose.yml`'s `db` service at it separately.

**Frontend** (from `software/frontend/`):
```bash
npm install
npm run dev
```
Runs at `http://localhost:5173` and talks to the backend at `http://localhost:5000` by default (override via `VITE_API_URL`).

### AI Features (optional)
The AI assistant and weekly summary need a [DeepSeek](https://platform.deepseek.com) API key. For a native backend, store it with user-secrets so it never lands in the repo (from `software/backend/`):
```bash
dotnet user-secrets set "DeepSeek:ApiKey" "<your key>"
```
For Docker Compose, set `DEEPSEEK_API_KEY` in `software/.env` instead. Without a key the app runs normally; AI requests just report that the assistant is unavailable.

### Demo Data
[`software/scripts/seed-demo.sql`](../software/scripts/seed-demo.sql) gives an account about five weeks of varied workouts and check-ins, so the charts, leaderboard and AI features have something to show. Register an account whose username starts with `demo` (a safety check so a real account can't be overwritten), set its username at the top of the script, and run it against the database — e.g. in the Neon SQL Editor or with `psql`. It's re-runnable and never touches today's data.

### Running Tests
```bash
# Backend (from software/backend/Tests/)
dotnet test

# Frontend (from software/frontend/)
npm run test
```
No API keys are needed — AI calls are replaced by a scripted fake in the backend tests and by mocks in the frontend tests. The same commands run in CI on every push.

## Assessment Reference

Full requirements, submission instructions, and marking criteria: [`software/2026 Phase 2 - Software Assessment.pdf`](../software/2026%20Phase%202%20-%20Software%20Assessment.pdf).
