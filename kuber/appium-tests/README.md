# STF Appium tests

Kotlin/JVM smoke tests using Appium Java Client 10, JUnit 5 and Gradle.
Use JDK 17 or later. The wrapper and Kotlin plugin versions are pinned.
Device tests are opt-in: `./gradlew test` runs only device-free regression tests.

## Farm Android smoke

Generate a personal STF API access token, supply it through the environment,
and use the canonical public Grid endpoint:

```sh
cd kuber/appium-tests
export STF_BASE_URL=https://stf.finservice.tech
export APPIUM_SERVER_URL=https://appium-grid.finservice.tech
# Supply STF_TOKEN through your shell or CI secret store.
./gradlew stfAppiumSettingsTest
```

This reserves one free Android device, opens Settings, reads native elements,
takes a screenshot, quits Appium and then releases the STF reservation. The
release path runs after failures as well. The first smoke deliberately uses
Settings so Chrome setup and external websites do not affect the result.

The tests use the standard STF endpoints:

1. `GET /api/v1/devices` to select a ready, present, unowned device of the requested platform.
2. `POST /api/v1/user/devices` with `serial` and an idle `timeout` in milliseconds.
3. Appium session with the selected serial as `appium:udid`.
4. Appium `quit`, followed by `DELETE /api/v1/user/devices/{serial}`.
5. `GET /api/v1/user/devices` to verify that ownership was released.

The historical `/api/v1/autotests` allocation API is not used. Each smoke owns
one phone; legacy `STF_AMOUNT`, `STF_NEED_AMOUNT` and group/run settings were
removed. Existing reservations are never borrowed. Use a separate STF test
account when CI must not share the operator's reservations.

## Tasks

| Task | Purpose |
| --- | --- |
| `test` | Device-free configuration, allocation and cleanup regression tests |
| `stfAndroidTest` | Reserve/release one Android device, without Appium |
| `stfAppiumSettingsTest` | Android Settings through STF and Grid |
| `stfAppiumAndroidTest` | Android Chrome browser smoke through STF and Grid |
| `stfAppiumIosSettingsTest` | iOS Settings through STF and an XCUITest node |
| `stfAppiumIosDemo` | Slow iOS Settings swipes for viewing in STF |
| `stfAppiumAndroidDemo` | Slow Android Settings swipes for viewing in STF |
| `coordinatorAndroidTest` | Android Settings through coordinator allocation and WebDriver gateway |
| `coordinatorIosTest` | iOS Settings through coordinator allocation and WebDriver gateway |
| `coordinatorAndroidDemo` / `coordinatorIosDemo` | Observable Settings swipes through coordinator |
| `localAndroidTest` | Android Settings on an explicit `ANDROID_UDID` |
| `localIosTest` | iOS Settings on an explicit `IOS_UDID` and `IOS_PLATFORM_VERSION` |

Missing credentials, matching devices or platform nodes fail explicit smoke
tasks. In particular, an absent iOS Grid node is a failure, not a skipped test.
The `localAndroidTest` task now opens Settings rather than Chrome.

## Device selection and timeouts

| Variable | Default / meaning |
| --- | --- |
| `STF_BASE_URL` | Required for farm tasks; root URL or `/api/v1`, optional trailing slash |
| `STF_TOKEN` | Required for farm tasks; never committed or printed |
| `STF_SERIAL` | Optional exact device identifier; iOS otherwise selects from UP Grid relay UDIDs |
| `STF_MODEL` | Exact Android model filter |
| `STF_IOS_MODEL` | Exact iOS model filter; no historical named-iPhone default |
| `STF_PROVIDER` | Exact provider filter |
| `STF_CAPTURE_WAIT_SECONDS` | `30`; bounded wait for a matching device |
| `STF_TIMEOUT_SECONDS` | `600`; STF idle reservation timeout, converted to milliseconds |
| `APPIUM_SERVER_URL` | `http://127.0.0.1:4723`; explicitly set the public Grid for farm runs |
| `APPIUM_WAIT_SECONDS` | `30`; UI condition wait |
| `TEST_ARTIFACTS_DIR` | `build/appium-artifacts` |

