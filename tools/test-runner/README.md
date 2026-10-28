# STF CI test runner

This standalone package runs an arbitrary repository command with exactly one
STF coordinator lease. It supports Appium on Android/iOS and Maestro on physical
Android. Test source, builds and reports remain in the application's CI project.
The coordinator owns device allocation, global concurrency and cleanup.

The package installs its own `stf` executable with `stf utils test run`; the STF
server executable does not provide this namespace. Node.js 22.18 or newer is
required. There is no public npm release; CI images should pin the source and
image digest.

## Build the client

From this directory in a fresh checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node stf.mjs utils test run --help
```

The last command lists the client options without contacting a farm. The build
converts TypeScript to plain `.mjs` using Node's built-in stripper; no STF or
TypeScript compiler dependency is required. `npm pack` builds a standalone
JavaScript package. Installed packages run plain JavaScript.

To configure a farm, see the [coordinator guide](../../doc/coordinator.md) and
[worker deployment guide](../../doc/ci-runners.md).

## CI commands

Provide `FARM_URL` and a project-scoped `FARM_TOKEN_FILE` (private regular file,
owned by the worker user; mode 0600 or 0400). `FARM_TOKEN` is supported for CI secret
variables. Each repository should have its own project identity and quota; keep
the coordinator operator credential out of job variables. Never pass a token as
a CLI argument. `COORDINATOR_URL`,
`COORDINATOR_TOKEN_FILE` and `COORDINATOR_TOKEN` are compatibility aliases.

```sh
stf utils test run --runner appium --platform Android \
  --run-id "android-${CI_JOB_ID}" -- ./gradlew test

stf utils test run --runner appium --platform iOS \
  --run-id "ios-${CI_JOB_ID}" -- ./gradlew test

stf utils test run --runner maestro --platform Android \
  --run-id "maestro-${CI_JOB_ID}" -- ./ci/maestro-test.sh
```

The separator `--` is required. The child command executes directly, with its
arguments preserved and no implicit shell. Put shell variable expansion or
multiple commands in a repository script. Device filters are `--serial`,
`--model`, and `--provider`. `--queue-timeout`, `--max-duration`, and
`--cleanup-timeout` accept seconds; defaults are 3600, 21600 and 120 respectively.
The coordinator enforces its own duration, runner and project limits.

Use one ephemeral pod per worker, with no host networking and no shared process
namespace. The job needs network access only to the coordinator and approved
artifact/dependency services. It does not need Kubernetes credentials, provider
access, an STF token, or the farm's generic ADB port. Keep the coordinator's
HTTP listener on the private cluster network; use verified HTTPS for an external
endpoint. `--ca-file` adds a private CA without disabling certificate checks.

## One connection contract

The child receives `STF_CONNECTION_FILE`: an absolute path to a temporary JSON
file with mode 0600. Its schema is versioned:

```json
{
  "version": 1,
  "runner": "appium",
  "leaseId": "lease-generation",
  "device": {
    "serial": "PHONE_SERIAL",
    "platform": "Android",
    "model": "SM-A556E",
    "version": "16",
    "provider": "stf-provider"
  },
  "appium": {
    "url": "http://127.0.0.1:12345",
    "capabilities": {
      "platformName": "Android",
      "appium:udid": "PHONE_SERIAL",
      "appium:automationName": "UiAutomator2"
    }
  }
}
```

Maestro uses `"runner":"maestro"` and replaces `appium` with:

```json
{"maestro":{"host":"127.0.0.1","port":5037,"deviceId":"PHONE_SERIAL"}}
```

The real Appium capability object also contains coordinator-assigned connection
settings, including Android ports where applicable. Preserve those values and
add only application/test options. The server rejects conflicting capabilities.
Connect to `appium.url` using the ordinary Appium client for your language. The
loopback proxy authenticates requests to this lease. It does not support direct
Grid URLs or Appium direct-connect discovery. Disable direct-connect features in
clients that provide them. `APPIUM_SERVER_URL` and `APPIUM_CAPABILITIES_JSON` carry
the same values as convenient environment variables.

The current physical iOS nodes attach to an existing WDA on Linux. Preserve
`appium:autoLaunch:false` and omit `appium:bundleId`/`appium:app` from the new-session
capabilities: those trigger host-side USB app discovery. Activate the installed
application through the Appium client after session creation. Installing or
upgrading an iOS application is outside this connection prototype.

Maestro's `ci/maestro-test.sh` can be:

```sh
#!/bin/sh
set -eu
mkdir -p artifacts
exec maestro --host 127.0.0.1 --device "$MAESTRO_DEVICE_ID" test \
  --format junit --output artifacts/maestro.xml flows/
```

The wrapper exports `MAESTRO_DEVICE_ID`, `ANDROID_SERIAL`, and
`ADB_SERVER_SOCKET=tcp:127.0.0.1:5037`. Every smart-socket client is forwarded over
its own authenticated WebSocket, bound server-side to this lease and phone. The
wrapper never starts, kills or resets an SDK ADB daemon. If loopback 5037 is
occupied, it fails clearly and leaves the existing process untouched. Do not run
`adb start-server`, `adb kill-server`, or `adb connect` inside this job. Always
pass the allocated serial to Maestro/ADB. Maestro's `--port` is a direct adbd
setting, not the smart-socket server port, so it is omitted.

`STF_DEVICE_SERIAL` and `STF_RUNNER` are also exported. Coordinator/STF credentials
and acquisition environment variables are removed from the child environment;
the connection file contains no token. This is credential hygiene, not isolation
between mutually untrusted processes running as the same pod user. Project
tokens and worker pods must be scoped accordingly. Existing test helpers must
use attachment mode when `STF_CONNECTION_FILE` exists and must not acquire a
second phone. The wrapper removes the connection file after the child stops.

## Ownership, cancellation and results

Allocation uses a stable idempotency key across creation retries. The wrapper
cancels queued requests on timeout or interruption, including an allocation that
wins the cancellation race. While the repository command runs, it renews the
lease and observes both the expiry and absolute deadline. A failed heartbeat
stops the command; it cannot turn into a successful test result.

On Linux/macOS, the command runs in its own process group. `SIGINT`/`SIGTERM`, a
lost heartbeat or transport failure stops that group, first with `SIGTERM` and
then with `SIGKILL` after three seconds. Remaining descendants are also killed
when their immediate command exits. The wrapper then closes local transports,
asks the coordinator to clean the device and waits for confirmed completion.
Quarantine or an unconfirmed cleanup fails the job; it never marks a phone free
locally. `SIGKILL`/node loss are recovered by the coordinator's lease expiry.
The worker pod must have enough termination grace for cleanup (default 120
seconds plus request timeouts). Windows process-tree cancellation is not part of
this Linux CI prototype.

A test command's nonzero exit code is retained after successful cleanup.
Interrupted wrapper exits use 130/143. Infrastructure/cleanup failures exit 1.
Reports, screenshots and videos should be written by the repository command to
its normal CI artifact directory. STF's Automated viewer remains independent.

## Local verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm pack --dry-run
```

For an additional repository type check, install the root development dependencies
and run `../../node_modules/.bin/tsc -p tsconfig.json --noEmit`.

The installed-package regression uses local dependency archives and an empty
npm cache, so it does not depend on pre-warmed registry metadata.

Tests use isolated loopback fake APIs and transports. They cover ordinary Appium
requests, binary/multiple Maestro connections, occupied-port protection,
credential removal, private files, redirect/path rejection, queue and signal
races, child/descendant cancellation, heartbeat failures, quarantine and package
contents. They never connect to a real phone or the workstation's ADB daemon.
