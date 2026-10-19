# Jelly Trail Academy H5

Jelly Trail Academy is a browser-first Match-3 learning game for H5. The client has a bounded, data-driven practice level catalog and server-replayed ranked runs, alongside cloud progression, classrooms, LiveOps, leaderboards, and analytics compatible with the supplied teaching dataset. These surfaces have different completeness levels; see [Known journey gaps](#known-journey-gaps).

The player surface includes a responsive candy-board studio and an application-wide session event log with latest-attempt teaching metrics. The descriptions below are source-backed; browser QA for the current integration and the broader accessibility, performance, and deployment release gates remain separate requirements, not a production-release certification.

## Local development

Requirements:

- Node.js 22+
- npm 10+
- Docker Compose or Podman Compose
- Google Chrome plus a global Playwright install for the browser release gates (`npm install -g playwright`); the current gate resolves the standard Homebrew macOS global prefixes

Copy the environment template, start PostgreSQL and Redis, migrate and seed the database, then run both H5 and API surfaces:

```bash
cp .env.example .env
docker compose -f infra/local/compose.yml up -d
npm install
npm run db:migrate
npm run db:seed
npm run db:seed-demo
npm run data:import
npm run dev
```

- H5 client: `http://localhost:3000`
- API: `http://localhost:3001/api`
- Health: `http://localhost:3001/api/health`
- Readiness: `http://localhost:3001/api/ready`

The Vite development server proxies `/api` to the API process. Override it with `API_PROXY_TARGET` when needed.

On H5 startup the client posts `POST /api/v1/economy/bootstrap` once, then reads `GET /api/v1/economy/wallet` and `GET /api/v1/player/snapshot` to hydrate the live wallet and progression snapshots.

Practice mode persists its save state in localStorage under `sweet_candy_match3_save_v1`, plus the device id under `jta_device_id`. Ranked runs start with `POST /api/gameplay/runs/start` and finalize through server replay with `POST /api/gameplay/runs/submit`. The current map still shares local unlock state between modes; this is not an authoritative ranked-access boundary.

The optional development-only accounts all use password `AcademyDemo!2026`:

- `instructor@jelly.local`
- `analyst@jelly.local`
- `admin@jelly.local`
- `student@jelly.local`

The H5 routes are `#/player`, `#/classroom`, `#/analyst`, and `#/admin`. Guest play is available without a password.

## Play and learn from live observations

Open a level from the map and choose ranked play or practice. Select two neighboring candies to swap them. Practice cells also support Tab focus and Enter/Space activation.

- **Event log / Data Lab** is application-wide: login, map, practice/ranked game, classroom, Analyst Workbench, and Admin screens share the same browser-session history. Screen transitions and opening victory, defeat, Shop, spin, guide, and settings dialogs are recorded; this is not an audit of every action inside those screens.
- On desktop, the log occupies a persistent sidebar. At narrower widths, use the persistent **Event log** launcher; **Alt+L** toggles the expanded log. The launcher also makes it accessible while dialogs are open, rather than requiring a return to gameplay.
- Mobile gameplay provides **Play / Data** jump controls without unmounting the board or pausing its timer. The first-session guide can be dismissed. Swiping practice candies suppresses the synthetic follow-up click; the mobile log launcher docks beside navigation rather than over candy cells.
- **Live events** are allowlisted browser observations, not the static teaching dataset or a warehouse query. Select a row to read its explanation and expand its JSON fields.
- Navigation, leaving gameplay, replay, and changing level/mode **do not erase session history**. Reloading starts a fresh in-memory log and chart, but pending gameplay observations survive in an account-scoped local outbox and retry through `/api/v1/analytics/events`. Use **Inspect this attempt** in a result dialog to focus the log.
- **KPIs and the score chart cover only the latest attempt**, not the accumulated session. Selecting a new attempt starts a fresh metric scope while preserving earlier event rows and the session event count. Until a new attempt is selected, the previous attempt's metrics remain available across navigation.
- **Valid swaps** = accepted swaps / all attempted swaps. **Points per move** uses only `move_resolved.delta`; booster points and end-of-level bonuses are excluded. Resolution waves are counted per accepted swap, not inferred from score.
- **Current score** can include booster points and final bonuses. The chart samples score after accepted swaps, retains the last 30 samples, and does not add an end-bonus point. A practice `level_completed` event exposes `baseScore`, `bonus`, and final `score` separately.
- Practice outcomes are local and unranked. Booster consumption still requires the economy API. Ranked moves are client observations until `verification_completed` carries the server response; a rejected replay and an unavailable connection remain distinct unverified states.
- Filtering and freezing affect only the displayed event list. Recording, latest-attempt metrics, and JSON export continue updating. The session retains at most **120 recent events**; the total event count covers the entire session and exports explicitly report truncation.
- **Gameplay sync** reports queued, offline/retrying, rejected, and synced states. Stable event IDs make retries idempotent; logging in as another account never reattributes the original account's queue. Rejected/corrupt records remain queued with an explicit retry control. Browser storage denial or the 1,000-record outbox limit produces a persistent incomplete-history warning instead of silent eviction; clearing browser storage can still remove unsent data.
- The backend stores gameplay observations in `analytics_event_spine` with an HMAC-derived player hash. Only allowlisted gameplay facts are uploaded—not screen/dialog events, credentials, account details, or classroom answers. Every client observation remains `source=h5`, including reported verification responses; authoritative ranked results stay in the gameplay tables.

The download uses schema **`jelly.app-observations.v2`** in `jelly-app-observations.json`. It includes `totalEvents`, `retainedEvents`, `truncated`, `latestAttempt`, `latestAttemptSummary`, and retained `events`. Gameplay rows carry an `attempt` object `{ id, levelId, mode }`; global screen/dialog rows have `attempt: null`. The attempt ID is a browser-generated observation scope, not an account identifier or server run credential. Row `sequence` and `elapsedMs` span the session, so replay does not restart their numbering or elapsed-time origin.

The teaching export contains screen/dialog names, gameplay facts, and relative elapsed times—not account identifiers, tokens, cookies, network payloads, or classroom answer text. One browser session cannot establish DAU, retention, revenue, causality, or population-level difficulty. The separate `#/analyst` teaching dataset remains unchanged.

## Free daily gift

Shop's **Claim +150** grants 150 soft-currency coins once per account per **server UTC calendar day**, including authenticated guest accounts. It requires a working authenticated API session, not a purchase, ad, or completed level. Device time, closing Shop, reload, and another device do not create a second entitlement.

- Opening Shop reads `GET /api/v1/economy/daily-gift` for `{ day, claimed, amount, nextClaimAt }` and synchronizes the authoritative wallet. Eligibility is checked before claiming; an unavailable status offers **Check again** instead of assuming eligibility.
- Claiming posts that server-provided `day` to the same endpoint with an idempotency key. The server rejects a day other than its current UTC day; refresh status if the day changed. Shop refreshes eligibility at `nextClaimAt` (00:00 UTC).
- The claim button shows pending/claimed state and blocks another Shop transaction while a claim is pending. Success uses the returned wallet rather than adding 150 optimistically.
- A lost response or temporary failure remains explicitly unconfirmed. Retry uses the same day/key; an already-settled same-day claim returns the current wallet and claimed status without another grant, including races across tabs. **Check and synchronize gift again** refreshes eligibility and balance after an uncertain result.
- Bootstrap also returns the current wallet when the starter-pack claim already exists, even if its original request key differs. A historical starter claim must neither regrant rewards nor prevent wallet hydration after login.

This gift contract is separate from the daily spin, whose remaining limitations are listed below.

## Known journey gaps

These are prioritized **static source-review findings**, not executed browser results or claims about a production deployment. They describe existing paths outside the event-log/daily-gift changes; their historical introduction was not established. Fixing the two focused features does not establish full-game completeness.

1. **Authority and economy boundaries — highest priority.** The player progress endpoint accepts arbitrary non-decreasing totals, and ranked run creation does not check unlocked progress. Daily spin accepts caller-supplied dates, and its four server reward outcomes do not match all eight wheel segments. These need boundary fixes before treating progression/spin as abuse-resistant. Sources: [player service](server/src/modules/player/player.service.ts), [gameplay service](server/src/modules/gameplay/gameplay.service.ts), [reward service](server/src/modules/economy/reward.service.ts), [spin UI](src/components/modals/SpinWheelModal.tsx).
2. **Practice completion and paid recovery.** Clearing double-layer ice or blasting an ingredient can remove a required objective without credit, stranding an attempt; secondary special candies caught in explosions do not propagate their blasts. Defeat's paid “continue +5” starts a fresh board rather than preserving the lost attempt. Sources: [practice board](src/components/GameScreen.tsx), [special resolver](src/utils/gameEngine.ts), [App result handlers](src/App.tsx).
3. **Account and classroom data continuity.** Expired-access-token bootstrap can show login despite a usable refresh session; guest upgrade exists only as an API, and failed logout is hidden. Classroom exits can discard answers before the 900ms autosave or after a save failure; stale-revision conflicts lack recovery, and closed drafts still appear editable. Assignment-publication failures also lack actionable feedback. Sources: [auth client](src/features/auth/auth-context.tsx), [auth API](server/src/modules/auth/auth.controller.ts), [analysis workspace](src/features/classroom/analysis-journey.tsx), [classroom hub](src/features/classroom/classroom-hub.tsx).
4. **Promises versus persisted results.** The map previews practice content even for ranked starts, whose generated objectives/budgets differ and omit timers/ingredients. Victory's displayed coin formula differs from ranked grants and advertises practice coins later overwritten by wallet hydration. Per-level achievements remain device-local; settings toggles and “reset all progress” do not implement their cloud lifecycle. Sources: [map preview](src/components/WorldMap.tsx), [ranked definitions](server/src/modules/content/engine-definition.ts), [App persistence/results](src/App.tsx), [player contract](shared/contracts/player/index.ts).
5. **Recurring LiveOps is incomplete.** Daily/weekly quests are keyed by quest ID without period rollover; the weekly inventory shield is disconnected from the streak's usable shield counter. Comeback tracking and league settlement have no production lifecycle callers. Only the first quest/event is shown, inbox rewards are not exposed, and quest claims lack robust feedback and immediate wallet refresh. Sources: [LiveOps service](server/src/modules/liveops/liveops.service.ts), [competition meta](server/src/modules/competition/competition-meta.service.ts), [meta UI](src/features/events/meta-overview.tsx).
6. **Reachability limits.** Offline cold-start authentication and a durable client practice-sync queue are absent. The leaderboard UI shows global top three, not the backend's full scope/own-rank journeys. Admin is read-only diagnostics, not a publishing, rollback, or role-management console; its hardcoded config version also differs from the player's. Sources: [auth bootstrap](src/features/auth/auth-context.tsx), [leaderboard client](src/features/leaderboards/competition-api.ts), [admin UI](src/features/admin/admin-ops.tsx).

Browser follow-up should use disposable local accounts: verify session restoration, classroom exit/conflict preservation, objective survival, preview parity, wallet/reward persistence, true paid continuation, gift retry/day rollover, spin boundaries, quest rollover/shield use, role isolation, and offline reload. Static traces and existing test definitions are not substitutes for those end-to-end observations.

Focused local Chromium checks exercised gift credit (314 → 464), claimed-state persistence after reload, eligibility-error recovery, booster purchase, mobile touch input, replay scope separation, log export/freeze, role-gated navigation, and stacked-dialog focus. Classroom and Admin layouts were checked at 320px and 375px after overflow repairs. Browser-agent MCP was unavailable (disabled catalog entry with a placeholder server path); these are Chromium checks, not an MCP pass or a full-game release certification.

Route/game modules are lazy-loaded. The measured production login loaded one JavaScript entry: approximately 706 kB decoded and 204 kB transferred by the local preview, without the classroom, analyst, admin, map, or gameplay chunks. The entry still exceeds Vite's 500 kB warning threshold; code splitting reduces initial loading but does not certify performance on target devices.

## Verification

```bash
npm run lint
npm run build
npm run test
npm run test:smoke
npm run sim:levels
npm run test:e2e
npm run qa:a11y
npm run qa:perf
npm run qa:security
npm run qa:backup-restore
npm run export:verify
```

Common release gates are additive and reversible. The backup/restore gate currently verifies 10 applied migrations and the 249,777-row teaching compatibility table:

```bash
npm run db:migrate
npm run db:rollback
```

`npm run data:import` imports the clean **Jelly Trail Academy v3.0 synthetic teaching dataset**: 13 compatibility tables, **764,817 rows**. Set `JELLY_DATASET_DIR` or pass `--source <directory>`; the default local delivery is `Jelly_Trail_Academy_v3_DELIVERY/teaching-materials/student/synthetic_jelly_trail_academy_v3`. The delivery directory is excluded from Git and container builds. Do not import instructor material or the messy-data extension.

The importer requires `psql`, checks all 14 manifest checksums (13 CSV files and SQLite), copies explicit CSV columns, reconciles every row count, and publishes the manifest in **one transaction**. Any failure rolls back table replacement and metadata together. `npm run data:import` uses `--reset` for the teaching tables only: take a backup before replacing an existing dataset. Running `npx tsx scripts/import-jelly-dataset.ts --source <directory>` without `--reset` refuses nonempty teaching tables.

Migration `0012` preserves the seven v3 A/B eligibility/exposure/metric columns and adds the dataset metadata singleton. Analyst Workbench reads the imported version/count rather than a hardcoded v2 label; its multi-query snapshot holds source locks to avoid mixed-version data during an import. Synthetic teaching rows remain separate from real gameplay telemetry, accounts, wallets, progression, and classroom work.

The production **ops** image includes `node server/dist/ops/import-jelly-dataset.js` and `psql`. Mount the verified clean delivery read-only outside the release/public directories, run the importer with `--source` after migrations and a fresh production backup, and verify compatibility counts and the authenticated teaching snapshot. CSV and SQLite exports remain available with `npm run export:csv` and `npm run export:sqlite`.

## Security and provider modes

Local development defaults to deterministic sandbox ads and payments; it never contacts a real provider or charges money. Production adapters require explicit provider credentials and callback verification. PostgreSQL is the source of truth; Redis only accelerates rebuildable state such as leaderboard reads.

Guest accounts can be upgraded through the backend, but the current client has no upgrade flow. Ranked replay, wallet mutations, classroom authorization, and exports have server-side checks; the progression write/start gaps above prevent a blanket authority claim. Already-open local practice can continue without ranked verification, but boosters need the economy API; offline cold start and queued practice sync are not end-to-end implemented. The PWA precaches the app shell (`/`, `/index.html`, `/manifest.webmanifest`, `/jelly-icon.svg`) and also caches successful same-origin GET resources; it excludes `/api/*`.

## Architecture

- `src/` — React/Vite H5 client
- `server/` — NestJS/Fastify modular API
- `shared/` — deterministic engine and runtime-safe API contracts
- `sql/` — PostgreSQL migrations and teaching marts
- `infra/local/` — local PostgreSQL and Redis runtime
- `tests/` — engine, integration, analytics, UI, and release checks
- Local deployment notes, generated reports, and AI working files remain workspace-only and are intentionally excluded from Git.
