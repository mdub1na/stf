# STF coordinator prototype

`stf coordinator` runs a separate STF process for trusted internal test workers.
One instance owns a request queue, renewable device leases and lease-scoped
Appium/ADB gateways. Workers keep test scenarios, assertions and reports. STF keeps
its device inventory, access groups and live viewer. Appium Grid keeps its
WebDriver routing and node slots.

This is a single-instance prototype with project-scoped credentials and quotas.
Appium supports the farm's Android and iOS nodes; Maestro supports physical Android.
There is no coordinator web UI, user-role migration or test execution engine.
The deployment is opt-in and is not added to the farm GitOps root. Short hardware
validation does not establish multi-hour reliability; record that separately.

The iOS signing guard and operator-only persistent device drains are documented
in [Personal Team WDA renewal](../tools/wda-renewal/README.md). They require the
version-2 state format; preserve current lease history when planning a rollback.

## Connection and lifecycle

```text
Kotlin/CI worker -> coordinator API -> queue -> STF reservation
                         |                       (usage=automation, leaseId)
                         +-> lease WebDriver gateway -> Appium Grid -> phone
                         +-> lease ADB gateway -> provider ADB pool -> Android
                         +-> heartbeat, deadline and cleanup

STF viewer -------------------------------------------------------> live screen
```

The portable worker client and GitLab Kubernetes runner deployment are described
in [CI workers beside the farm](ci-runners.md). Code in another repository uses
`stf utils test run`, not the server's STF credential or the shared pool ADB port.

## Project credentials and typed connections

`--api-token-file` remains the operator credential for legacy workers and recovery.
`--project-tokens-file` adds a private version-1 JSON document with a `projects`
array. Each record has a unique `id`, lowercase SHA-256 `tokenSha256` and positive
integer `maxParallel`. The `legacy` ID and duplicate token hashes are forbidden.
The token itself belongs in the project's masked CI variable. API credentials,
idempotency keys, request/lease access and concurrency are scoped to that project.
Recovery is operator-only. Removing a project policy also disables its queued
requests after restart; it cannot keep allocating devices with a revoked token.

Allocation accepts `runner: appium | maestro` (default `appium`). Every lease
contains `runner` and `connection` with `type`, an exact lease-relative `path` and
either WebDriver capabilities or the allocated Android serial. Relative paths
allow the wrapper to use the same internal or public coordinator base URL without
following redirects or forwarding a credential to a URL supplied by a lease.
The old `webdriverUrl` and capabilities remain available for Appium clients.

Maestro admission does not consume Grid slots or Appium system ports. Its local
worker endpoint exposes one serial through authenticated per-connection WebSockets.
The coordinator rejects global ADB commands and another serial, validates the
provider fence before each connection, and closes streams before release/expiry.
Only the trusted coordinator can reach shared ADB servers; CI jobs cannot.

## Maestro cleanup and recovery

The provider acknowledges a Maestro capture only after taking a settings/package
baseline. It stops the known driver packages, verifies process/instrumentation
exit, removes only newly installed driver APKs and restores tracked settings before
publishing `LeaveGroupMessage` or acknowledging release. This also runs when the
provider fence expires during a coordinator outage. Failure retains device ownership
and the exact lease identity; an expired lease cannot renew but its exact release
can retry cleanup. Old releases cannot affect a new epoch.

The coordinator persists its preparation baseline and confirmed provider release.
An unowned device without a Maestro cleanup acknowledgment is quarantined rather
than assumed clean. Loss of provider memory after a hard worker failure can require
operator recovery; the prototype does not force a questionable device back into
the available pool. This is deliberately conservative and does not claim a
multi-hour or destructive-failure soak test.

1. A worker submits a device request with a unique `Idempotency-Key`.
2. The request waits without holding a device. The scheduler serves the oldest
   matching request; an unavailable model does not block unrelated requests.
3. A ready, visible, unowned STF device and an appropriate free Grid slot must
   both exist. Android also needs a provider-matched remote ADB port.
4. The coordinator persists a lease and captures the phone through STF using
   that lease ID as a fencing token. It returns a gateway URL and authoritative
   connection capabilities.
5. The worker creates one Appium session through that URL and sends independent
   heartbeats while tests run. Appium commands do not renew the worker lease.
6. The worker collects failure artifacts, quits Appium and releases the lease.
   The coordinator verifies session cleanup, performs fenced STF release and
   only then makes the device and port available again.

