# Telemetry clients and bridges

Any device that can make an HTTPS (or LAN HTTP) request can report to Tapboard: a keg scale, a
temperature probe, an ESP32 sketch, Home Assistant, or a small script. Tapboard loads no device
code. It accepts readings of registered metrics on one endpoint, and everything else stays on the
device or bridge side. The machine contract is [`openapi/telemetry-v1.json`](../openapi/telemetry-v1.json).

## 1. Create a source and select it for a Tap

1. In Admin, open **Integrations → Telemetry** and use **Create a telemetry source**. Give it a
   name (for example `Keg scale 1`). The machine key (`tbk_…`) is shown **once**; store it in
   the device or bridge configuration, not in a shared document.
2. Open the Tap in Admin (**Taps → the Tap → Telemetry authority**), choose the source under
   **Authoritative source**, and save. A Tap has at most one authoritative source; readings from
   any other source are rejected as `telemetry.not_authoritative`.
3. Rotating the key (source page → **Key actions**) issues a new secret and revokes the old one.
   The source, its Tap assignments, and its idempotency history are kept.

The examples below read the base URL and key from the environment:

```sh
export TAPBOARD_URL=http://localhost:3000
export TAPBOARD_KEY=tbk_your_key_here
```

## 2. Endpoints and authentication

| Endpoint                                  | Body                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| `POST /api/v1/telemetry/taps/{tapNumber}` | One sample, at most 16 KiB                           |
| `POST /api/v1/telemetry/batch`            | `{"samples": [...]}`, 1–100 samples, at most 256 KiB |

Every request sends `Authorization: Bearer <machine key>` and `Content-Type: application/json`.
Cookies, query-string keys, and the Admin PIN are not accepted.

## 3. Payload

Every sample has a strict RFC3339 `measured_at` with an uppercase `T` and an explicit `Z` or
`+HH:MM` offset (`2026-11-19T10:00:00Z`, `2026-11-19T11:00:00.250+01:00`), and an optional
`client_sample_id` (1–128 characters from `A–Z a–z 0–9 _ . : / -`). Then use **one** of two forms.

**Measurement form**: one keg-level reading, with optional temperature:

```json
{
  "client_sample_id": "scale1-000123",
  "measured_at": "2026-11-19T10:00:00Z",
  "measurement": { "kind": "total_weight", "value": 21.4, "unit": "kg" },
  "temperature": { "value": 3.8, "unit": "c" }
}
```

**Readings form**: any registered readings, each at most once and at most one keg-level reading.
A sample may have no keg-level reading at all, such as a probe reporting temperature alone:

```json
{
  "client_sample_id": "probe1-000045",
  "measured_at": "2026-11-19T10:00:00Z",
  "readings": [{ "metric": "temperature", "value": 38.9, "unit": "f" }]
}
```

A body that has both `readings` and `measurement` or `temperature` is rejected. Batch samples add
`tap_number` and otherwise use either form. The two forms of the same values are the same sample:
retrying `{"measurement": {"kind": "total_weight", "value": 21.4, "unit": "kg"}}` as
`{"readings": [{"metric": "total_weight", "value": 21.4, "unit": "kg"}]}` with the same
`client_sample_id` is a duplicate, not a conflict.

A sample with a keg-level reading feeds pour detection, forecasts, and keg-level health. A sample
without one is stored, updates the latest readings, health (serving temperature), and the tap
card's temperature, and leaves pour detection untouched.

## 4. Registered metrics

Tapboard accepts only these metrics. Bounds apply to the value as sent, before unit conversion.

| Metric             | Role                                                                             | Units                           | Bounds      | Stored as   |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------- | ----------- | ----------- |
| `total_weight`     | keg level: keg plus beer, interpreted with the keg's tare and the beer's density | `g`, `kg`, `oz`, `lb`           | ≥ 0         | grams       |
| `remaining_volume` | keg level                                                                        | `ml`, `l`, `us_fl_oz`, `us_gal` | ≥ 0         | millilitres |
| `fill_percentage`  | keg level                                                                        | `percent`                       | 0–100       | percent     |
| `temperature`      | condition: serving-temperature health and the tap card                           | `c`, `f`                        | −100 to 150 | Celsius     |

Values are rounded to six decimal places after conversion. An unregistered metric or a unit the
metric does not accept is a 400 whose `details.reason` names the metric.

## 5. Responses

