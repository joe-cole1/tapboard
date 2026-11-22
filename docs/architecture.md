# Tapboard architecture

Tapboard is a Node 24 ESM modular monolith with explicit startup composition. Node executes erasable `.ts` files directly, and TypeScript only type-checks (`tsc --noEmit`). There is no transpiler, backend or frontend bundler, SPA or client framework, HTTP framework, ORM, query builder, dependency-injection framework, or global service locator. The code is the source of truth; this page describes its current design.

## Source layout

- `src/main.ts` is the process bootstrap and signal-handling entry point. Normal imports are side-effect free.
- `src/application.ts` is the composition root: configuration, logging, one database connection per active workspace, the Eta renderer, router, HTTP server, and the cross-feature callbacks, all passed explicitly.
- `src/config.ts` resolves and validates environment configuration for the server and the operator commands.
- `src/shared/` holds typed application errors, validation primitives, canonical JSON, and structured `debug`/`info`/`warn`/`error` logging with recursive secret-key redaction.
- `src/infrastructure/database/` is the only connection, migration, and read-only snapshot boundary.
- `src/infrastructure/http/` holds the small exact-match router, JSON/HTML/form/static boundaries, security helpers (Origin, CSRF, cookies, body limits), centralized error mapping, and server lifecycle.
- `src/infrastructure/sse/` holds SSE framing, heartbeat, connection accounting, bounded coalesced client queues, drain recovery, and overflow cleanup.
- `src/infrastructure/rendering/` holds the file-based Eta renderer.
- `src/operator/` holds the stdin-only PIN reset and root-key rotation commands and the online backup command.
- `src/features/<feature>/` holds each feature: `activity`, `auth`, `beverages`, `dashboard`, `display`, `events`, `fills`, `forecasting`, `health`, `kegs`, `live`, `machine-keys`, `outbound`, `outbox`, `secrets`, `simulation`, `story`, `system`, `tap-wars`, `taps`, `telemetry`, and `web`. A feature has `service.ts` (behavior), `repository.ts` or `repositories/` (all SQL), validation, types, and routes.
- `views/` holds Eta layouts, pages, and escaped partials; `public/` holds plain CSS and small page-specific browser modules.
- `openapi/telemetry-v1.json` is the machine telemetry contract.

## Runtime and HTTP

Startup creates the database directory, opens and validates the database, creates the renderer and HTTP server, and binds the configured address, in that order. A startup or bind failure rejects with the original error after attempting every cleanup. Shutdown stops System, connectivity, outbound, live, Brewfather, health, and detector work first, then drains HTTP within the configured grace period before SQLite closes. A throwing disposer cannot skip later resources. Repeated or concurrent stop calls share one promise, and `SIGINT` and `SIGTERM` use the same path.

Routes:

