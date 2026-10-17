# Appium validation — 2026-10-18

## Grid endpoint and cluster

The actual k3s kubeconfig was selected explicitly, rather than the workstation's
unrelated default GKE context. All three k3s nodes were Ready. All 16 Android
Appium relay pods (eight per ADB pool) and Grid control-plane deployments were
available. Grid reported `ready=true` and 16 UP nodes. Its native/Chrome
stereotypes share one session per node; 32 advertised slots do not mean 32
concurrent device sessions.

The operator changed the public DNS for `appium-grid.finservice.tech` to the
farm ingress. The new `appium-grid-finservice` Ingress was applied from
[`../gitops/appium/appium-grid-ingress.yaml`](../gitops/appium/appium-grid-ingress.yaml).
cert-manager issued `appium-grid-finservice-tech-tls`; certificate validation
and `GET https://appium-grid.finservice.tech/status` passed without disabling TLS
verification. The certificate expires on 2027-01-15. The old hostname no longer
resolves. GitOps adoption of the new resource and pruning the old Ingress occur
when this change reaches `develop`; the new route is already applied.

## Android hardware results

The final Kotlin Settings smoke passed three consecutive times on each of six
connected phones: **18/18 runs**, across both ADB/provider pools.

| Model | Provider pool | Successful final runs |
| --- | --- | --- |
| CTR-L81 | stf-provider | 3 |
| Mi A2 | stf-provider-2 | 3 |
| 23124RA7EO | stf-provider | 3 |
| SM-F936B | stf-provider | 3 |
| SM-A556E | stf-provider | 3 |
| SM-A556E | stf-provider-2 | 3 |

Each run reserved the exact phone through the standard STF API, created an
Appium session through the public HTTPS Grid, activated Settings, inspected
native elements, obtained a screenshot, quit Appium and verified reservation
release. These are sequential runs, not a parallel-capacity result.

The first trial exposed Settings remaining behind the launcher on Huawei when
`noReset` was enabled. Explicit app activation fixed it. That failed trial also
exercised screenshot/page-source collection and session/reservation cleanup;
the test account held no device afterward. Chrome and application-specific
scenarios are not covered by these Settings results. Final checks reported zero
active Grid sessions and zero phones held by the validation account. Its temporary
user and API token were removed; the revoked token returned HTTP 401.

## iOS hardware results

The operator approved adding Appium to one free iPhone (`iPhone17,4`, iPhone 16
Plus, iOS 27.0.1). The other two iOS runtime pods were not changed. The selected
pod now includes the Appium sidecar, and a dedicated device-bound relay connects
it to the public Grid. Final Grid capacity is 16 Android nodes plus one iOS node.

The Kotlin iOS Settings smoke activates the app, verifies its bundle identifier
and native hierarchy, performs an up/down swipe and gets a screenshot. Three
consecutive final runs passed through `https://appium-grid.finservice.tech`
after restarting the Appium container. Concurrent authenticated STF screen
streams delivered 50, 46 and 47 JPEG frames respectively, with 29 distinct frames
in each run. Streams closed on ownership release. All three runs retained the
original WDA session and released the phone.

The Appium-only restart preserved the pod identity, WDA session and other
container restart counts. The two other iPhone pods were unchanged. A separate
run also verified automatic device selection without `STF_SERIAL`, choosing
only a free phone with a registered UP relay. Final checks reported zero active
Grid sessions; the temporary iOS validation user/token were removed and the
revoked token returned HTTP 401. The diagnostic port-forward was closed.

Hardware testing found and fixed two integration failures:

- ConfigMap files are symlinks. Comparing Node's resolved module URL against
  the unresolved entry path prevented the adapter from starting. Real-path
  comparison, process supervision and joint readiness/liveness checks fix it.
- Selenium's version matching rejects a versioned request when the relay omits
  `appium:platformVersion`. The relay now advertises the phone's exact reported
  version, and preflight rejects mismatches before creating a session.

The loopback adapter borrows STF's existing WDA session and restores settings;
normal Appium session creation/deletion is not forwarded to WDA. Eleven Node
regression tests cover lifecycle, ConfigMap startup and Grid resource rendering.
Seventeen Kotlin regression tests cover configuration, Grid preflight,
allocation, eligible-device selection and cleanup. The new preflight test fails
when the OS-version check is removed.

The selected phone's working sidecar and relay remain installed. XCUITest is
pinned but installed from npm during container startup; registry access is
required. Registration of the other iPhones, an image with the driver baked in,
parallel iOS capacity and application-specific tests are separate follow-ups.
Appium, WDA and the device runtime execute on Linux. The Kotlin test client
was run from the workstation; signed WDA preparation remains external to the
Linux node. The node setup and rollback are documented in
[`../appium-tests/ios-node/`](../appium-tests/ios-node/README.md).

## Reproduction

See [`../appium-tests/README.md`](../appium-tests/README.md) for opt-in Gradle
tasks, required environment variables, reports and port-allocation constraints.
No private device identifiers, tokens or signed WDA artifacts are stored here.