A worker must use the returned WebDriver gateway, not the public Grid URL. The
gateway binds session creation and commands to the current lease, preventing a
late worker from commanding the next run's session. Requested device, platform,
ADB host or port overrides that conflict with the lease are rejected.
Each forwarded command also verifies current fenced STF ownership. One W3C
capability set is accepted; nested `appium:options` and legacy
`desiredCapabilities` overrides are rejected. The gateway rejects query strings,
encoded path separators and traversal segments rather than forwarding arbitrary
Grid HTTP routes.

### Timeouts

| Setting | Default | Meaning |
|---|---:|---|
| `lease-ttl-seconds` | 180 | Worker lease lifetime, extended by each accepted heartbeat |
| `heartbeat-interval-seconds` | 30 | Recommended heartbeat interval returned to the worker |
| `max-duration-seconds` | 21600 | Absolute lease duration ceiling (six hours) |
| `poll-interval-seconds` | 1 | Scheduling and expiration check interval |
| `upstream-timeout-seconds` | 30 | Individual upstream HTTP request timeout |
| `max-parallel` | 10 | Maximum simultaneous leases; actual device/slot/port availability also limits it |

A heartbeat renews an unexpired lease only up to its absolute deadline. A worker
cannot revive an expired lease. Queue waiting time is controlled separately by
`queueTimeoutSeconds` (default 3600 seconds) and does not consume a phone.
Request queue and duration values are positive integer seconds, at most 86400;
the requested duration must also fit the configured coordinator maximum.
Startup configuration limits lease TTL to 3600 seconds, absolute duration to
86400 seconds and individual upstream timeout to 300 seconds.

For physical-device runs, set `--upstream-timeout-seconds` to 120–180 seconds
when a cold Appium session may install/start UiAutomator2 or establish its iOS
connection. The CLI default remains 30 seconds; it is suitable only when all
required upstream operations complete within that budget. A short coordinator
timeout during session creation produces an uncertain result and quarantine,
even if Appium eventually succeeds. Configure the worker's WebDriver HTTP
timeout to exceed the coordinator's budget; keep heartbeat on a separate
execution thread while session creation or a slow command runs.

STF ownership lasts longer than the worker lease to leave time for cleanup.
The coordinator adds cleanup grace equal to the Appium idle timeout
(120 seconds), twice the upstream timeout and 60 seconds:
`STF ownership TTL = worker lease TTL + 180 + 2 × upstream timeout`, all in
seconds. With the defaults this is 180 + 240 = 420 seconds. An upstream timeout
of 120 seconds gives 420 seconds of grace and 600 seconds of STF ownership;
180 seconds gives 540 seconds of grace and 720 seconds of ownership. This
headroom allows the coordinator to stop a session and verify its release while
the worker lease is already inactive. It does not extend the worker's right to
send commands or its absolute run deadline. Expiry blocks gateway commands immediately;
it does not immediately make a still-running phone available. Cleanup and
quarantine maintain STF ownership while it is still possible to renew it.
Viewer activity is never a worker heartbeat.

Appium's command inactivity timeout is separate. Keep test-side HTTP timeouts,
slow operations and heartbeat execution consistent. A long test can use many
commands over hours; a long period with no commands may still terminate its
Appium session. The prototype gateway controls the Appium idle capability.

Ownership persistence acknowledgements are ordered per device within a processor.
Use one processor for this prototype; distributing ownership transitions across
several processors requires a separate ordering review.

Durable state transitions are serialized, while STF/Grid network calls run
outside that state queue. Allocations and cleanup on separate devices can run
concurrently; heartbeat handling remains independent of a slow capture,
inventory request or Appium command. Commands for one lease remain ordered,
and only one cleanup operation for that lease runs at a time. After network
responses return, the coordinator checks current state again, so a late capture
or renewal cannot undo cancellation, expiry or shutdown.

The prototype still runs one scheduling cycle at a time. A slow upstream call
can delay the next queue/expiry maintenance pass; the WebDriver gateway rejects
expired leases using the clock without waiting for that pass. Heartbeat, API
latency and recovery under sustained load still need measurement before a
multi-hour production run. A short demonstration does not establish that result.

### Queue and lease states

| Entity | State | Meaning |
|---|---|---|
| Request | `queued` | Waiting for matching resources |
| Request | `allocated` | Has a lease ID; fetch that lease |
| Request | `cancelled` | Worker/operator cancelled; a granted lease is cleaned if allocation raced cancellation |
| Request | `expired` | Queue deadline elapsed |
| Request | `failed` | Allocation could not be completed safely |
| Lease | `allocating` | Persisted allocation/capture in progress |
| Lease | `active` | Worker can renew and use its gateway |
| Lease | `cleaning` | Commands blocked; upstream cleanup in progress |
| Lease | `released` | Normal cleanup completed |
| Lease | `expired` | Deadline/heartbeat cleanup completed |
| Lease | `quarantined` | Safe cleanup could not be proved; resources remain held |