| Path                                                                                                                         | Access                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET`/`HEAD /healthz`                                                                                                        | Public readiness: `{"status":"ok","schemaVersion":<n>}`     |
| `/` and `/taps/:tapId/story`                                                                                                 | Public SSR dashboard and Brew Story                         |
| `/api/public/*` (dashboard projections, Story JSON, Tap Wars and its vote `POST`, live events, workspace) and `/api/on-deck` | Public projections                                          |
| `/assets/*`                                                                                                                  | Allowlisted static files and the generated `display.css`    |
| `/api/v1/telemetry/taps/:tapNumber`, `/api/v1/telemetry/batch`                                                               | Machine telemetry, Bearer telemetry-source key              |
| `/admin` and `/admin/*`                                                                                                      | Admin pages and the PIN login                               |
| `/api/admin/*`                                                                                                               | Admin JSON APIs and Admin live events (`/api/admin/events`) |

Admin JSON APIs return API-style authorization failures; Admin pages redirect to the four-digit PIN login. Admin sign-in and mutations use strict bounded URL-encoded parsing, exact Origin enforcement against the configured external origin, session-bound CSRF, and POST→303→GET. The anonymous Tap Wars vote also enforces exact Origin and bounded parsing and uses POST→303→GET, with no voter identity.

### Web route composition

`src/features/web/routes.ts` composes `public-routes.ts`, `authentication-routes.ts`, and the Admin modules `admin/{overview,beverages,keg-room,taps,integrations,display,tap-wars,system}.ts`. Registration order is fixed: the Admin not-found hook, public and authentication routes, then every Admin page and API route before the mutation routes. Each module declares its dependencies with a named `Pick` contract. `admin/http.ts` owns the GET, form-action, and autosave adapters; `tap-detail.ts` holds the Tap detail handler.

## Security and configuration

The configured external origin (`TAPBOARD_EXTERNAL_ORIGIN`) is one exact canonical HTTP(S) origin. Admin sign-in and every cookie-authenticated mutation must carry that Origin, so Admin cannot be used until it is set; an `https` origin makes cookies Secure. Trusted proxies are explicit comma-separated addresses and never supply an origin. Session lifetimes default to 30 days of inactivity and 365 days absolute until a System policy is saved; a saved policy permits one minute to one year, with inactivity no longer than absolute. Shortening constrains existing sessions immediately; lengthening cannot revive an expired session or extend its original absolute deadline.

The PIN is exactly four ASCII digits. Scrypt, durable throttling, opaque digest-only sessions, expiry and revocation, strict Origin, and session-bound CSRF protect online use; the 10,000-value space has limited resistance if the verifier is stolen. PIN reset and root-key rotation are local stdin-only commands; there is no browser reset or default PIN.

Integration secrets are encrypted with the external `TAPBOARD_SECRET_KEY` using AES-256-GCM with fresh nonces and identity-bound associated data. A missing or wrong key degrades only secret availability; rows are never deleted. Rotation re-encrypts every row atomically.

The config boundary accepts three deployment aliases: `PORT`, `DATA_DIR` (plus the `tapboard-v2.sqlite3` filename), and `TAPBOARD_PUBLIC_ORIGIN`. Canonical `TAPBOARD_*` values win and keep their validation; an empty legacy origin means unset.

## Containers

- Development: `Dockerfile.dev` and `compose.dev.yaml` run Node 24 as `node`, publish host loopback port 3000, require an external `TAPBOARD_SECRET_KEY`, and persist `/app/data/tapboard-v2.sqlite3` on the `tapboard-dev_tapboard-data` volume. The operator workstation's native WSL launcher reuses `Dockerfile.dev` (see [development](development.md)).
- Production: the root `Dockerfile` (with `Dockerfile.dockerignore`) is a digest-pinned multi-stage Node 24 build. The runtime holds only the package manifests, production dependencies, `src/`, `views/`, and `public/`; environment files and data never enter the build context. It runs as UID/GID 1000, listens on `0.0.0.0:3005`, includes `wget` for existing health probes, and supports a read-only root with a writable `/app/data`. `compose.production.example.yaml` applies the hardened posture; [operations](operations.md) covers deployment.

`scripts/check-production-container.sh` builds the image and verifies it in a disposable project: source equality, readiness, hardening, permissions, stdin PIN setup, the online backup, persistence across restart and recreate, degraded integrations, and SIGTERM.

## Rendering and live updates

`src/infrastructure/rendering/renderer.ts` owns a file-based Eta instance with escaping on by default. `/` renders the complete dashboard before JavaScript, and Admin pages share one semantic layout that works without JavaScript. Raw template output is limited to layout and partial composition. Static assets are served through an explicit allowlist with fixed MIME types, contained regular-file resolution without symlinks, and a short cache policy.

Small browser modules progressively enhance the pages that need them. The dashboard keeps every SSR Tap card and its SVG graphic node, coalesces dirty targets, fetches narrow projections, and reconciles the page after an SSE reconnect. Rotation pages through cards on a fixed cadence, pauses for focus and visibility, and is off under reduced motion. No server data is inserted with `innerHTML`.

`DashboardService` builds the public header, Tap cards, On Deck, and display defaults. Public projections omit source and key identifiers, raw telemetry and integration payloads, health evidence, actor and session IDs, maintenance notes, and secrets.

The public header always shows Settings. Its connectivity state is `healthy` (Connected), `degraded` (Partial), or `disconnected` (Disconnected), combining enabled Tap input checks, current-configuration request evidence for each enabled Brewfather account, and outbound destinations marked Required. A monitor re-evaluates it every 15 seconds and publishes only changes.

`LiveUpdateService` runs separate public and Admin SSE hubs. Events are `tap.updated`, `fill.updated`, `telemetry.updated`, `health.updated`, `ondeck.updated`, `integration_status.updated`, `display.updated`, and `tap_wars.updated`; each carries only a Tap ID or a fixed dirty target, and clients refetch. Notifications are published after commit. Client counts, queued events, and queued bytes are bounded; overflow disconnects the client, and Admin sessions are revalidated periodically. There is no durable replay.

### Display settings and themes

Shared display defaults are one revisioned row edited from two Admin forms, Default theme (`/admin/display/shared`) and Units and readouts (`/admin/system/units`). Each form posts only its own fields, and the expected revision rejects a save if anything changed meanwhile. Browsers may store sparse, validated overrides in localStorage key `tapboard.v2.display-preferences.v1` (record version 1). A synchronous head script applies allowlisted values before CSS to avoid a theme flash; corrupt or unavailable storage falls back to shared defaults, and the `storage` event syncs peer tabs.

`src/features/display/palette.ts` is the single source for every theme: neutral colours, `secondary`, three status colours, `shadow`, corner radii, a density multiplier, an optional heading font, and the theme's own accent (used while the operator's accent is `theme`, the default). Accent roles, `--muted`, `--on-danger`, the accent-tinted raised ground `--surface-accent` (the Tap Wars banner and accent badges) and the 3:1 form-control border `--control-border` are computed per palette and accent; each palette also sets the unknown-health dot colour `--unknown` (grey in Monochrome) and the On Deck shadow colour `--shadow-color`, so text roles meet 4.5:1 on the background, surface, raised and accent-tinted grounds. The generated `/assets/css/display.css` carries the public theme on `:root`, Admin's dark and light palettes on `.admin-shell` (Admin follows the device setting), and the public theme on `.display-preview`; its `font=all` variant, used by the Admin Display pages, also sets each named accent swatch's `--accent-swatch`. It holds only custom properties and `color-scheme`, inside the `tokens` cascade layer, so it replaces the `tokens.css` fallbacks and every later layer still applies. There are nine named themes plus `auto` (Modern Dark, or Light Minimal under `prefers-color-scheme: light`). `public/css/tokens.css` declares the cascade layers (`tokens`, `base`, `components`, `features`, lowest priority first) and documents the breakpoints. It holds the Modern Dark fallback; the `--space-*`, `--text-*`, `--weight-*`, `--radius-*`, `--z-*` and `--duration-*` scales; fixed tokens such as the simulation banner colours; and the base element defaults. `components.css` holds shared classes (and, in the base layer, the opinionated form and table element defaults), and `admin.css` and `dashboard.css` hold feature styles. Buttons have one API, defined once in `components.css` for Admin and public pages: `.button` (the neutral look) on an `<a>`, `<button>` or `<summary>`, plus at most one of `button--primary`, `button--secondary` and `button--danger`, and optionally `button--small`. A bare `<button>` gets only the reset (`font: inherit`, pointer cursor, the disabled look), so every `<button>` has a class; Admin adds its own focus ring.

Layout uses five primitives from `components.css`, so a page composes them instead of declaring its own boxes and grids. `.stack` (vertical gap, `.stack--loose` for item lists), `.cluster` (a wrapping row of actions), `.auto-grid` with one of `--xs`, `--sm`, `--md` or `--lg` (columns of at least 9, 13, 16 or 20rem, never wider than the container), `.header-row` (a title, its eyebrow or intro, and at most one action on the right) and `.card`. Admin page sections are flat: after the first, each top-level `<section>` gets a hairline divider and space. A `.card` frames one item (an integration, a source, a sensor, a destination, the current Tap War) and never another card; `.card--link` is the only card that responds to hover, so a boxed tile is always a link, and static facts use `.key-value-list` instead of tiles. `.card--warning` and `.card--danger` mark the health summary and Permanent deletion. Every collapsible row is a `details.disclosure`, whose summary is at least 24px tall.

To add a theme, add its name to `DISPLAY_THEMES`, its palette to `THEMES`, and the name to the two browser allowlists in `public/js/`. No migration is needed: the database checks only the name's format, and an unknown stored name reads as Modern Dark.

## SQLite and migrations

`src/infrastructure/database/connection.ts` is the only `better-sqlite3` import. It enables and verifies `foreign_keys=ON`, migrates and validates the schema, runs integrity checks, provides a synchronous `BEGIN IMMEDIATE` transaction primitive, and closes idempotently. Raw SQL is allowed only there, in `migrations.ts`, and in feature repositories.

The current schema version is 31 (`CURRENT_SCHEMA_VERSION` in `migrations.ts`). Migrations are append-only and contiguous from version 1; SQLite `user_version` equals the applied version, and `schema_migrations` is the ordered ledger. A clean database migrates transactionally to the current version, and an earlier canonical database upgrades through each later migration. A database opens only when its version, ledger, exact DDL, constraints, required singleton rows, and exact set of schema objects match. Future versions, unknown schemas, inconsistent ledgers, altered DDL, and unexpected objects fail closed, and a failed migration rolls back schema, ledger, and `user_version` together.

Persisted state is owned by features: Kegs, Beverages and recipe snapshots, Fills and On Deck, Taps and their assignments, telemetry sources, receipts, readings, epochs and rollups, forecasts, health state and incidents, display settings, Mystery, Tap Wars, outbound destinations and deliveries, Activity, sessions and policies, and Simulation state. Browser overrides, SSE state, effective flavor values, percentages, Low and New badges, and public projections are derived and never stored.

## Telemetry

Telemetry sources reuse the `machine_api_keys` primitive, but a source's identity (`telemetry_sources`) is distinct from its current key. Creating or rotating a source returns its Bearer token once. Rotation revokes the old key and keeps the source UUID, its idempotency namespace, its rate-limit identity, and its Tap authority. A machine key not bound to a source cannot send telemetry.

Each Tap has at most one source per role, keyed by `(tap_id, role)` in `tap_telemetry_authority`:

- `level`: keg-level metrics, which feed the detector, scale pours, and scale health;
- `condition`: temperature and pressure, which feed serving-temperature and threshold health checks, the display, and the Admin Tap page;
- `flow`: a flow meter's cumulative `dispensed_volume`; when present, it alone records pours.

Every role is optional, one device may hold several roles, and there is no automatic failover. `recorded` metrics (stored only) are kept from a source that holds any role on the Tap. An accepted sample keeps only the readings whose role its source holds on that Tap; a sample left with no reading is a durable `telemetry.not_authoritative` rejection. One Admin save sets every role in one transaction. Changing the `level` or `flow` source closes the epoch and needs a fresh baseline; changing the `condition` source does not. Re-assigning the same sources is a no-op, and key rotation is not an authority change. Disabled Taps accept telemetry; retired Taps reject it durably.

The v1 wire contract ([`openapi/telemetry-v1.json`](../openapi/telemetry-v1.json); client guide in [telemetry-clients.md](telemetry-clients.md)) has two endpoints, `POST /api/v1/telemetry/taps/:tapNumber` and `POST /api/v1/telemetry/batch`, and requires `Authorization: Bearer <telemetry-source-key>`; cookies, query keys, and Admin sessions are not accepted. Bodies are strict snake_case with a required `measured_at`, an optional `client_sample_id`, and exactly one of two forms: a primary `measurement` (`total_weight`, `remaining_volume`, or `fill_percentage`) with optional `temperature`, or a `readings` array of `{metric, value, unit}`. Metrics come from the registry in `src/features/telemetry/metrics.ts`, which gives each its units, canonical unit, bounds, and role. An unregistered metric or unit, a repeated metric, or a second level reading is a 400. A new condition or recorded metric needs only a registry entry; a new level metric also needs interpretation code and a migration. Single bodies are capped at 16 KiB and batches at 256 KiB and 1–100 samples. Single responses use 200 for accepted or duplicate, 409 for durable rejections, 429 for a rate-limited new sample, 400 for structural errors, 401 for bad credentials, 404 for an unknown Tap, and 413 for an oversized body; batch item outcomes return in an HTTP 200.

Normalization stores grams, milliliters, Celsius, and percent, rounded to six decimal places. `measured_at` is strict RFC 3339 with an uppercase `Z` or a `+HH:MM`/`-HH:MM` offset, stored as UTC milliseconds. A semantic SHA-256 digest over canonical JSON (normalization version, Tap UUID, measured-at, the level metric, and each canonical reading) excludes transport details, so both wire forms of the same values deduplicate.

Durable receipts are the idempotency source of truth: identity is `(source_id, client_sample_id)` when present, otherwise `(source_id, tap_id, measured_at_epoch_ms)`, backed by partial unique indexes. Receipts are checked before the in-memory per-source token bucket. A same-digest retry replays its original outcome with `duplicate: true`; a different digest is a conflict; only a new identity uses rate capacity. Non-authority, retired, future, stale, and out-of-order rejections are durable; rate-limit responses are not.

A new sample is processed in one `BEGIN IMMEDIATE` transaction. It rechecks the receipt and authority, requires `measured_at` to be strictly newer than the per-source/Tap watermark (kept across authority changes), stores the measurement and one `telemetry_readings` row per reading, advances the latest value per source/Tap/metric, advances hardware status only for a level reading, sets Tap `first_used_at`, captures the open assignment when `measured_at >= assigned_at`, runs the detector extension, and finalizes the receipt last; any failure rolls everything back. Raw measurements and receipts are pruned separately (defaults six and 24 hours, at most 500 rows per table per pass); status, latest readings, authority, and `first_used_at` survive. Ordinary telemetry creates no Activity or outbox row.

Batch ingestion validates, normalizes, resolves Taps, and digests every item before any effect, coalesces equal identities, runs the rest in deterministic order, and maps results back to their indexes, through the same pipeline as single samples.

Reading history outlives raw pruning as rollups. In the same transaction each accepted reading merges into its UTC-hour row (`telemetry_rollups_hourly`) and UTC-day row (`telemetry_rollups_daily`), keyed by Tap, metric, and bucket. A row keeps min, max, sum, count, and the last-measured value. Retention comes from `telemetry_rollup_settings` (defaults: hourly 30 days, daily 730 days). Admins read history from `GET /api/admin/taps/:tapId/telemetry/rollups?metric=&resolution=hourly|daily&from=&to=` (at most 1,000 buckets); rollups have no public projection.

## Epochs and pour detection

An assignment opens an immutable interpretation epoch that snapshots the Tap, source, Fill, assignment, Keg capacity and tare, effective density and its provenance, normalization version, detector configuration and its content hash, and arbitration membership. Assignment, move, unassign, Kick, source, capacity, tare, density, configuration, arbitration, and manual rebaseline transitions close the epoch exactly once; a fresh settled baseline is needed afterwards, and old samples are never reused.

Scale telemetry is interpreted through the epoch snapshot, stabilized, and projected as clamped public volume. Implausible upward jumps raise a durable warning rather than being read as refills. Detector state and deadlines are durable and timestamp-driven. Taps are independent unless configured into an arbitration group. Detector configuration is global defaults plus nullable per-Tap overrides. A completed pour stores only immutable references, canonical volume, and timestamps, and a deterministic `effect_key` makes completion idempotent across retries, batches, restart, and replay.

### Flow pours

A Tap with a `flow` source gets a `telemetry_epoch_flow_state` row per epoch. The pure `flow-detector.ts` treats the first reading as the baseline; an increase opens or extends a pour; `quiet_period_ms` without an increase, or `hard_timeout_ms` after the start, closes it; a decrease, or an increase that would make one pour larger than the keg, closes any open pour and re-baselines; a pour below `minimum_pour_ml` is discarded. A pour's volume is the exact counter delta. Flow pours use the same idempotent insert, Activity, and outbound path as scale pours. After a maintenance run that records pours commits, `DetectorService` reports the affected Taps through `onPoursCommitted`, and the composition root evaluates health and then publishes `telemetry.updated`.

While a Tap has a flow source, the scale detector still runs for remaining volume, warnings, arbitration, and low-keg and leak evidence, but its pours are not recorded. A flow-only Tap's remaining volume is the Keg capacity minus the Fill's recorded pours. Changing the flow source or assignment, or a manual rebaseline, starts a fresh counter baseline; other transitions of the same assignment carry it over so no dispensed volume is lost.

## Forecasting and pour history

Forecasting reads a Fill's completed pours across all its assignments and moves, in daily UTC buckets from its first assignment, with the current open epoch's stabilized volume as the current level. At least 14 observation days and three qualifying pours select a deterministic seeded block bootstrap; otherwise a fixed 24 oz per four days fallback applies. Confidence is low for fallback, stale, or anomalous results, medium for sufficient history, and high from 28 days and eight pours. Forecasting fails closed for unassigned or ended Fills and invalid volume. The serving-size setting defaults to 12 US fl oz. Forecasts are Admin-only apart from the public card's servings and days remaining.

The Admin Filled Keg page (`/admin/keg-room/fills/:id`) lists 25 pours per page, newest first, using the same keyset cursor as `GET /api/admin/fills/:fillId/pours`. Volumes follow the Units and readouts setting, and times are relative plus an absolute UTC timestamp, both rendered on the server.

## Health and Tap maintenance

Health checks have stable IDs: `low_keg`, `scale_availability`, `suspected_leak`, `serving_temperature`, `line_cleaning_due`, and one threshold check per other condition metric (today `serving_pressure` for `pressure`). Global defaults are typed, and each Tap may override fields. `low_keg` and `scale_availability` are on by default; the rest are opt-in. A flow-only Tap takes `scale_availability` from its flow meter's latest reading.

Serving temperature and threshold checks share one range evaluator: a reading outside the normal range for the configured duration is active (critical outside the critical range), and a gap longer than the scale-freshness window restarts the timer. Threshold check configuration is stored one row per check in `health_threshold_global_config` and `health_threshold_tap_overrides`. The health tables check only the format of `check_id`, so a new condition metric needs a registry entry, a `THRESHOLD_HEALTH_CHECK_IDS` entry with defaults in `THRESHOLD_HEALTH_CHECKS`, and an Admin field section, but no migration. A temperature reading as old as the scale-freshness window is stale, and the display then shows no temperature.

Health is evaluated after accepted telemetry and after assignment, authority, correction, density, configuration, maintenance, and startup changes, plus one coalesced periodic sweep. Disabled Taps evaluate; retired Taps are skipped and their incidents resolved. Current health state is rebuildable and separate from durable incidents and transitions. Acknowledgement does not resolve an incident, and cooldown suppresses repeated side effects, not health truth. Resolved incidents are kept 365 days. Line maintenance is append-only with server-derived due dates; private notes are Admin-only. Incidents and maintenance set Tap `first_used_at`. Public health is aggregate only.

## Brew Story, flavor guidance, and Mystery Tap

`src/features/story/` owns the read-only public Story contract. `PublicStoryService` is the projection boundary for the dashboard, `/api/public/taps`, Story HTML and JSON, and targeted refreshes; it redacts before rendering or serialization. When a dependency fails, the projection falls back to a safe default and logs `Public story projection degraded` (see [operations](operations.md#diagnose-failures)).

Mystery is stored on the active assignment (`tap_assignment_mystery`), uses the title `Mystery Tap`, hides Beverage and custom Tap names, and hides every eligible field by default. The reveal allowlist is `beverage_type`, `style`, `abv`, `ibu`, `og`, `fg`, `srm`, `description`, `recipe`, `sensory`, and `history`. Tap number, display color, Fill Glass, remaining and fill percentage, forecast, and serving temperature always show. A new assignment resets Mystery.

Recipe files reach Beverages through **Admin → Import recipe file** (`POST /admin/beverages/:id/recipe-import`), an ordinary url-encoded Admin form (CSRF, exact Origin, POST→303→GET) whose body is capped at three times the 1 MiB file limit. `beverages/recipe-files/` detects the format by content: Brewfather batch or recipe JSON, BeerJSON, or BeerXML, read by a small strict XML reader that rejects DTDs, entity declarations and unknown entities and caps depth and element count. Each adapter maps its units into the recipe shape the Brewfather normalizer reads, and the existing sanitizer builds the schema-2 snapshot, tagged `brewfather-export-v3`, `beerjson`, or `beerxml-1`. The snapshot is attached once as an immutable detached snapshot under `offline-history`, only to a Custom beverage with no editable recipe; the raw file is never stored. Story labels these snapshots "Imported <format> recipe".

The public recipe sheet is a read-only Story view of the cached recipe. It keeps recipe targets separate from batch measurements, groups ingredients with their recorded units, totals mass only for complete collections, and shows mash steps, fermentation days, and water values when recorded. Mystery applies the recipe gate first and still redacts type, style, OG, FG, ABV, IBU, and SRM independently.

Flavor guidance has eight axes: malt, hops, bitterness, sweetness, body, roast, tartness, and alcohol. Each resolves independently as manual override, coverage-gated recipe calculation, reviewed exact style baseline, or unavailable. Manual values are stored on a 0–10 scale and shown as 0–5. Effective values are never stored. Beverages owns normalized recipe inputs (snapshot payload schema 2); Story owns the pure calculation and redaction. Mystery's sensory reveal controls the whole flavor projection. The model and catalog are described in [flavor-model.md](flavor-model.md) and [flavor-catalog-sources.md](flavor-catalog-sources.md).

Vessels come from a finite 17-ID Fill Glass catalog with static SVG contours, bowl-only liquid clips, and SRM or display-color fallback; arbitrary artwork is not accepted. One animation clock drives the 8-second fill, and reduced motion keeps bubbles stationary.

## Tap Wars

`src/features/tap-wars/` owns eligibility, start, anonymous voting, pause, resume, stop, result dismissal, history, and the public projection. A competitor is an immutable snapshot of its assignment, Tap, Fill, and Beverage. A partial unique index allows at most one active or paused War. Assignment closure, Tap disablement, and destructive lifecycle changes may pause a War but never block Tap operations or resume it automatically. Completion freezes both counters, derives the winner or a tie, and publishes the result atomically; completed results are immutable.

Votes are public, anonymous, unlimited integer counters with no voter table, cookie, or IP identity. Vote and stop share the `BEGIN IMMEDIATE` boundary, so a vote lands before the frozen result or is rejected. Public titles always resolve through the current Story/Mystery projection. The Admin Tap Wars page has a switch that turns Mystery Tap on or off for both competitors of the unfinished War through the Taps' own Mystery setting. It changes nothing once either Tap holds a different Fill from the one competing, because Mystery then belongs to that other Fill.

## Outbound delivery

`src/features/events/` defines the envelope (`schema_version` 1) and six event types: `fill.assigned`, `fill.ended`, `pour.completed`, `keg.low`, `health.transitioned`, and `integration.status_changed`. `src/features/outbox/` is the transactional outbox: producers admit registered events within hard global and per-destination row and byte bounds, pruning the oldest terminal history only when needed. `src/features/outbound/` owns destination configuration with immutable versions, subscriptions, secret slots, connectivity evidence, Admin history, and workers.

Claims are leased with compare-and-set completion, allow one in-flight delivery per destination, and give at-least-once delivery. Retryable failures back off from 5 seconds up to one hour and become terminal after 24 hours of active failure or the cycle bound; permanent failures are terminal immediately. Retry applies only to terminal rows; Dismiss is final. Disable and re-enable pause the due and failure clocks.

Home Assistant uses one WebSocket per destination and fires the `tapboard_event` event; it allows explicitly configured LAN HTTP and never runs arbitrary service calls. Webhooks resolve their endpoint on every attempt, reject private, unsafe, or mixed DNS answers, pin the validated address, follow no redirects, and bound connection, response, and body size. A webhook version may opt in with `allowPrivateNetwork` (stored in `config_json` only when on): it also accepts RFC 1918, `100.64.0.0/10`, and `fc00::/7` answers, while loopback, link-local and cloud metadata, multicast, and unspecified addresses stay rejected in both modes. The worker passes the option only when both the claimed and the current version opt in, so turning it off applies to retries at once. The standard envelope is the default; a bounded Discord-message format is the only alternative.

Secrets are bound to the destination's scheme, host, and port: changing any of them discards the stored token and header values and dismisses unfinished and retryable deliveries in the same transaction. The worker enforces the binding again at send time, before it resolves any destination-scoped secret: a claim pinned to an older version is sent only when both versions' credential origins (`credentialOrigin` in `outbound-validation.ts`) can be read and match; otherwise the delivery becomes final (`dismissed`, error code `origin_changed`, no Retry) without calling the transport or recording a connectivity failure. Claims on the current version skip the comparison. Workers claim and record in SQLite but do all network I/O outside transactions, and a lifecycle generation keeps a stopped worker's late callbacks from changing a restarted worker's state.

## Simulation workspace

The installation-wide Simulation switch ([ADR-0008](adr/0008-built-in-simulation-workspace.md)) runs the same application against a separate database file named after the normal one with `.simulation.sqlite3` appended. `WorkspaceApplication` owns one HTTP listener and selects the normal or Simulation runtime; no domain objects or credentials are copied between them. Selection lives in the normal database; sample state (`simulation_settings`, `simulation_sensors`, `simulation_fill_volumes`) lives in the Simulation database.

New workspaces seed five on-tap beers and two On Deck from seven minimized, anonymized recipe snapshots, attached as immutable detached snapshots under the `offline-history` namespace. The runner sends ordinary authenticated `readings` samples (scale weight, temperature, pressure, and a cumulative `dispensed_volume` from sensors holding the flow role; Tap 3 has a scale and a flow meter and Tap 4 only a flow meter) through normal ingestion and detection. Both workspaces share the normal PIN and sessions; switching or resetting rotates the session and CSRF token, revokes older sessions, disconnects SSE clients, and makes open pages reload. External telemetry always goes to the normal installation. Simulation has no outbound runtime, Brewfather sync, or root key.

## System and retention

`src/features/system/` coordinates calculation defaults, retention, session policy and revocation, and local diagnostics through typed ports, with no external probes. Activity pages show at most 50 allowlisted entries with stable cursors; the session list shows up to 100. A one-minute sweep performs one bounded pass: Activity 1,000 rows, raw telemetry 500, receipts 500, hourly and daily rollups 500 each, terminal delivery/event/version rows 100 combined, and expired or revoked sessions 1,000. Pending, retrying, and leased deliveries protect their events and versions; current versions and versions holding encrypted endpoint material are protected until retirement clears them. Domain history, epochs, pours, calibration, maintenance and deletion audits, and `first_used_at` are never pruned.

Brewfather service disposal is permanent and aborts in-flight transports, and every continuation after external I/O rechecks that its work is still current before writing.

## Dependencies

Production dependencies are `better-sqlite3` (synchronous SQLite) and `eta` (server rendering). Development dependencies are TypeScript, `@types/node`, `@types/better-sqlite3`, ESLint with `@eslint/js` and `typescript-eslint`, Prettier, and `@playwright/test`.

## Architecture enforcement

`npm run check` runs format, lint, type, architecture, CSS, and unit checks. `scripts/check-architecture.sh` (`npm run check:architecture`) enforces five rules and reports the rule and path:

- `[sql-ownership]`: raw SQL appears only in `src/infrastructure/database/connection.ts`, `src/infrastructure/database/migrations.ts`, and feature `repository.ts` or `repositories/*.ts` files.
- `[sqlite-boundary]`: only `src/infrastructure/database/connection.ts` imports `better-sqlite3` or constructs a database.
- `[browser-server]`: browser code under `public/` does not import `src/application`, `src/main`, `src/config`, or anything under `src/infrastructure/`.
- `[secret-crypto]`: only `src/features/secrets/crypto.ts` calls `createCipheriv` or `createDecipheriv`.
- `[activity-outbox]`: `src/features/activity/` does not import events or the outbox, so Activity never feeds the outbox ([ADR-0005](adr/0005-integrations-events-and-bounded-outbox.md)).

`scripts/check-css.ts` (`npm run check:css`) compares every class in `public/css/` with the markup in `views/`, `public/js/` and `src/`, checks each stylesheet's rules and declarations, and reports the rule and path:

- `[inline-style]`: no template under `views/` has a `style` attribute or a `<style>` element, so the CSP stays `style-src 'self'`.
- `[undefined-class]`: every class a template or script puts in markup is defined by a stylesheet. Classes defined only by the generated `/assets/css/display.css` (`.admin-shell`, `.display-preview`) count as defined because the check builds that stylesheet from `src/features/display/palette.ts`.
- `[unused-selector]`: every class a stylesheet selects is used by a template or script.
- `[duplicate-selector]`: a stylesheet declares each selector (the whole selector list) once per at-rule context.
- `[unlayered]`: every rule sits in one of the cascade layers `tokens.css` declares. An unlayered rule would beat every layer.
- `[colour-literal]`: no hex colour, colour function or named colour outside `tokens.css`, the generated palettes and `@media print`. Use a palette role from `src/features/display/palette.ts` or a token in `tokens.css`; `transparent` and `currentColor` are allowed.
- `[important]`: no `!important` outside `IMPORTANT_ALLOWED` in `scripts/check-css.ts`, which holds only `[hidden] { display: none }`. Use the layer order or a more specific selector.
- `[bare-button-modifier]`: no `primary`, `secondary` or `danger` class in markup; use `button button--primary` and so on.
- `[button-modifier]`: a `button--*` class appears only beside `button` in the same class attribute or `className` value. `classList` calls are not checked, since they edit an element's existing classes.
- `[unclassed-button]`: every `<button>` written in a template or script has a class. Buttons built with `document.createElement` are not checked.
- `[dynamic-class]`: a class built from data (`status-badge--<%= fill.state %>`) belongs to a modifier family in `DYNAMIC_MODIFIER_PREFIXES`; any defined modifier of a listed family counts as used. Script and test hooks are `data-*` attributes, not classes.

The check reads markup statically, so two things stay unchecked: a class attribute that is entirely an expression (`class="<%= item.className %>"`, whose values come from `className` properties and types in code), and whether each modifier of a listed family is still produced.

`test/architecture.test.ts` covers each architecture rule and `test/css-check.test.ts` each CSS rule. The production Dockerfile and Compose example are verified by behavior through `scripts/check-production-container.sh`.

## Design history

[ADRs](adr/) record the decisions behind the v2 rebuild, and [`history/rebuild/`](history/rebuild/) archives its targets and acceptance evidence. The v1 application is recoverable at commit `429cf07e451b64ca1713655a34ffa5ebd376efae`; v2 does not import it or its schema.
