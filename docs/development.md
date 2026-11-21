# Development

How to run, test, and change Tapboard locally. Project rules for changes are in [`CLAUDE.md`](../CLAUDE.md); the design is in [architecture](architecture.md); production operation is in [operations](operations.md).

## Run from source

Use Node 24 and install the locked dependencies. `better-sqlite3` is a native module, so npm may need a C/C++ toolchain (on Linux, GNU Make and a C++ compiler) to build it.

```sh
npm ci
```

Run against a throwaway database. `TAPBOARD_EXTERNAL_ORIGIN` must match the address you open, or Admin sign-in fails:

```bash
export TAPBOARD_DATABASE_PATH=/tmp/tapboard-dev.sqlite3
export TAPBOARD_EXTERNAL_ORIGIN=http://127.0.0.1:3000
IFS= read -r -s TAPBOARD_NEW_PIN; printf '\n'
printf '%s\n' "$TAPBOARD_NEW_PIN" | npm run operator:reset-pin
unset TAPBOARD_NEW_PIN
npm start
```

Open http://127.0.0.1:3000 and sign in at http://127.0.0.1:3000/admin. `curl -fsS http://127.0.0.1:3000/healthz` returns readiness. Without `TAPBOARD_SECRET_KEY`, integration credentials can't be stored; everything else works. The [README](../README.md#configuration) lists every setting.