On graceful shutdown, allocations stop and active leases are cleaned. On
restart, saved queued requests remain queued, while old live or intermediate
leases are recovered through cleanup before resources are issued again. Sessions
are not resumed. Workers must handle terminal lease errors by ending that
attempt and requesting a new lease with a new request key.

The state file is atomic persistent JSON with restrictive permissions. Its
parent directory must be writable. Keep it across pod replacement; do not run
two processes against one state file or overlapping device/port pools. A missing
or discarded state file must not be used to justify handing out phones from an
interrupted run. Investigate upstream ownership/sessions before a deliberate
state reset. A corrupt state file prevents safe startup.
The loader accepts state v1 and v2. It preserves existing requests and leases,
adds an empty maintenance list when loading v1, and writes v2 from then on.
Version 2 persists device drains across restarts. An older v1-only runtime
rejects this file. Keep the current state and use a reviewed migration for any
rollback; never restore an earlier snapshot over newer lease history.
The prototype retains request/lease history in this file. New requests are
rejected after 10000 saved requests; automatic history retention/compaction is
future work. Reusing an existing idempotency key still reads its original
request. Do not remove history or replace the state file during live leases.

## API

All `/api/v1` routes require authentication. They accept
`Authorization: Bearer <operator or project token>` or HTTP Basic with username
`coordinator` and that credential as password. Basic authentication supports
clients such as Appium Java Client at the WebDriver gateway. Use TLS for
remote access; loopback port-forward is suitable for a local prototype.

Worker credentials are separate from the STF service-account token, which stays
with the coordinator. A project credential can inspect, cancel and command only
its project's requests and leases, subject to that project's concurrency quota.
Foreign request/lease IDs return 404. The operator credential from
`--api-token-file` can inspect every project and recover quarantined leases;
requests submitted with it belong to the `legacy` project. Do not give the
operator credential to CI jobs. Project credentials cannot call recovery (403).

| Method | Route | Result |
|---|---|---|
| GET | `/healthz` | Non-sensitive process health |
| GET | `/readyz` | Non-sensitive readiness; 503 during recovery/shutdown or persistent-state failure |
| GET | `/api/v1/status` | Authenticated coordinator counts/status |
| POST | `/api/v1/requests` | 202 and `{ "request": ... }` |
| GET | `/api/v1/requests/:id` | Current request |
| DELETE | `/api/v1/requests/:id` | 202 cancellation/cleanup request |
| GET | `/api/v1/leases` | `{ "leases": [...] }` |
| GET | `/api/v1/leases/:id` | `{ "lease": ... }` |
| POST | `/api/v1/leases/:id/renew` | Renew with `{}`; returns lease |
| DELETE | `/api/v1/leases/:id` | 202 and lease cleanup state |
| POST | `/api/v1/leases/:id/recover` | Retry cleanup of a quarantined lease with `{}` |
| POST | `/api/v1/maintenance` | Operator-only durable iOS drain with `{serial, operationId}` |
| GET | `/api/v1/maintenance/:id` | Operator-only drain status |
| DELETE | `/api/v1/maintenance/:id` | Operator-only completion after fresh device/signing/Grid checks |
| POST | `/api/v1/leases/:id/webdriver/session` | Create the lease's single W3C session |
| any | `/api/v1/leases/:id/webdriver/session/:sessionId/...` | Forward only that lease's session commands |

Request example (all device identities here are synthetic):

```http
POST /api/v1/requests
Idempotency-Key: settings-demo-worker-1-attempt-1
Content-Type: application/json

{
  "runId": "settings-demo",
  "platform": "Android",
  "model": "Example phone",
  "queueTimeoutSeconds": 600,
  "maxDurationSeconds": 21600
}
```

`platform` is `Android` or `iOS`. `serial`, `model` and `provider` are optional
exact-match filters. `runId` is a diagnostic label, not authorization. The same
idempotency key and payload return the same request; a changed payload returns
409. Retrying an HTTP timeout should reuse the key, avoiding duplicate leases.
An intentional new attempt needs a new key.

A lease response exposes its `id`, `state`, device metadata, ISO UTC `expiresAt`
and `deadlineAt`, recommended `heartbeatIntervalSeconds`, `capabilities` and
`webdriverUrl`. Device IDs are operational information: keep real response
snapshots and logs private. Responses and persistent state do not contain tokens.

