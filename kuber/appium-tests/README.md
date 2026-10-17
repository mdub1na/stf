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
| `STF_SERIAL` | Exact device identifier; otherwise select a free matching phone |
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
Keep each smoke within its idle reservation timeout; long suites need a
coordinator that manages lease duration and ownership.

## Android routing and parallel execution

The captured provider selects the matching ADB pool:

- `stf-provider` → `adbd.stf.svc.cluster.local:5037`
- `stf-provider-2` → `adbd-2.stf.svc.cluster.local:5037`

`APPIUM_REMOTE_ADB_HOST` and `APPIUM_ADB_PORT` override this for diagnostics.
Unknown provider names fail rather than silently choosing the wrong ADB server.

`APPIUM_SYSTEM_PORT` defaults to `8200`. Sequential runs can reuse it. Concurrent
runs on the same ADB server must set different ports from its exposed
`8200-8209` range. Grid node count alone does not reserve system ports. These
smoke tasks use one Gradle fork and do not schedule a parallel device matrix.

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
settings on Appium teardown. This adapter's hardware integration is pending;
no iOS Grid node has been registered by this change yet.

`IOS_WDA_URL` is an advanced override resolved by the Appium server, not by the
test machine. Omit it for the prepared sidecar, which has its own loopback default.
Do not point it directly to the STF runtime's WDA on a shared phone.

## Reports and evidence

Gradle writes JUnit XML under `build/test-results/<task>` and HTML under
`build/reports/tests/<task>/index.html`. On failure, page source and screenshot
are collected independently before Appium quit. Cleanup errors are attached to
the original failure; they do not hide it. No automatic UI-test retry is used.

The [2026-10-18 validation record](../docs/appium-validation-2026-10-18.md)
separates real-device results from the remaining iOS work.
