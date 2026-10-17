# Appium validation — 2026-10-18

## Grid endpoint and cluster

The actual k3s kubeconfig was selected explicitly, rather than the workstation's
unrelated default GKE context. All three k3s nodes were Ready. Initially all 16
Android Appium relay pods (eight per ADB pool) were available. At the operator's
request, Android capacity was reduced to four plus three nodes and all three
iPhones were registered. Grid now reports `ready=true` and ten UP nodes:
**7 Android + 3 iOS**. Nine stopped Android relays were removed from the registry
after verifying their pods and sessions were gone. Native/Chrome stereotypes
share one session per Android node.

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

The initial trial added Appium to one free iPhone (`iPhone17,4`, iPhone 16 Plus,
iOS 27.0.1), with a dedicated device-bound relay. The operator then requested
three iOS nodes. The two remaining runtimes were updated one at a time with the
same sidecar and dedicated relays: iPhone 13 Pro (`iPhone14,2`, iOS 26.7.1) and
iPhone 14 Plus (`iPhone14,8`, iOS 27.0.1).

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

After fleet expansion, each added iPhone passed three consecutive Kotlin
Settings runs through the public Grid. Their concurrent STF screen streams
delivered 73–76 frames per run on iPhone 13 Pro and 106–123 on iPhone 14 Plus.
Every run retained the WDA session, closed the stream and released ownership.

A separate three-phone capacity check created **three simultaneous iOS Appium
sessions** through the public Grid. All three activated Settings, read native
hierarchies, swiped and took screenshots. All three retained their original WDA
sessions and released their reservations. This check used W3C HTTP commands;
the Kotlin smoke matrix remains sequential. One additional Android Settings
run per ADB pool passed after reducing Android to seven nodes.

The opt-in `stfAppiumIosDemo` task adds bounded, slow Settings swipes for live
viewing under the same account as the test token. A short one-cycle hardware
check passed; an operator-attended demonstration can use its default eight
cycles. See the harness README for viewing and report instructions.

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

All three phones' working sidecars and relays remain installed. XCUITest is
pinned but installed from npm during container startup; registry access is
required. An image with the driver baked in and application-specific tests
remain follow-ups.
Appium, WDA and the device runtime execute on Linux. The Kotlin test client
was run from the workstation; signed WDA preparation remains external to the
Linux node. The node setup and rollback are documented in
[`../appium-tests/ios-node/`](../appium-tests/ios-node/README.md).

Appium reconciliation is temporarily paused using
`argocd.argoproj.io/skip-reconcile: "true"` on `argocd/appium` until the capacity
and ingress changes reach `develop`. Remove the annotation after merging and
verify GitOps synchronization. iOS runtime/relay resources remain generated
from private device configuration outside this GitOps application.

## Reproduction

See [`../appium-tests/README.md`](../appium-tests/README.md) for opt-in Gradle
tasks, required environment variables, reports and port-allocation constraints.
No private device identifiers, tokens or signed WDA artifacts are stored here.