Ordinary API errors use `{ "error": { "code": "...", "message": "..." } }`.
Common statuses are 400 (invalid input), 401 (authentication), 404 (unknown
resource), 409 (state/lease conflict) and 429 (request-history limit). WebDriver
errors use the W3C response shape. An HTTP 202 cleanup response is not proof that
the phone is already free: poll until a terminal lease state.
Request bodies are limited to 1MiB. Upstream WebDriver responses are limited to
32MiB. Use a reachable app URL rather than embedding a large app in JSON.

### STF protocol requirements

The coordinator uses ordinary STF API authentication and existing device-group
visibility. Its service-account token needs access to the intended phones; a
new STF user privilege role is unnecessary.

The matching STF build extends capture with `leaseId` and adds:

- `POST /api/v1/user/devices/:serial/automation/renew` with `{leaseId, timeout}`;
- `POST /api/v1/user/devices/:serial/automation/release` with `{leaseId}`.

`timeout` is milliseconds on Android and iOS. Provider acknowledgement verifies
both the owner and exact lease ID. A stale worker under the same STF account
cannot renew or release a newer lease. The included direct Kotlin client also
uses a fresh lease ID and verifies the acknowledged reservation and runtime
channel before cleanup. Legacy endpoints remain available; only coordinator-managed
runs receive the coordinator's queue, port and session lifecycle guarantees. Deploy
matching API, processor, Android device and iOS provider support before using
coordinator reservations.

### Android port pools and direct mode

`--adb-pools-file` contains an array:

```json
[
  {
    "provider": "provider-one",
    "host": "adb-one.stf.svc.cluster.local",
    "port": 5037,
    "systemPorts": [8200, 8201, 8202, 8203]
  }
]
```

The provider value must match STF inventory and the Grid node's provider/ADB
routing. Only list ports reachable through that ADB Service. Distinct leases
on one remote host need distinct `systemPort` values; separate remote hosts
can reuse the same number. Coordinator port reservations survive restart and
are held through cleanup/quarantine.

A direct STF/Appium run is outside this allocator and can use the same ADB
host. During the prototype, use coordinator-only phones/pools or otherwise
ensure direct runs do not overlap its devices and port range. Do not infer
exclusive port ownership from Grid node count. Existing direct-mode Kotlin
smoke tasks remain supported for controlled diagnostics.

## Local start and operator inspection

Build from the repository with its supported Node.js version, then prepare
private files outside the checkout. The examples never print token contents.
The STF account token file is obtained through normal STF account management.
The example below prepares the operator credential for local inspection. For CI,
configure a separate project token in `--project-tokens-file` and give workers
only that project credential.

```sh
node build.mts compile
COORDINATOR_PRIVATE_DIR=$(mktemp -d)
chmod 700 "$COORDINATOR_PRIVATE_DIR"
mkdir -m 700 "$COORDINATOR_PRIVATE_DIR/state"
install -m 600 /secure/stf-account-token "$COORDINATOR_PRIVATE_DIR/stf-token"
openssl rand -hex 32 > "$COORDINATOR_PRIVATE_DIR/api-token"
chmod 600 "$COORDINATOR_PRIVATE_DIR/api-token"
```

Save the actual pool mapping as `adb-pools.json` in that private directory.
Use `[]` only for an iOS-only installation. Start one process:

```sh
stf coordinator \
  --stf-api-url https://stf.example.test/api/v1 \
  --appium-grid-url https://grid.example.test \
  --stf-token-file "$COORDINATOR_PRIVATE_DIR/stf-token" \
  --api-token-file "$COORDINATOR_PRIVATE_DIR/api-token" \
  --adb-pools-file "$COORDINATOR_PRIVATE_DIR/adb-pools.json" \
  --state-file "$COORDINATOR_PRIVATE_DIR/state/coordinator.json" \
  --upstream-timeout-seconds 180
```

The parent state directory must exist and be private/writable; create it before
start. `--host` defaults to `127.0.0.1`, port to `8080`, and public URL to
`http://127.0.0.1:8080`. For a different port also set `--public-url`.
Every CLI option supports the `STF_COORDINATOR_` environment prefix, for example
`STF_COORDINATOR_MAX_PARALLEL=2`. Token settings always name files; there is no
plaintext `--api-token` or `--stf-token` option.

To inspect authenticated APIs without putting tokens in command arguments,
create a private curl configuration from the token file:

```sh
python3 - "$COORDINATOR_PRIVATE_DIR" <<'PY'
import json
import os
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
token = (root / 'api-token').read_text().strip()
config = root / 'curl.conf'
config.write_text('header = ' + json.dumps('Authorization: Bearer ' + token) + '\n')
os.chmod(config, 0o600)
PY
curl --fail-with-body --config "$COORDINATOR_PRIVATE_DIR/curl.conf" \
  http://127.0.0.1:8080/api/v1/status
curl --fail-with-body --config "$COORDINATOR_PRIVATE_DIR/curl.conf" \
  http://127.0.0.1:8080/api/v1/leases
```

