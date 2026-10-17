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

## iOS status

Three Linux iOS runtime pods and their iPhone devices were ready. Existing WDA
responded successfully; the Grid had Android stereotypes only, so iOS test
execution through Grid was not yet available.

XCUITest 12.18.1 supports attaching to externally managed WDA on Linux. WDA has
one active session: a normal Appium session would invalidate the STF runtime's
session, and normal Appium teardown would delete it. The prepared
[`../appium-tests/ios-node/`](../appium-tests/ios-node/README.md) adapter borrows
the existing session and restores settings without forwarding WDA session
creation/deletion. Seven device-free lifecycle tests pass.

Adding the prepared Appium sidecar recreates the selected iPhone pod. Automatic
approval review required explicit operator approval before this live trial.
The trial and Grid registration remain pending; Kotlin compilation and adapter
unit tests do not establish a successful iOS hardware run.

## Reproduction

See [`../appium-tests/README.md`](../appium-tests/README.md) for opt-in Gradle
tasks, required environment variables, reports and port-allocation constraints.
No private device identifiers, tokens or signed WDA artifacts are stored here.
