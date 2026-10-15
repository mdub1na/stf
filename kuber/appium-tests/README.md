# STF Appium Tests

Java smoke tests for Android and iOS devices through local Appium or STF Appium Grid.

The remote STF instructions below are historical. The current farm runs
STF at <https://stf.finservice.tech> and does not implement `/api/v1/autotests`.
These remote tests need API adaptation; replacing the hostname alone is not
sufficient. Local Appium tests and the Grid endpoint are unchanged.

## Requirements

- JDK 17+
- Gradle Wrapper is included (`./gradlew`)
- Android platform tools (`adb`)
- Appium 3 with the UiAutomator2 driver
- Chrome installed on the Android device
- For iOS: macOS Appium node with Xcode, WebDriverAgent signing, and the XCUITest driver

## Local Run

Check that the device is visible and authorized:

```bash
adb devices -l
```

Expected state is `device`. If the state is `unauthorized`, unlock the phone and allow USB debugging.

Start Appium:

```bash
appium --use-drivers uiautomator2 --allow-insecure uiautomator2:chromedriver_autodownload
```

The `chromedriver_autodownload` feature lets Appium download a Chromedriver version compatible with Chrome on the Android device.

Run the smoke test:

```bash
cd kuber/appium-tests
APPIUM_SERVER_URL=http://127.0.0.1:4723 \
ANDROID_UDID=<adb-device-serial> \
./gradlew localAndroidTest
```

The `localAndroidTest` task always executes tests, even if Gradle thinks the task is up to date.

Optional variables:

- `ANDROID_DEVICE_NAME` defaults to `Android`
- `ANDROID_BROWSER_NAME` defaults to `Chrome`
- `TEST_TARGET_URL` defaults to `https://example.com`
- `TEST_ARTIFACTS_DIR` defaults to `target/appium-artifacts`

Failure artifacts are saved under `target/appium-artifacts`.

## STF Capture Smoke

This smoke test checks only the STF autotests API lifecycle:

1. Capture one Android device.
2. Print captured device data.
3. Free the captured group in `finally`.

It does not start an Appium session yet.

```bash
cd kuber/appium-tests
STF_BASE_URL=https://<stf-host> \
STF_TOKEN=<access-token> \
./gradlew stfAndroidTest
```

`STF_BASE_URL` can be either the root STF URL or the `/api/v1` URL.

Optional STF variables:

- `STF_AMOUNT` defaults to `1`
- `STF_TIMEOUT_SECONDS` defaults to `600`
- `STF_NEED_AMOUNT` defaults to `true`
- `STF_RUN_NAME` defaults to a generated smoke run name
- `STF_DEVICE_TYPE` defaults to empty because current STF installations may use different internal platform field names
- `STF_ABI`, `STF_MODEL`, `STF_SDK`, `STF_VERSION` default to empty filters

## STF Appium Smoke

This smoke test captures one STF device, uses its `serial` as Appium `udid`, runs the Chrome smoke through Appium, and frees the STF group in `finally`.

```bash
cd kuber/appium-tests
STF_BASE_URL=https://<stf-host> \
STF_TOKEN=<access-token> \
APPIUM_SERVER_URL=https://<appium-grid-host> \
./gradlew stfAppiumAndroidTest
```

When running through the multi-provider Appium Grid, do not pass `APPIUM_REMOTE_ADB_HOST` by default. STF tests read the captured device provider and automatically map it to the matching ADB server (`stf-provider` -> `adbd`, `stf-provider-2` -> `adbd-2`).

For diagnostics or when pinning a run to one ADB pair, pass remote ADB capabilities explicitly:

```bash
APPIUM_REMOTE_ADB_HOST=adbd.stf.svc.cluster.local
APPIUM_ADB_PORT=5037
```

## STF Settings Smoke

This smoke test captures one STF device, opens Android Settings through Appium, checks that page source is available, and frees the STF group in `finally`.

```bash
cd kuber/appium-tests
STF_BASE_URL=https://<stf-host> \
STF_TOKEN=<access-token> \
STF_MODEL=SM-A556E \
APPIUM_SERVER_URL=https://<appium-grid-host> \
./gradlew stfAppiumSettingsTest
```

Use a `STF_MODEL` value that is available in STF. To check what a specific ADB pair sees:

```bash
adb -H adbd.stf.svc.cluster.local -P 5037 devices -l
adb -H adbd-2.stf.svc.cluster.local -P 5037 devices -l
```

For diagnostics against a single Appium node, forward the node locally and switch `APPIUM_SERVER_URL` to the forwarded port:

```bash
kubectl -n appium port-forward pod/<android-appium-node-pod> 4734:4733
APPIUM_SERVER_URL=http://127.0.0.1:4734
```

## STF iOS Settings Smoke

This smoke test captures one iOS STF device, opens iOS Settings through Appium/XCUITest, checks that page source is available, and frees the STF group in `finally`.

