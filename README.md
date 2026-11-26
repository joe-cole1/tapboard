# Tapboard

Tapboard is a self-hosted taproom display for one homebrewing household. It shows what is on tap, detects pours from keg-scale and flow-meter telemetry, forecasts when each keg runs out, syncs recipes from Brewfather or imports them from recipe files, gives recipe-based flavor guidance, and raises health incidents that can be sent to Home Assistant or any webhook. It runs as one Node 24 process with SQLite and server-rendered pages: `/` is the public dashboard and `/admin` is the PIN-protected Admin. Pages work without JavaScript, and Home Assistant, Brewfather, and every destination are optional.

## Quick start

Install Node 24 and the locked dependencies (`better-sqlite3` may need a C/C++ toolchain to build):

```sh
npm ci
```

Set the four-digit Admin PIN over stdin, then start the server. `TAPBOARD_EXTERNAL_ORIGIN` must be the address you open in the browser, or Admin sign-in fails:

```bash
export TAPBOARD_EXTERNAL_ORIGIN=http://127.0.0.1:3000
IFS= read -r -s TAPBOARD_NEW_PIN; printf '\n'
printf '%s\n' "$TAPBOARD_NEW_PIN" | npm run operator:reset-pin
unset TAPBOARD_NEW_PIN
npm start
```

Open http://127.0.0.1:3000. A ready server answers `GET /healthz` with HTTP 200 and `{"status":"ok","schemaVersion":32}`; readiness covers only the local application and database, not integrations.