| Status | Meaning                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | Accepted, or an exact duplicate of an earlier sample (`"duplicate": true`)                                                                                                                                                         |
| 400    | Structural error: invalid JSON, an unknown field, both forms, an unregistered metric or unit, a repeated metric, two keg-level readings, a value out of bounds, or a bad timestamp. `error.details` names the `field` and `reason` |
| 401    | Missing, invalid, or revoked machine key                                                                                                                                                                                           |
| 404    | No Tap with that number                                                                                                                                                                                                            |
| 409    | Durable rejection with a `code` (below), or `telemetry.idempotency_conflict`                                                                                                                                                       |
| 413    | Body over 16 KiB (single) or 256 KiB (batch)                                                                                                                                                                                       |
| 429    | `telemetry.rate_limited`: retry later with the same `client_sample_id`                                                                                                                                                             |

The batch endpoint returns 200 with one result per sample once the batch is structurally valid;
each result carries its own `outcome` and `code`.

| Code                             | Cause                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `telemetry.accepted`             | Stored                                                                                                             |
| `telemetry.not_authoritative`    | This source is not the Tap's authoritative source                                                                  |
| `telemetry.tap_retired`          | The Tap is retired                                                                                                 |
| `telemetry.future_timestamp`     | `measured_at` is more than 300 s ahead of Tapboard's clock (default)                                               |
| `telemetry.stale_timestamp`      | `measured_at` is older than the 6 h reconnect horizon (default)                                                    |
| `telemetry.out_of_order`         | `measured_at` is not newer than this source's latest accepted sample for the Tap, whatever readings either carried |
| `telemetry.idempotency_conflict` | The same `client_sample_id` (or, without one, the same Tap and `measured_at`) was sent with different values       |

Retries are safe: an identical sample with the same identity returns the original outcome with
`"duplicate": true`. By default each source may send 600 samples per minute, with a burst of 100.

## 6. Examples

### curl

A weight with temperature, in the measurement form:

```sh
curl -sS -X POST "$TAPBOARD_URL/api/v1/telemetry/taps/1" \
  -H "Authorization: Bearer $TAPBOARD_KEY" -H "Content-Type: application/json" \
  -d "{\"client_sample_id\":\"curl-$(date -u +%s)-w\",\"measured_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"measurement\":{\"kind\":\"total_weight\",\"value\":21.4,\"unit\":\"kg\"},\"temperature\":{\"value\":3.8,\"unit\":\"c\"}}"
```

Temperature alone, in the readings form (wait a second after the previous command, because each
sample must be newer than the last):

```sh
curl -sS -X POST "$TAPBOARD_URL/api/v1/telemetry/taps/1" \
  -H "Authorization: Bearer $TAPBOARD_KEY" -H "Content-Type: application/json" \
  -d "{\"client_sample_id\":\"curl-$(date -u +%s)-t\",\"measured_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"readings\":[{\"metric\":\"temperature\",\"value\":38.9,\"unit\":\"f\"}]}"
```

Two Taps in one batch:

```sh
curl -sS -X POST "$TAPBOARD_URL/api/v1/telemetry/batch" \
  -H "Authorization: Bearer $TAPBOARD_KEY" -H "Content-Type: application/json" \
  -d "{\"samples\":[{\"tap_number\":1,\"client_sample_id\":\"curl-$(date -u +%s)-b1\",\"measured_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"readings\":[{\"metric\":\"remaining_volume\",\"value\":12.5,\"unit\":\"l\"}]},{\"tap_number\":2,\"client_sample_id\":\"curl-$(date -u +%s)-b2\",\"measured_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"readings\":[{\"metric\":\"fill_percentage\",\"value\":64,\"unit\":\"percent\"},{\"metric\":\"temperature\",\"value\":4.1,\"unit\":\"c\"}]}]}"
```

The batch needs the source to be authoritative for both Taps. A sample for a Tap it isn't
authoritative for comes back as `telemetry.not_authoritative` in its result.

### ESP32 (Arduino) posting directly

The ESP32 needs the time from NTP for `measured_at`. A `client_sample_id` that counts up and is
saved across restarts (or the epoch seconds) makes retries safe.

```cpp
#include <HTTPClient.h>
#include <WiFi.h>
#include <time.h>

const char* kUrl = "http://tapboard.local:3000/api/v1/telemetry/taps/1";
const char* kKey = "Bearer tbk_your_key_here";  // keep out of source control

void setup() {
  WiFi.begin("ssid", "password");
  while (WiFi.status() != WL_CONNECTED) delay(500);
  configTime(0, 0, "pool.ntp.org");  // UTC
}

bool postSample(float weightKg, float temperatureC) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false;  // clock not set yet
  char measuredAt[25];
  strftime(measuredAt, sizeof measuredAt, "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));
  char body[256];
  snprintf(body, sizeof body,
           "{\"client_sample_id\":\"esp32-%ld\",\"measured_at\":\"%s\","
           "\"readings\":[{\"metric\":\"total_weight\",\"value\":%.3f,\"unit\":\"kg\"},"
           "{\"metric\":\"temperature\",\"value\":%.2f,\"unit\":\"c\"}]}",
           (long)now, measuredAt, weightKg, temperatureC);
  HTTPClient http;
  http.begin(kUrl);
  http.addHeader("Authorization", kKey);
  http.addHeader("Content-Type", "application/json");
  int status = http.POST(body);
  http.end();
  return status == 200 || status == 409;  // 409 is a durable answer; don't retry it
}

void loop() {
  postSample(readScaleKg(), readProbeC());  // your sensor code
  delay(10000);
}
```

