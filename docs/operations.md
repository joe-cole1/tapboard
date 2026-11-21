# Tapboard operator and security guide

This guide covers running Tapboard in production with Docker Compose: deployment, reverse proxies, the PIN and encryption key, backups, Simulation, System administration, and diagnosing failures. `GET /healthz` reports the database schema version the running build expects (see [architecture](architecture.md#sqlite-and-migrations)). Development and test commands are in [development](development.md).

## Production image

The root `Dockerfile` is the default for Compose `build.context: <repository>#main` configurations, so no `dockerfile:` override is needed. It uses a digest-pinned, multi-stage Node 24 image, installs only the locked production dependencies, and includes `wget` for existing health checks. `Dockerfile.dockerignore` admits only the runtime build inputs and excludes environment files, keys, databases, logs, and host dependencies. Git credentials belong to the deployment tool, never to build arguments or committed URLs.

The image runs as `node` (UID/GID 1000), listens on `0.0.0.0:3005`, and stores SQLite at `/app/data/tapboard-v2.sqlite3`. It works with port `3005:3005`, user `1000:1000`, a read-only root, a writable data volume, a `/tmp` tmpfs, dropped capabilities, `no-new-privileges`, `init`, and a 15-second stop grace. `GET` and `HEAD /healthz` share readiness semantics, so the probe `wget --no-verbose --tries=1 --spider http://localhost:3005/healthz` works. The image has its own health check, which Compose may override.

Existing external env files may use these aliases:

| Canonical setting          | Accepted fallback                      |
| -------------------------- | -------------------------------------- |
| `TAPBOARD_PORT`            | `PORT`                                 |
| `TAPBOARD_DATABASE_PATH`   | `DATA_DIR` plus `/tapboard-v2.sqlite3` |
| `TAPBOARD_EXTERNAL_ORIGIN` | `TAPBOARD_PUBLIC_ORIGIN`               |

Canonical settings always win and keep their validation, even when invalid or empty. An empty legacy origin is treated as unset. The image sets `PORT=3005`, `DATA_DIR=/app/data`, and `TAPBOARD_HOST=0.0.0.0`. Local operator commands use the same configuration resolution as the server. Removing an alias is a breaking change.

Tapboard v2 does not read v1 data. An existing `tapboard.db` or `/app/backups` content is never read, migrated, modified, or deleted; the old backup mount is used only if named as an `operator:backup` target, which only adds files. A volume holding only v1 data starts a separate, empty v2 database with no PIN. Old PIN, integration, and secret settings are not translated. Do not point `TAPBOARD_DATABASE_PATH` at a v1 database or delete volumes to force startup.

## Deploy with Compose

Use Docker Compose 2.24.0 or later with `compose.production.example.yaml`. Keep a stable, separate project name such as `tapboard-prod`; changing it creates another named data volume. The example builds the root Dockerfile locally as `tapboard:local` (or `TAPBOARD_IMAGE`), publishes `127.0.0.1:3005` by default, and enforces UID/GID 1000, a read-only root, a restricted 16 MiB `/tmp`, dropped capabilities, no-new-privileges, init, SIGTERM with a 15-second grace, and one writable named data volume. Only `/app/data` persists. A fresh named volume takes the image's directory ownership; an existing bind mount must already let UID/GID 1000 write. Do not run Tapboard as root to work around permissions.

Keep the encryption key and deployment settings in an ignored, mode 0600 `.env` next to the Compose file; it is optional and loaded when present:

```sh
docker compose -p tapboard-prod -f compose.production.example.yaml up -d --build
docker compose -p tapboard-prod -f compose.production.example.yaml ps
curl -fsS http://127.0.0.1:3005/healthz
```

For an external file, export `TAPBOARD_ENV_FILE` and also pass it with `--env-file` on every Compose command, including `up`, `ps`, `exec`, and recreate. `TAPBOARD_ENV_FILE` supplies the container's runtime variables; `--env-file` supplies interpolation for the image, published address and port, and external origin. Without both, the loopback default can override the file's origin. Shell variables take precedence over the interpolation file. Never commit a real key or put it in a build argument, and avoid printing the interpolated Compose configuration, which can contain secrets. The container's host, port, and database path are fixed by the Compose file.

```sh
export TAPBOARD_ENV_FILE=/absolute/path/to/tapboard.env
docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml up -d --build
docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml ps
```

The remaining commands use `--env-file "${TAPBOARD_ENV_FILE:-.env}"`, so create the selected file before running them.

Set one exact browser-visible origin in `TAPBOARD_EXTERNAL_ORIGIN`. Admin sign-in and every Admin change are accepted only from that origin, so open Tapboard at exactly that address. For direct LAN HTTP, publish on the host's LAN address and set its exact origin, including the port; the container still listens on 3005:

```dotenv
TAPBOARD_PUBLISH_ADDRESS=192.168.1.50
TAPBOARD_PUBLISH_PORT=3005
TAPBOARD_EXTERNAL_ORIGIN=http://192.168.1.50:3005
```

## Reverse proxy

For a same-host HTTPS proxy, keep loopback publishing and set the HTTPS origin, for example `TAPBOARD_EXTERNAL_ORIGIN=https://tapboard.example.com`. An `https` origin makes session cookies Secure. Set `TAPBOARD_TRUSTED_PROXIES` to the exact source address the proxy connects from; wildcards and CIDR ranges are not accepted, and forwarded headers never replace the configured origin. Serve Tapboard at the root of its origin, preserve the Host header, and pass SSE through without buffering: `/api/public/events` and `/api/admin/events` are long-lived connections.

Tapboard's routes fall into two groups:

| Restrict at the proxy (Admin)                  | Keep reachable (public and devices)                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/admin` and `/admin/*`: Admin pages and login | `/` and `/taps/*`: dashboard and Brew Story pages                                                        |
| `/api/admin/*`: Admin JSON and Admin events    | `/api/public/*`: dashboard data, Story JSON, live events, Tap Wars and its vote form; and `/api/on-deck` |
|                                                | `/assets/*`: stylesheets, scripts, fonts, and images                                                     |
|                                                | `/healthz`: readiness                                                                                    |
|                                                | `/api/v1/telemetry/*`: device telemetry, authenticated by each source's Bearer key                       |

Admin already requires the PIN, a session, CSRF, and the exact origin, but the four-digit PIN is a small secret. To protect it further, limit `/admin*` and `/api/admin*` at the proxy, for example to LAN or VPN client addresses or behind proxy authentication. Do not move Admin to another host name: Admin works only from `TAPBOARD_EXTERNAL_ORIGIN`. The dashboard's Settings link points at `/admin`, so visitors outside the allowed range see the proxy's refusal. Every other path returns 404.

For an existing containerized proxy, attach Tapboard to a private network and remove its host port in an operator-owned override. Docker's [merge reference](https://docs.docker.com/reference/compose-file/merge/) documents `!reset`. This fragment assumes an already-created external network; adapt its name and connect the proxy to it:

```yaml
services:
  tapboard:
    ports: !reset []
    networks: [proxy]
networks:
  proxy:
    external: true
    name: tapboard-proxy
```

Pass both files in order: `docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml -f <operator-proxy-override> up -d --build`. The proxy forwards to `tapboard:3005`, and only the proxy publishes browser-facing ports. `TAPBOARD_TRUSTED_PROXIES` is still the proxy's exact observed address. Optional integrations need outbound network access, so do not make Tapboard's only network internal without another egress path.

## Initialize and update

A clean volume starts an empty database with no PIN. Set the PIN over stdin with hidden input; it is never a command argument:

```bash
IFS= read -r -s TAPBOARD_NEW_PIN; printf '\n'
printf '%s\n' "$TAPBOARD_NEW_PIN" | docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml exec -T tapboard npm run operator:reset-pin
unset TAPBOARD_NEW_PIN
```

The same command recovers a forgotten PIN; it also revokes every session. Changing the PIN in **Admin → System** requires the current PIN and also revokes every session.

Normal updates keep the project and its data volume:

```sh
git fetch --prune
git pull --ff-only
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml up -d --build --force-recreate
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml ps
curl -fsS http://127.0.0.1:3005/healthz
```

Use the LAN or proxy URL instead when selected. Readiness reports only local application and database status; an integration outage can degrade the public connectivity indicator while readiness and Admin stay available. Earlier v2 schemas upgrade automatically on startup; an older image refuses a newer database. A database whose schema is not a released v2 schema is rejected without repair: preserve it and plan its migration explicitly rather than deleting the volume. Never use `down --volumes` as an update step.

## Protect the PIN and encryption key

The four-digit PIN uses scrypt and durable throttling; it has limited offline resistance if its verifier is stolen. The encryption root key, `TAPBOARD_SECRET_KEY`, is independent of the PIN: it is a canonical 32-byte base64url value (43 characters) that encrypts integration credentials such as Brewfather API keys and outbound tokens. A missing or wrong key disables those credentials and leaves everything else working; encrypted rows are kept. Restore the correct key rather than deleting rows. Never put the key in command arguments, logs, screenshots, issues, or browser input.

To rotate the key, pipe the old and new keys over stdin. The command verifies the old key and re-encrypts every credential in one transaction:

```bash
IFS= read -r -s TAPBOARD_OLD_KEY; printf '\n'
IFS= read -r -s TAPBOARD_NEW_KEY; printf '\n'
printf '%s\n%s\n' "$TAPBOARD_OLD_KEY" "$TAPBOARD_NEW_KEY" | docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml exec -T tapboard npm run operator:rotate-secret-key
```

After it succeeds, replace only `TAPBOARD_SECRET_KEY` in the environment file (`TAPBOARD_ENV_FILE`, default `.env`), recreate the service, and clear the variables. This step runs Node on the host:

```sh
export TAPBOARD_NEW_KEY
node --input-type=module <<'NODE' && docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml up -d --force-recreate
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
const path = process.env.TAPBOARD_ENV_FILE ?? ".env";
if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Expected a regular env file");
const key = process.env.TAPBOARD_NEW_KEY;
if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").toString("base64url") !== key) throw new Error("Invalid new key");
const old = readFileSync(path, "utf8");
const lines = old.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?TAPBOARD_SECRET_KEY\s*=/.test(line));
const temporary = `${path}.rotation.tmp`;
writeFileSync(temporary, `${lines.join("\n").replace(/\n*$/, "")}\nTAPBOARD_SECRET_KEY=${key}\n`, { mode: 0o600, flag: "wx" });
renameSync(temporary, path);
NODE
unset TAPBOARD_OLD_KEY TAPBOARD_NEW_KEY
```

## Back up and restore

`npm run operator:backup [target-directory]` takes an online snapshot while Tapboard keeps running. The database uses SQLite's rollback journal, so copying the file directly can capture a half-written transaction. The command instead runs SQLite's `VACUUM INTO` on a read-only connection: it copies one committed state and never migrates or modifies the source. Application writes wait while the snapshot reads, roughly a second per 100 MB, and fail only if that exceeds SQLite's 5-second busy timeout. Each copy must pass SQLite's `quick_check` and foreign-key check before it gets its final name; otherwise the command exits nonzero. The saved Simulation database is copied too when it exists. The default target is `<database directory>/backups`, which in the production container is `/app/data/backups` on the persistent volume, because the root filesystem is read-only. An existing `/app/backups` mount can be the target when it's writable by UID 1000 and its filesystem supports hard links, which publish each finished copy without replacing anything. The command reads no stdin and never reads `TAPBOARD_SECRET_KEY`.

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml exec -T tapboard npm run operator:backup
```

The command prints only each copy's path and size, such as `/app/data/backups/tapboard-v2-20261017T031500Z.sqlite3 (1048576 bytes)`; a Simulation copy has the same name plus `.simulation.sqlite3`. Names carry a UTC timestamp, and an existing file is never overwritten. If any copy fails, the command exits 1 and removes that copy, so every file under a backup name passed the check; a killed run can leave `*.partial` and `*.partial-journal` files to delete. A failure prints one stderr line with a fixed reason, such as `Operator command failed: the database stayed locked for 5 seconds.`, `… a backup with this name already exists.`, or `… the copy of the Simulation database failed its integrity check.`, so cron mail tells lock contention, a full disk, and corruption apart. Reasons never include error text, paths, or secrets; an unexpected error prints only `Operator command failed.` The copies contain the Admin PIN verifier and encrypted integration credentials, so each is created with mode 0600. A missing target directory is created with mode 0700; its parent must already exist.

Copy a backup out of the container, then move it off the host with your own tooling. `docker compose cp` keeps the 0600 mode:

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml cp tapboard:/app/data/backups/tapboard-v2-20261017T031500Z.sqlite3 /secure/tapboard-backups/
```

Tapboard has no backup scheduler or retention engine; schedule backups with the operator's own cron. This script, run from a crontab entry such as `15 3 * * * /usr/local/bin/tapboard-backup`, takes a backup and then keeps the newest seven copies and their Simulation siblings. `set -e` skips pruning when the backup fails. Copy new backups off the host in the same script if you rely on them for disaster recovery.

```sh
#!/bin/sh
set -eu
cd /path/to/home-assistant-tapboard
export TAPBOARD_ENV_FILE=.env # or the absolute path of an external file; cron has no shell variables
tapboard() {
  docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml "$@"
}
tapboard exec -T tapboard npm run --silent operator:backup
tapboard exec -T tapboard sh -c 'cd /app/data/backups && ls -1r tapboard-v2-*Z.sqlite3 | tail -n +8 |
  while IFS= read -r f; do rm -f -- "$f" "$f.simulation.sqlite3"; done'
```

Backups never contain `TAPBOARD_SECRET_KEY`. Store the key separately from them, for example in a password manager: anyone holding both a backup and its key can decrypt the stored credentials, and a restored database without the matching key keeps its encrypted credentials but cannot use them until that key is configured. Root-key rotation re-encrypts only the live database, so keep each key for as long as you keep backups made under it.

To restore, stop Tapboard, replace the database file, and start it again; run the backup command first if the current database might still be needed. This one-off container uses the same volume and UID 1000, so the restored file keeps the expected owner. It renames the copy into place only after the whole transfer arrives, and removes any rollback journal left by the replaced database, which must never be applied to the restored copy:

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml stop tapboard
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml run --rm -T tapboard \
  sh -c 'cat > /app/data/restore.partial && rm -f /app/data/tapboard-v2.sqlite3-journal && mv /app/data/restore.partial /app/data/tapboard-v2.sqlite3' \
  < /secure/tapboard-backups/tapboard-v2-20261017T031500Z.sqlite3
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml start tapboard
curl -fsS http://127.0.0.1:3005/healthz
```

Restore a Simulation copy the same way, to `/app/data/tapboard-v2.sqlite3.simulation.sqlite3`. A backup from an earlier schema upgrades when Tapboard starts; an older image refuses a backup with a newer schema. A restore also brings back the PIN and Admin sessions from backup time: if the PIN changed or sessions were revoked since, run `operator:reset-pin` afterwards, which sets the PIN and revokes every session. Never use `down --volumes` as part of a restore. Browser restore, key escrow, and v1 data migration are outside Tapboard.

## Built-in Simulation

Simulation is a saved sample taproom for trying Tapboard without hardware. Open **Admin → System → Enable simulation**; Tapboard creates the sample workspace and opens **Simulator**. The dashboard, Beverages, Kegs, Fills, Taps, display controls, and history then show the sample workspace under a **SIMULATION** banner. The switch is installation-wide, so other open displays follow it.

A new sample workspace has five beers on tap (Oktoberfest, Saison, Porter, IPA, and Bourbon Barrel Stout) and two On Deck (Hefeweizen and Spiced Lager). Their recipes come from seven minimized, anonymized historical snapshots, which supply flavor guidance; simulated keg volume is independent of the historical batch volume. No account or external connection is created. A sample workspace whose original profiles and six-tap layout are untouched is upgraded in place to this layout; a customized one keeps its state.

Wait for a sensor to say **Ready**, then pour 4, 12, 16, or a custom 1–32 US fl oz. Readings flow on the server while you browse elsewhere, and the normal detector records the pours, which appear under **Keg Room → Filled Keg → Pour history**. **Pause sensor** stops readings and **Bring online** resumes them; health thresholds decide when a paused sensor becomes stale. **Noise** adds small scale fluctuations. Every sample sensor also reports serving pressure (11–13 psi). **Sample Tap 3** has a scale and a flow meter, so its pours come from the meter and its remaining volume from the scale. **Sample Tap 4** has only a flow meter, so its remaining volume is the keg capacity minus recorded pours. A simulated meter's counter starts at zero whenever the simulator starts, which Tapboard reads as a meter reset. Sample workspaces created before flow meters keep scale-only taps until **Reset simulation**.

**Exit simulation** saves the sample data and returns to normal operation; enabling it again resumes the same samples and history. **Reset simulation** asks for confirmation and replaces only the sample workspace. Normal data, integration configuration, and the PIN are untouched, and browser display preferences are kept separately for each mode. Switching keeps the initiating browser signed in and signs out other Admin sessions.

The sample database sits beside the normal one with `.simulation.sqlite3` appended to its filename, in the same data volume, and uses the same migrations. No extra container, port, environment variable, or service is needed. Integration management and external deliveries are unavailable in Simulation, and devices using the telemetry API keep updating the normal installation. The selected mode and sample data survive restarts; a pour running at shutdown stops at its last submitted volume. If the saved Simulation cannot open, Tapboard returns to the normal workspace and logs an error.

## System administration

**Admin → System** shows application readiness and version, local storage and delivery counts, a category-filtered Activity Log, calculation defaults, retention settings, and active Admin sessions, all as ordinary forms that work without JavaScript. Activity pages hold up to 50 entries. Diagnostics never call an external service or show credentials, private notes, raw payloads, or configured endpoints.

Calculation defaults set the Beverage fallback final gravity and the forecast serving size; a Beverage's own density and pour-size overrides take precedence. Changes apply to future telemetry and keep completed pours.

Session inactivity and absolute lifetimes can be set from one minute to one year, with inactivity no longer than the absolute lifetime. A saved policy overrides the environment defaults. Shorter limits apply to existing sessions immediately; longer limits cannot revive an expired session or extend its original absolute deadline. System lists up to 100 active sessions, marks the current one, and can revoke any of them.

Retention runs one bounded pass per minute. Reading history (hourly and daily min, max, mean, and last value per Tap and metric) keeps hourly rows for 30 days and daily rows for 730 days by default; both are System settings, and Admins can read it from `GET /api/admin/taps/:tapId/telemetry/rollups`. Raw telemetry, receipts, Activity, finished deliveries, and expired sessions are pruned by their own settings, while domain history, epochs, completed pours, calibration, maintenance, and deletion audits are kept. In Simulation, data settings, Activity, and storage diagnostics belong to the sample workspace; sessions, the PIN, and session policy are shared.

## Diagnose failures

The public header's connectivity indicator summarizes enabled Tap input checks, every enabled Brewfather account, and outbound destinations marked **Required** (off by default):

| Indicator            | Meaning                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Green **Connected**  | Every required check has confirmed healthy evidence.                                                                                                                                       |
| Yellow **Partial**   | A check is pending, an input is stale, or a connection has a transient failure.                                                                                                            |
| Red **Disconnected** | A required connection has missing or unavailable credentials, an authentication failure, a sustained outage, or critical input loss. Also shown when nothing is configured for monitoring. |

A required outbound failure turns yellow at once and red after five minutes of continuous failure; authentication and configuration failures are red at once. Optional and deliberately disabled integrations do not affect the indicator, but a required integration disabled because its credentials are missing stays red. Brewfather reports Connected only after a successful request with its current settings; saving credentials does not validate them. Changing an outbound endpoint or credentials also needs a fresh success. **Admin → Integrations** shows each destination's status, and the indicator is re-checked every 15 seconds.

Admin forms, autosaves, and pages explain known failures. An operational error shows a reference that matches one structured JSON event in the container log, with the operation, error code, severity, and, when available, the provider's HTTP status and retry delay. Logs never contain credentials, submitted forms, cookies, request headers, raw exception text, or provider response bodies, so a reference is enough for a support report; avoid copying secret-bearing input or interpolated Compose configuration into one. Brewfather's manual refresh distinguishes failed, partial, skipped, and verified work, and background failures are logged when their classification changes, then suppressed until a verified recovery. Logging never changes whether a change succeeds.

A startup warning identifies missing or invalid key configuration, or stored credentials that the current key cannot decrypt. Restore the original key or use rotation, and keep the data volume.

The public display keeps rendering when part of a Tap card or Story fails, falling back to "waiting for measurement", no temperature, no forecast, unknown health, hidden metrics, or the cached recipe. Each fallback logs a `warn` event, `Public story projection degraded`, with the operation, the Tap or Beverage id, and the error code and category, at most once per 15 minutes per operation and subject. The operations are `story.detector_diagnostics`, `story.serving_temperature`, `story.forecast_summary`, `story.health`, `story.display_settings`, `story.pour_history`, and `story.recipe_snapshots`. A Tap showing "waiting for measurement" alongside these events points to a bug or an unavailable dependency rather than missing telemetry. The Admin Filled Keg page also keeps rendering when pour history fails: it shows "Pour history is unavailable right now" and logs operation `admin.fill.pour_history`.

Follow the production logs with the same environment file and project:

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml logs -f --tail=200 tapboard
```