Use the request/lease IDs from JSON responses for renew, cancellation and
cleanup inspection. Open the existing STF device page manually to observe its
Automated status and live screen. The coordinator needs no browser automation.

## Farm deployment and rollback

See [kuber/coordinator](../kuber/coordinator/README.md) for the opt-in manifests.
Before applying, review a rendered private overlay with the immutable image,
real pool mapping and worker-reachable public URL. Set explicit kubeconfig and
context for every cluster operation; the shell's default cluster may be unrelated.

This runtime reads v1/v2 state and writes v2. Preserve the existing PVC across
the upgrade. Do not roll back to a v1-only image on that PVC: it cannot load v2
or enforce its maintenance drains. A reverse migration requires stopped
admission, no queued or held work, no drains and a reviewed conversion of the
current state that retains all request/lease history. Keep rollback experiments
isolated from the farm PVC.

1. Deploy and verify the matching fenced STF API/processor/providers. Save the
   prior immutable images and resource configuration for rollback.
2. Create namespace `stf` if it does not already exist, and create
   `stf-coordinator-credentials` from private files with keys `stf-token` and
   `api-token`. Do not commit the Secret or generated manifests containing it.
3. Apply the reviewed overlay; verify the PVC is bound, exactly one coordinator
   pod runs, and `/readyz` succeeds. The Deployment uses `Recreate`, UID/GID1000,
   an `fsGroup` writable state volume and read-only credential/config mounts.
   Kubernetes service-link environment injection is disabled: variables such as
   `STF_COORDINATOR_SERVICE_HOST` would otherwise collide with the strict
   `STF_COORDINATOR_` CLI configuration prefix.
   For cold physical-device Appium sessions, override the manifest's upstream
   timeout from 30 to 120–180 seconds and review the worker HTTP timeout and
   shutdown grace together. A forced shutdown preserves uncertain state for
   recovery rather than declaring the device free.
4. For a local demo, set public URL to `http://127.0.0.1:18080` before allocation
   and port-forward `18080:8080`. For cluster workers use the Service DNS URL.
   There is no public Ingress or DNS requirement in the prototype.
5. Start small: free diagnostic Android/iOS devices, short Settings scenarios,
   then queue, heartbeat expiry, cancellation and restart recovery exercises.
   Confirm session count, STF ownership and port cleanup after each exercise.
6. To stop, stop submitting requests, cancel queued requests and release active
   leases. Poll cleanup completion. Investigate any quarantined leases and use
   their recover endpoint only when retrying cleanup is appropriate.
7. After cleanup, scale `stf-coordinator` to zero. Preserve the PVC and private
   state snapshot. If rolling back protocol/provider images, first verify no
   coordinator sessions or reservations remain, then restore the saved images.
   Delete the temporary credentials only after they are no longer needed.

Do not delete the PVC as a normal restart or rollback step. Do not release STF
ownership manually to bypass uncertain Appium cleanup. Quarantine is an operator
signal to inspect upstream sessions/device state and retry recovery; it is not
an invitation to reset state and issue the phone again.

The default NetworkPolicy permits API clients in namespace `stf` or namespaces
labelled `stf-coordinator-access=allowed`. Egress permits cluster DNS, STF API
TCP3000 and Grid router TCP4444. No direct ADB connection is needed from the
coordinator. Adapt these exact selectors if upstream URLs or cluster DNS differ.

## Checking the prototype

Use the supported Node.js version, JDK 17 or later, and `kubectl` with Kustomize.
Run the device-free server, worker-client and shared WDA regressions:

```sh
npm test
(cd kuber/appium-tests && ./gradlew test --console=plain)
node --test kuber/appium-tests/ios-node/*.test.mjs
kubectl kustomize kuber/coordinator
```

For hardware checks, start the coordinator with private credentials, an isolated
state file and an explicit device/port pool. Run the opt-in Kotlin coordinator
Settings tasks described in the [worker guide](../kuber/appium-tests/README.md#coordinator-prototype).
Check allocation, queue waiting, independent heartbeats, cancellation and
recovery; verify terminal leases, Grid session removal, STF ownership release
and port reuse after each run. Test stale renew/release requests against a
replacement lease as well.

Fixture checks and short Settings runs do not establish multi-hour reliability,
large-queue throughput or fairness under sustained contention. Record those
measurements separately. Keep response snapshots, real device identifiers,
credentials and detailed logs in private operator storage.