A reservation conflict tries another candidate. Authentication/server errors
fail immediately. These are allocation retries, not retries of failed UI tests.
Keep direct STF smoke tests within their idle reservation timeout. The optional
coordinator mode below renews ownership throughout longer runs.

## Android routing and parallel execution

The captured provider selects the matching ADB pool:

- `stf-provider` → `adbd.stf.svc.cluster.local:5037`
- `stf-provider-2` → `adbd-2.stf.svc.cluster.local:5037`

`APPIUM_REMOTE_ADB_HOST` and `APPIUM_ADB_PORT` override this for diagnostics.
Unknown provider names fail rather than silently choosing the wrong ADB server.

`APPIUM_SYSTEM_PORT` defaults to `8200`. Sequential runs can reuse it. Concurrent
runs on the same ADB server must set different ports from its exposed
`8200-8209` range. Grid node count alone does not reserve system ports. These
direct smoke tasks use one Gradle fork and do not schedule a parallel device matrix.
Coordinator mode obtains an authoritative port from the service instead.

For browser smoke, optional `TEST_TARGET_URL` defaults to `https://example.com`
and `TEST_EXPECTED_TITLE` to `Example`. `ANDROID_BROWSER_NAME` defaults to
`Chrome`. Browser availability, system overlays and compatible Chromedriver
remain additional prerequisites beyond Settings smoke.

## iOS

The selected phone's STF version supplies `appium:platformVersion`.
`IOS_PLATFORM_VERSION` overrides it; `IOS_BUNDLE_ID` defaults to
`com.apple.Preferences`. The test explicitly activates the app through WDA and
checks its bundle identifier, native hierarchy and screenshot.