The current STF iOS devices use `platform=iOS`, while the autotests API can capture them reliably by model. The default iOS model filter is `iPhone (Альфа)` and can be overridden with `STF_IOS_MODEL` or `STF_MODEL`.

```bash
cd kuber/appium-tests
STF_BASE_URL=https://<stf-host> \
STF_TOKEN=<access-token> \
APPIUM_SERVER_URL=https://<appium-grid-host> \
./gradlew stfAppiumIosSettingsTest
```

Optional iOS variables:

- `STF_IOS_MODEL` defaults to `iPhone (Альфа)`
- `IOS_DEVICE_NAME` defaults to `iPhone`
- `IOS_BUNDLE_ID` defaults to `com.apple.Preferences`
- `IOS_PLATFORM_VERSION` defaults to empty

The public Appium Grid must have at least one iOS/XCUITest node registered. A Linux Kubernetes Appium pod is not enough for iOS because XCUITest requires macOS, Xcode, and WebDriverAgent signing.

## External Repository Handoff

Use this section as the handoff guide for adding STF Appium tests to another repository.

### Goal

Run autotests from another repository on STF devices through the public Appium Grid.

### Recommended Stack

- Java
- Gradle
- JUnit 5
- Appium Java Client
- Selenium/Appium Grid endpoint

### Launch Flow

Before starting an Appium session, the test must capture a device in STF:

```text
GET https://stf.putmyhexon.ru/api/v1/autotests?amount=1&timeout=600&need_amount=true&run=<run-name>
```

Take these values from the response:

- `group.id`
- `group.devices[0].serial`
- `group.devices[0].provider`

Pass the device serial to Appium as `udid`:

```text
appium:udid=<serial from STF>
```

Use the captured device provider to select the matching ADB pair:

```text
stf-provider   -> adbd.stf.svc.cluster.local
stf-provider-2 -> adbd-2.stf.svc.cluster.local
```

After the test finishes, always release the captured group:

```text
DELETE https://stf.putmyhexon.ru/api/v1/autotests?group=<group.id>
```

Release should be done in `finally`, `afterEach`, or `@After` so the device is freed even when the test fails.

### Appium Endpoint

```text
https://appium-grid.putmyhexon.ru
```

### Minimum Android Capabilities

```text
platformName=Android
appium:automationName=UiAutomator2
appium:deviceName=Android
appium:udid=<serial from STF>
appium:remoteAdbHost=<ADB host selected from captured device provider>
appium:adbPort=5037
appium:noReset=true
appium:newCommandTimeout=120
```

### Recommended First Test

Start from a Settings smoke test. It only opens the system Settings app on the phone and verifies the base chain:

```text
STF capture -> Appium Grid -> Android device -> Settings opened
```

Capabilities for Settings smoke:

```text
appium:appPackage=com.android.settings
appium:appActivity=.Settings
```

Launch command:

```bash
STF_BASE_URL=https://stf.putmyhexon.ru \
STF_TOKEN='<token>' \
APPIUM_SERVER_URL=https://appium-grid.putmyhexon.ru \
./gradlew <test-task>
```

Do not pass `APPIUM_REMOTE_ADB_HOST` by default when running through the shared Appium Grid. STF tests should read the captured device provider and automatically map it to the matching ADB pair:

- `android-appium-node-1` -> `adbd.stf.svc.cluster.local`
- `android-appium-node-2` -> `adbd-2.stf.svc.cluster.local`

Use `APPIUM_REMOTE_ADB_HOST` only for diagnostics or when intentionally pinning a run to one ADB pair.

By default, run without selecting a device model. If temporary model filtering is needed, add:

```bash
STF_MODEL=SM-A556E
```

### Parallel Android Runs

For parallel Appium runs, each Android session must use a unique UiAutomator2 `systemPort`.

Examples:

```text
test 1: APPIUM_SYSTEM_PORT=8200
test 2: APPIUM_SYSTEM_PORT=8201
test 3: APPIUM_SYSTEM_PORT=8202
test 4: APPIUM_SYSTEM_PORT=8203
```

UiAutomator2 uses `systemPort` for communication with the device. If two sessions use the same port on the same ADB pair, they can conflict.

### Infrastructure Expectations

- Appium Grid is available at the public endpoint.
- STF sees Android devices and can capture/release them through the autotests API.
- Appium Grid has Android nodes connected to both ADB pairs:
  - `android-appium-node-1` -> `adbd.stf.svc.cluster.local`
  - `android-appium-node-2` -> `adbd-2.stf.svc.cluster.local`
- For four parallel Android sessions, there must be four free devices and enough Appium node capacity.
- For iOS sessions, Appium Grid must also have a macOS XCUITest node with access to the iOS devices and a working WebDriverAgent signing setup.

### What Not To Use As The First Test

Do not start a new repository from a Chrome browser smoke test. Browser sessions reached Chromedriver, but on Samsung devices a system update confirmation window could appear over Chrome and cause `chrome not reachable`.

Start from Settings smoke first. After it is stable, move to APK installation, application tests, or browser tests.