To try Tapboard without hardware, sign in, open **Admin → Simulation**, and turn on **Enable simulation** (see [Simulation](docs/operations.md#built-in-simulation)). The dashboard's **Settings** link always leads to Admin, even with no taps or with integrations offline.

For production, use the hardened Compose example described in [operations](docs/operations.md).

## Configuration

Tapboard reads environment variables only:

| Variable                         | Default                                                 | Purpose                                                                                                     |
| -------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `TAPBOARD_HOST`                  | `127.0.0.1`                                             | Listen address                                                                                              |
| `TAPBOARD_PORT`                  | `3000`                                                  | Listen port                                                                                                 |
| `TAPBOARD_DATABASE_PATH`         | `data/tapboard-v2.sqlite3` (from the working directory) | SQLite file; its directory is created when needed                                                           |
| `TAPBOARD_EXTERNAL_ORIGIN`       | unset                                                   | The exact `http`/`https` origin browsers use. Admin sign-in and changes are accepted only from this origin. |
| `TAPBOARD_TRUSTED_PROXIES`       | unset                                                   | Comma-separated exact addresses of trusted reverse proxies                                                  |
| `TAPBOARD_SECRET_KEY`            | unset                                                   | Canonical 32-byte base64url key that encrypts integration credentials                                       |
| `TAPBOARD_SESSION_INACTIVITY_MS` | `2592000000` (30 days)                                  | Admin session inactivity limit, until a policy is saved in System                                           |
| `TAPBOARD_SESSION_ABSOLUTE_MS`   | `31536000000` (365 days)                                | Admin session absolute limit, until a policy is saved in System                                             |
| `TAPBOARD_SHUTDOWN_GRACE_MS`     | `5000`                                                  | How long shutdown waits for open requests                                                                   |

`.env.example` is a template for the Compose `.env` file. The production Compose file adds its own deployment variables and accepts a few legacy names; [operations](docs/operations.md) lists them.

The Admin PIN is exactly four ASCII digits; there is no default PIN and no browser reset. `TAPBOARD_SECRET_KEY` is independent of the PIN. Without it, or with the wrong key, stored integration credentials are unavailable but Tapboard keeps working and keeps the encrypted rows. Never put the PIN or key in a command argument, log, or browser field.

## Operator commands

Each command reads secrets only from stdin and prints only safe metadata. In a container, run it with `docker compose … exec -T tapboard`.

| Command                                      | Purpose                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run operator:reset-pin`                 | Set or reset the Admin PIN from one stdin line; revokes every session                                                         |
| `npm run operator:rotate-secret-key`         | Re-encrypt every stored credential, reading the old key and then the new key from stdin                                       |
| `npm run operator:backup [target-directory]` | Write integrity-checked online copies of the database (and the saved Simulation) to `<database directory>/backups` by default |

[Operations](docs/operations.md) covers each in detail, including copying backups off the host and restoring.

## Development checks

| Command             | Purpose                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`     | The full gate CI runs: format, lint, types, architecture and CSS rules, and the unit tests                                                                                                                                                  |
| `npm run check:css` | The stylesheet rules only: no inline CSS, no undefined or unused classes, no duplicate selectors, every rule in a cascade layer, no colour literals outside the palettes, no `!important`, buttons only through `.button` and its modifiers |
| `npm run test:e2e`  | The Playwright browser suite against a throwaway fixture server                                                                                                                                                                             |

[Development](docs/development.md) lists every command.

## Features

- **Telemetry devices.** Scales, temperature and pressure probes, flow meters, and bridges post readings to `/api/v1/telemetry` with a per-source key. Each Tap has optional level (scale), condition (temperature, pressure), and flow (flow meter) sources; with a flow source, pours come from the meter and a scale gives remaining volume. [Telemetry clients](docs/telemetry-clients.md) has `curl`, ESP32, and Home Assistant examples; the contract is [`openapi/telemetry-v1.json`](openapi/telemetry-v1.json).
- **Recipe flavor guidance.** Brew Story shows eight axes (malt, hops, bitterness, sweetness, body, roast, tartness, alcohol). Each comes from a manual override, the recipe, a reviewed style baseline, or shows as unknown. It is a deterministic heuristic over a local catalog of producers' ingredient data, not a trained model, and needs no extra service. A linked Brewfather batch's description is its recipe `teaser`; batch and recipe notes are never shown. See [the flavor model](docs/flavor-model.md) and [catalog sources](docs/flavor-catalog-sources.md).
- **Recipe file import.** A Custom beverage can take one recipe file: a Brewfather batch or recipe JSON export, BeerJSON, or BeerXML (BeerSmith, Brewer's Friend, Grainfather and others export it). It feeds the recipe sheet and flavor guidance with no Brewfather account; see [operations](docs/operations.md#import-a-recipe-file).
- **Mystery Tap and Tap Wars.** A Tap can hide its beer's identity and reveal chosen fields, and two Taps can compete in an anonymous public vote.
- **Outbound events.** Pours, keg changes, low kegs, health transitions, and integration status changes can go to Home Assistant (`tapboard_event`) or webhooks (public addresses, or LAN and VPN receivers such as n8n over Tailscale when **Allow private network address** is on), each marked Required or optional for the dashboard's connectivity indicator.
- **System administration.** **Admin → System** has readiness, storage and delivery counts, calculation defaults, units, and Admin access; **Admin → Logs** has the Activity log, Admin sessions, and retention; see [operations](docs/operations.md#system-administration).
- **Built-in Simulation.** A saved sample taproom with simulated scales and flow meters, kept apart from real data; see [operations](docs/operations.md#built-in-simulation).

Admin error messages carry a reference that matches one sanitized event in the server log; [operations](docs/operations.md#diagnose-failures) explains the connectivity indicator and diagnostics.

## Documentation

- [Operations](docs/operations.md): production Compose, reverse proxy, PIN and key, backup and restore, Simulation, System and Logs, diagnostics.
- [Development](docs/development.md): running from source, tests, the development container, and pull requests.
- [Architecture](docs/architecture.md): the current design.
- [Telemetry clients](docs/telemetry-clients.md) and [`openapi/telemetry-v1.json`](openapi/telemetry-v1.json): sending readings.
- [Flavor model](docs/flavor-model.md) and [flavor catalog sources](docs/flavor-catalog-sources.md).
- [`docs/adr/`](docs/adr/) and [`docs/history/rebuild/`](docs/history/rebuild/): the decisions and records behind the v2 rebuild. They are background, not requirements.

The code and its executable configuration are the source of truth. When a document disagrees with the code, trust the code and fix the document.