A Linux node can use XCUITest's externally managed WDA mode. A Mac is still
needed to build/sign WDA; it does not need to run these sessions. See the
[official non-macOS guide](https://appium.github.io/appium-xcuitest-driver/12.18/guides/non-macos-hosts/).
The existing STF runtime owns one WDA session. Connecting an ordinary second
WDA client directly would replace it, so the prepared [iOS node trial](ios-node/README.md)
uses a loopback session adapter. It preserves the STF session and restores its
settings on Appium teardown. All three preview iPhones have dedicated Grid relays
and Appium sidecars. The Grid has seven Android nodes (four in pool 1, three in
pool 2) and three iOS nodes; each iOS relay is bound to one physical phone.

`IOS_WDA_URL` is an advanced override resolved by the Appium server, not by the
test machine. Omit it for the prepared sidecar, which has its own loopback default.
Do not point it directly to the STF runtime's WDA on a shared phone.

## Reports and evidence

To watch the test in the STF UI, sign in as the account that owns `STF_TOKEN`.
The phone screen streams during the test and closes when ownership is released.
For an observable demo, leave the device list open and run:

```sh
./gradlew stfAppiumIosDemo
# Or Android:
./gradlew stfAppiumAndroidDemo
```

Use the same STF URL, token and public Grid endpoint as the Settings smoke.
Optionally pin `STF_SERIAL` to the phone you want to watch. Once the test reserves
it, open that phone's control page in STF. The demo opens Settings and alternates
up/down swipes with four-second pauses for eight cycles (about one minute).
`STF_DEMO_CYCLES` accepts 1–20 cycles. Avoid manual input during the demo; it
shares the screen and WDA session with STF. Appium quits and ownership is released
on completion or failure. The demo is opt-in and excluded from `test`/CI.

Gradle writes JUnit XML under `build/test-results/<task>` and HTML under
`build/reports/tests/<task>/index.html`. On failure, page source and screenshot
are collected independently before Appium quit. Cleanup errors are attached to
the original failure; they do not hide it. No automatic UI-test retry is used.

The [2026-10-18 validation record](../docs/appium-validation-2026-10-18.md)
records real-device runs, fleet size, concurrent screen evidence and remaining work.

## Coordinator prototype

`COORDINATOR_URL` switches farm tests to the `stf coordinator` allocation API.
A coordinator credential replaces the personal STF token in this mode. The
runner does not call STF or query Grid directly. Explicit `coordinator*` tasks
fail if coordinator configuration is absent, so there is no silent direct-mode
fallback.

```sh
export COORDINATOR_URL=https://coordinator.example.com
# Supply COORDINATOR_TOKEN through your shell or CI secret store.
export COORDINATOR_RUN_ID=build-123
./gradlew coordinatorAndroidTest
./gradlew coordinatorIosTest
```

The existing `STF_SERIAL`, `STF_MODEL`, `STF_IOS_MODEL` and `STF_PROVIDER` filters
are sent to the coordinator. It queues requests, reserves devices and assigns
ADB ports. Returned capabilities override local connection settings such as
`APPIUM_SYSTEM_PORT`, remote ADB and iOS WDA/OS overrides. Application-specific
settings remain in the runner. The returned WebDriver gateway must have the same
origin and API prefix as `COORDINATOR_URL`; tokens are never put in endpoint URLs.

The client creates an idempotent request, polls allocation, starts heartbeat
renewals, then creates Appium through the lease-specific gateway. Heartbeats
continue during commands and `driver.quit()`. After quit, the client stops
renewing, releases the lease and polls until cleanup has completed. A failed
heartbeat blocks subsequent commands and fails the test; quit/release are still
attempted. A quarantined device or unfinished cleanup also fails the task.
A queue timeout cancels its request, including an allocation that raced with
cancellation. Server expiry covers abrupt worker termination.

| Variable | Default / meaning |
| --- | --- |
| `COORDINATOR_URL` | Coordinator root URL or `/api/v1`; enables coordinator mode |
| `COORDINATOR_TOKEN` | Required coordinator secret; sent in Authorization headers |
| `COORDINATOR_RUN_ID` | Generated local identifier; use the CI run identifier in pipelines |
| `COORDINATOR_QUEUE_TIMEOUT_SECONDS` | `300`; maximum wait for allocation |
| `COORDINATOR_MAX_DURATION_SECONDS` | `21600` (6 hours); request maximum duration, subject to server policy |
| `COORDINATOR_CLEANUP_TIMEOUT_SECONDS` | `90`; wait for confirmed cleanup |
| `APPIUM_NEW_COMMAND_TIMEOUT_SECONDS` | `120`; direct-mode gap between commands; coordinator supplies its authoritative value |
| `APPIUM_READ_TIMEOUT_SECONDS` | `240`; coordinator WebDriver HTTP request timeout |

A healthy worker can renew for hours, up to the request deadline. The server
controls heartbeat frequency and lease TTL. Heartbeats do not keep an idle
Appium session alive. In coordinator mode the new-command timeout is controlled
by the service (currently 120 seconds); a local environment override cannot
change it. A legitimate longer pause needs a corresponding coordinator policy
change. Our Settings smoke/demo scenarios remain intentionally short.

### Independent parallel workers

The launcher starts separate Gradle/JVM processes with isolated build/cache,
JUnit reports, logs and failure artifacts on Linux/macOS. Interrupting the
launcher terminates each worker process group; server lease expiry handles
workers unable to finish cleanup:

```sh
python3 run-coordinator-workers.py --android-workers 2 --ios-workers 1 --run-id build-123
# For watching simultaneous swipes in STF:
python3 run-coordinator-workers.py --android-workers 2 --ios-workers 1 --demo
# Inspect the worker plan without contacting any service:
python3 run-coordinator-workers.py --android-workers 2 --ios-workers 1 --dry-run
```

Workers request the same run ID but independent requests and leases. Excess
workers wait for suitable phones; they do not borrow each other's sessions.
Use `--android-tests` or `--ios-tests` for JUnit `--tests` filters within the task's
platform tag. This prototype repeats the selected Settings scenario per worker;
it does not automatically shard a larger application suite. CI can instead
launch independent jobs and shard application test classes itself.
The `appiumWorkerId` Gradle property isolates output directories for externally
launched workers too. Ordinary single-process tasks keep their existing report
paths. Coordinator and direct STF runs must not compete independently for the
same phones in a production pipeline.
