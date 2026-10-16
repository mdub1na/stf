# Linux iOS provider in STF

The provider registers an iPhone in the existing STF device list and uses STF
ownership, groups and transactions for browser control. A Mac is used to build
and sign WebDriverAgent (WDA) and test apps; it is not a runtime node.

## Processes and source

The single-device Kubernetes deployment has three containers on the Linux USB
worker. See [deployment.yaml](../kuber/ios-prototype/deployment.yaml) and the
[STF sidecar patch](../kuber/ios-prototype/stf-integration.yaml).

| Container | Responsibility | Source |
| --- | --- | --- |
| `tunnel` | Privileged go-ios kernel tunnel and persistent pairing | Kubernetes deployment |
| `prototype` | Local API, selected UDID, developer image mounting, WDA startup, reconnects, IPA jobs | `tools/ios-prototype/main.mts`, `runtime.mts`, `server.mts`, `installations.mts` |
| `stf-provider` | Device registration, ownership, ZeroMQ commands, authenticated screen WebSocket | `lib/cli/ios-provider/index.ts`, `lib/units/ios-provider/{index,bridge,client,access,screen,mjpeg}.ts` |

The host owns `usbmuxd`; the Pod mounts only its socket at `/run/usbmuxd`.
Only the tunnel container is privileged. The other two run as UID 1000.
Liveness probes detect a stale USB socket mount after unplugging so Kubernetes
can remount the socket. Pairing, developer image cache and job records live on
the private PVC. The API token comes from a Kubernetes Secret.

The prototype listens on loopback port 7400; WDA and MJPEG forwards use 18100
and 19100, and the tunnel registry uses 28100. The public screen endpoint is
the STF-authenticated WebSocket on 17440. Raw WDA and the prototype API are not
public ingress endpoints. Each WDA recovery changes a generation; each API
process has a new instance UUID. Commands from the previous session are dropped.

## Launch

The prototype entry point needs no npm dependencies:

```sh
node tools/ios-prototype/main.mts \
  --udid YOUR_UDID \
  --wda-bundle-id YOUR_SIGNED_RUNNER.xctrunner \
  --image-mounter pymobiledevice3 \
  --token-file /token/token \
  --storage-url http://stf-storage-temp.stf.svc.cluster.local:3000
```

Required values are the selected UDID, the installed signed WDA runner ID and
a token file (or `STF_IOS_PROTOTYPE_TOKEN`). `--install-dir` defaults to
`~/.stf-ios-installations`. IPA installation is disabled without `--storage-url`.
Other ports, tool paths and doctor options are in [the prototype guide](ios-prototype.md).

The STF bridge is started separately:

```sh
node lib/cli/index.js ios-provider \
  --serial YOUR_UDID --token-file /token/token \
  --prototype-url http://127.0.0.1:7400 \
  --api-url http://stf-api.stf.svc.cluster.local:3000 \
  --public-origin https://YOUR_STF_HOST \
  --storage-url http://stf-storage-temp.stf.svc.cluster.local:3000 \
  --screen-url wss://YOUR_STF_HOST/d/stf-ios-provider/17440/ \
  --connect-push tcp://stf-triproxy-dev.stf.svc.cluster.local:7270 \
  --connect-sub tcp://stf-triproxy-dev.stf.svc.cluster.local:7250 \
  --name 'Linux iOS' --market-name 'iPhone 16 Plus'
```

The bridge defaults are prototype URL `http://127.0.0.1:7400`, screen port
17440 and ownership timeout 900 seconds. Every argument also has a corresponding
`STF_IOS_PROVIDER_*` environment variable. The checked-in manifests contain the
actual cluster service names; UDID and WDA bundle ID come from `ios-device`.

## Installing an IPA

Claim the iPhone, open its dashboard and drop one `.ipa` into **App Upload**,
or onto the device screen. The limit is 1 GiB. STF accepts an already signed
development, ad hoc or enterprise package provisioned for that phone; it does
not sign, re-sign or bypass Apple verification. An App Store download, simulator
build or arbitrary unsigned IPA is not an installation artifact for this flow.

The browser uploads the file through existing `/s/upload/blob` storage and sends
`InstallMessage` with a unique `requestId`. The bridge accepts only STF blob
paths, forwards the artifact identifier to the local API and attaches a private
ownership lease. The browser cannot supply a download host or command arguments.

The job downloads only from the configured storage origin, without redirects.
The bounded Python preflight checks ZIP paths and sizes, the app plist, arm64
architecture, minimum iOS version, embedded profile expiry and device inclusion.
It verifies the profile CMS structure/signature without checking its Apple trust
chain. **iOS performs the authoritative application and profile trust checks.**
The installer invokes `ios --udid=... install --path=...`, confirms the bundle
and version in `ios apps`, and optionally opens the app through the owned WDA
session. WDA itself cannot be replaced through this panel.

The UI displays upload/download percentages and named indeterminate stages for
validation, installation, verification and launch. It shows app metadata and
profile expiry after success. A launch failure is reported separately from a
successful installation. The panel supports cancellation and restoring the
latest job after a page refresh within the same ownership session. This first
version accepts local files; URL installation and iOS uninstall are not exposed.

| Private API (all POST, JSON, Bearer token) | Purpose |
| --- | --- |
| `/installations/start` | Idempotent start with request UUID, lease, artifact ID/hash, runtime instance/generation and launch flag |
| `/installations/status` | Job by UUID or latest job for the supplied lease |
| `/installations/keepalive` | Extend the active ownership lease by 10 seconds |
| `/installations/cancel` | Stop the job belonging to that lease |

The bridge renews the job lease during its normal polling. Ownership release,
USB recovery, API restart or missing bridge heartbeats interrupt the operation.
Interrupted jobs are never retried automatically. Stopping an installer cannot
undo work already accepted by iOS, so the UI explicitly reports an uncertain
outcome where appropriate. It does not delete an app as cancellation cleanup.

Private job records are bounded to 64 retained jobs, expired after 24 hours on
startup or the next start. Temporary IPA files are removed when jobs finish and
abandoned job directories are removed after restart. The existing STF temporary
storage service controls the lifetime of the uploaded blob.

## Contact Support

`res/app/src/core/contact.ts` reads `/auth/contact`. With OAuth2 authentication,
`lib/units/auth/oauth2/index.ts` returns the root group's `owner`; the layout and
sign-in form turn that email into a `mailto:` link. It is currently the root
administrator email, not a separately configurable support URL.

`STF_ADMIN_EMAIL` is used by migration/bootstrap, including
`kuber/gitops/rethinkdb/stf-migrate-job.yaml`. Changing it also changes bootstrap
administrator ownership and is not a support-only customization. An independent
support address or chat URL should be introduced as its own configuration.

## Verification

`npm run test:unit` covers the STF bridge, wire compatibility, authentication and
prototype lifecycle. `npm run test:ios-prototype` also exercises job persistence,
idempotency, ownership, cancellation, stream limits and synthetic ZIP/plist/
Mach-O/CMS fixtures. `npm run test:component` covers browser-side file routing,
status polling, lost acknowledgements and transaction timeouts without browser
automation. Actual IPA acceptance and app launch still require a signed artifact
and a real iPhone; record that separately from fixture tests.