Retry on network errors, 429, and 5xx with the same body. Don't retry 400, 401, 404, or 409.

### ESP32 → Home Assistant → Tapboard

If the ESP32 already reports to Home Assistant (for example through ESPHome), Home Assistant can
forward its sensors. Put the key in `secrets.yaml`:

```yaml
# secrets.yaml
tapboard_tap1_authorization: "Bearer tbk_your_key_here"
```

```yaml
# configuration.yaml
rest_command:
  tapboard_tap1:
    url: "http://tapboard.local:3000/api/v1/telemetry/taps/1"
    method: post
    headers:
      authorization: !secret tapboard_tap1_authorization
    content_type: "application/json"
    payload: >-
      {"client_sample_id": "ha-tap1-{{ now().timestamp() | int }}",
       "measured_at": "{{ now().isoformat() }}",
       "readings": [
         {"metric": "total_weight", "value": {{ weight_kg | float }}, "unit": "kg"},
         {"metric": "temperature", "value": {{ temperature_c | float }}, "unit": "c"}
       ]}

automation:
  - alias: "Forward keg 1 to Tapboard"
    mode: queued
    triggers:
      - trigger: state
        entity_id: sensor.keg1_weight
    actions:
      - action: rest_command.tapboard_tap1
        data:
          weight_kg: "{{ states('sensor.keg1_weight') }}"
          temperature_c: "{{ states('sensor.keg1_temperature') }}"
```

`now().isoformat()` includes the local offset, which Tapboard accepts. To send temperature on its
own schedule, add a second `rest_command` whose `readings` contains only `temperature`.

## 7. Bridging an off-the-shelf device

Tapboard has no device plugins. A commercial scale, a Bluetooth hydrometer, or a smart plug's
temperature sensor is connected by something outside Tapboard that reads the device and posts
readings:

- **Home Assistant**: if Home Assistant already has an integration for the device, forward its
  entities with a `rest_command` as above. This is the usual route.
- **A small script** on any always-on machine: read the device with its own library or API, map
  the values to registered metrics and units, and post them. For example, in Python using only
  the standard library:

```python
import datetime, json, os, time, urllib.error, urllib.request

URL = os.environ["TAPBOARD_URL"] + "/api/v1/telemetry/taps/1"
KEY = os.environ["TAPBOARD_KEY"]

def read_device():
    """Replace with the device's own library or API call."""
    return {"weight_lb": 47.2, "temp_f": 38.5}

while True:
    values = read_device()
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    body = {
        "client_sample_id": f"bridge-{int(now.timestamp())}",
        "measured_at": now.isoformat().replace("+00:00", "Z"),
        "readings": [
            {"metric": "total_weight", "value": values["weight_lb"], "unit": "lb"},
            {"metric": "temperature", "value": values["temp_f"], "unit": "f"},
        ],
    }
    request = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            print(response.status, response.read().decode())
    except urllib.error.HTTPError as error:
        print(error.code, error.read().decode())
    time.sleep(30)
```

A reading that has no registered metric (humidity, CO₂, flow) can't be sent yet. Registering a
condition or recorded metric is a code change to `src/features/telemetry/metrics.ts`, with no
migration; see [architecture.md](../architecture.md).

## 8. Troubleshooting

| Symptom                                               | Check                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 401                                                   | The header is `Authorization: Bearer tbk_…` with the whole key; the key wasn't rotated; the source isn't disabled       |
| 404                                                   | The URL's tap number matches a Tap in Admin                                                                             |
| 409 `telemetry.not_authoritative`                     | The Tap's **Authoritative source** is this source                                                                       |
| 409 `telemetry.future_timestamp` or `stale_timestamp` | The device clock (NTP) and that `measured_at` is UTC or carries its offset                                              |
| 409 `telemetry.out_of_order`                          | Each sample's `measured_at` is newer than the last one from this source for the Tap, including temperature-only samples |
| 409 `telemetry.idempotency_conflict`                  | `client_sample_id` is unique per sample, not reused for new values                                                      |
| 400 naming a metric or unit                           | The metric and unit are in the table above, spelled exactly (lowercase)                                                 |
| 400 "must use either 'measurement' … or 'readings'"   | The body uses one form only                                                                                             |
| Accepted but the volume doesn't move                  | The Tap has a Fill assigned, and the sample carries a keg-level reading; temperature-only samples never move the volume |