The built-in [Simulation](operations.md#built-in-simulation) is the main way to exercise Tapboard without hardware. When a change adds or alters data Tapboard accepts or shows, update `src/features/simulation/` (seed, sensors, runner) in the same change so the sample workspace produces it.

## Checks and tests

| Command                                      | What it does                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                              | The full gate: Prettier check, ESLint, `tsc --noEmit`, the architecture rules, and the unit tests. CI runs the same gate. |
| `npm test`                                   | The `node:test` unit suite only (`test/*.test.ts`).                                                                       |
| `node --test test/<name>.test.ts`            | One test file.                                                                                                            |
| `npm run check:architecture`                 | The architecture rules only (`scripts/check-architecture.sh`).                                                            |
| `npm run format`                             | Rewrites files with Prettier.                                                                                             |
| `npm run test:e2e`                           | The Playwright browser suite against a fixture server on port 4176 (`TAPBOARD_E2E_PORT` changes it).                      |
| `npm run test:e2e -- --last-failed`          | Reruns only the browser specs that failed last time.                                                                      |
| `bash scripts/check-production-container.sh` | Builds the production image and checks it in a disposable Compose project; needs a running Docker daemon.                 |

The browser suite needs Chromium. Install Playwright's build once:

```sh
npx playwright install chromium
```

To use an existing Chromium instead, skip the install and set `TAPBOARD_E2E_CHROMIUM_PATH` to its executable. In Claude Code cloud sessions, the SessionStart hook in `.claude/hooks/` activates Node 24, installs dependencies, and sets that variable; don't run `playwright install` there.

`scripts/check-production-container.sh` uses only its own uniquely named project, containers, and volume and removes only what it created; it never touches development or production data.

CI (`.github/workflows/rebuild-guardrails.yml`) runs three jobs on every pull request: `check` (the gate plus a changed-line whitespace check), `e2e` (the browser suite; failed specs are rerun once and the first run's traces are uploaded as the `e2e-first-run` artifact), and `production-container`. A ruleset requires all three and requires the pull request to be up to date with `main`; a pull request that falls behind waits for `gh pr update-branch <number>` and a passing rerun.

Flavor tools: `node scripts/flavor-resolve.ts <fermentables|hops|yeasts|miscs> "<name>" [--maker M] [--code C] [--type T] [--form F] [--color SRM]` shows how one ingredient resolves, and `node scripts/report-flavor-corpus.ts [output-path]` regenerates the offline corpus report (default `docs/reports/flavor-corpus.json`). [The catalog sources](flavor-catalog-sources.md#adding-or-updating-an-ingredient) explain how to add an ingredient.

## Development container

### Operator workstation: native WSL launcher

This applies only where `/home/joeadmin/.local/bin/tapboard-dev` exists. The launcher lives outside the repository and is not on the PATH, so use its full path. It runs a native WSL container (through `/mnt/c/Program Files/WSL/wslc.exe`) named `tapboard-dev` at http://localhost:3000; Docker Desktop is not needed.

```sh
/home/joeadmin/.local/bin/tapboard-dev start     # start the existing container and wait until healthy
/home/joeadmin/.local/bin/tapboard-dev health    # check /healthz reports the repository's current schema
/home/joeadmin/.local/bin/tapboard-dev rebuild   # rebuild from the working tree and recreate the container
/home/joeadmin/.local/bin/tapboard-dev status    # container state, image revision, mounts, and ports
/home/joeadmin/.local/bin/tapboard-dev logs      # the last 100 log lines
/home/joeadmin/.local/bin/tapboard-dev stop
/home/joeadmin/.local/bin/tapboard-dev pin       # set the PIN from an interactive terminal
/home/joeadmin/.local/bin/tapboard-dev --help
```

`rebuild` builds `Dockerfile.dev` from the `/home/joeadmin/projects/tapboard` checkout, including uncommitted changes, labels the image with the revision and whether the tree was dirty, and waits for health. It needs a regular, Git-ignored `.env` in that checkout, which it passes to the container without reading. Start, stop, and rebuild keep the `tapboard-dev-data` volume and its PIN. That volume is separate from portable Compose's `tapboard-dev_tapboard-data`; never swap or delete either. The container does not start automatically after a Windows reboot. This workflow does not replace the Docker-based production container check.

### Portable Docker Compose

This needs Docker Engine with the Compose v2 plugin and an ignored `.env` holding a canonical 32-byte base64url `TAPBOARD_SECRET_KEY`. No real key belongs in Git. Write a new key without printing it (the command does nothing if `.env` exists):

```sh
test ! -e .env && (umask 077; printf 'TAPBOARD_SECRET_KEY=' > .env; openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n=' >> .env; printf '\n' >> .env)
```

`.env.example` lists the other settings. Build, start, and control the service:

```sh
docker compose -f compose.dev.yaml up --build -d
docker compose -f compose.dev.yaml ps
curl -fsS http://127.0.0.1:3000/healthz
docker compose -f compose.dev.yaml logs -f --tail=200 tapboard
docker compose -f compose.dev.yaml restart tapboard
docker compose -f compose.dev.yaml stop
docker compose -f compose.dev.yaml down
docker compose -f compose.dev.yaml up --build --force-recreate -d
```

The app is published at http://127.0.0.1:3000, which is also its configured origin. SQLite lives at `/app/data/tapboard-v2.sqlite3` on the `tapboard-dev_tapboard-data` volume, which stop, `down`, restart, recreate, and rebuild all keep. Set the PIN over stdin while the service runs:

```bash
IFS= read -r -s TAPBOARD_NEW_PIN; printf '\n'
printf '%s\n' "$TAPBOARD_NEW_PIN" | docker compose -f compose.dev.yaml exec -T tapboard npm run operator:reset-pin
unset TAPBOARD_NEW_PIN
```

Key rotation and backups work as in [operations](operations.md#protect-the-pin-and-encryption-key), with `docker compose -f compose.dev.yaml` in place of the production Compose prefix. Keep the production Compose example for its separately named production project; don't point the development project at it.

### DEV-ONLY destructive reset

This deletes the portable development database volume. Never run it for another Compose project, and never as a normal rebuild:

```sh
docker compose -f compose.dev.yaml down --volumes
docker compose -f compose.dev.yaml up --build -d
```

`compose.dev.yaml` declares only the Tapboard development data volume, so this does not touch other projects. The fresh database has no PIN until you set one.

## Pull requests

Every implementation pull request description includes a `## MANUAL DEV TEST` section: short steps, specific to that change, that the operator runs against a rebuilt development container. These steps belong only in the pull request, never in README or the guides; the guides describe the current state.
