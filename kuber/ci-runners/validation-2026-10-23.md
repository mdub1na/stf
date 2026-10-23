# CI runner validation — 2026-10-23

Native Appium and Maestro tests run successfully from the independent GitLab repository. [Pipeline6501](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/pipelines/6501) passed3/3 Android tests; [pipeline6505](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/pipelines/6505) passed4/4 with a physical iPhone. Both verified the two-device limit, queued workers, reports, screenshots and confirmed device cleanup.

## Created resources

- Private GitLab project145: https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke
- Draft MR1: https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/merge_requests/1
- New project runner9, `stf-farm-kubernetes`, tagged `stf-farm`, project-locked, no untagged jobs, online.
- Namespaces `stf-ci` and `stf-ci-jobs`; no existing project or runner changed.
- Runtime manager config checked with secret values excluded: concurrent3, limit3, request_concurrency3, jobs namespace `stf-ci-jobs`, jobSA `stf-ci-job`, automount=false, privileged=false, allowPrivilegeEscalation=false.

## Network policy enforcement

A temporary UID1000 probe pod used the same namespace, service account and coordinator-access labels as real jobs. It had no Kubernetes token file. The probe pod was deleted after evidence capture.

| Target | Trusted STF pod | CI job pod |
|---|---|---|
| DNS | available | available (all target names resolved) |
| GitLab443 | — | connected |
| coordinator8080 | — | connected |
| adbd5037 | connected | rejected |
| Grid4444 | connected | rejected |
| STF API3000 | connected | rejected |
| Kubernetes API443 | — | rejected |

The trusted connectivity check used the existing `stf-api` pod without credentials or requests that mutate a device. Its purpose was to distinguish policy rejection from an absent service. CI access rules allow only kube-dns53, GitLab34.0.249.190:443 and coordinator pods8080. The job policy never grants shared ADB access.

## RBAC

- Manager SA can create pods in `stf-ci-jobs`: yes.
- Manager SA can read Secrets in `stf`: no.
- Job SA can create pods in `stf-ci-jobs`: no.
- Job SA can read Secrets in `stf-ci`: no.

## Source checks

- Final targeted coordinator/provider/API regressions:104passed.
- Standalone CLI on Node22.18, including installed-package execution:21passed.
- Repository TypeScript checks and compilation:passed.
- Native Dadb2.0 from Maestro:100cycles,266WebSocket upgrades, peak2active streams,0remaining streams, no transport failure. Admission limits remain32per lease and128globally.
- GitLab CI lint: valid, no errors or warnings.
- Node syntax check for Appium smoke: passed.
- Bash syntax check for Maestro command: passed.
- Kubernetes client dry run: passed.

## Registry authentication

- Registry URL verified through project145 metadata: `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke`.
- Registry host resolves to34.0.249.190 and uses TLS443; no job egress rule was added.
- Worker admission accepts only `…/ci-worker@sha256:*` from this project. Integrated GitLab job credentials are used for ephemeral worker image pulls.
- Project deploy token32 has only `read_registry`; an auth challenge requesting pull,push yielded pull only. Its credentials are stored in `stf/stf-farm-registry-pull`, never in job variables. Expiration:2027-01-21.

## Validated images

The subsequent coordinator upgrade for signing deadlines and persistent iOS
maintenance is recorded in [WDA renewal validation](../../tools/wda-renewal/validation-2026-10-23.md).
The image below records the earlier CI runner validation.

- Coordinator: `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke/runtime@sha256:33fa05d93b2b709ef69dbdcffc6f64baffc92b7d3f5ddc156cc38a8b01b8985c` (source behavior through commit`ed47d53a`). Runtime versions:Node22.23.2,Express5.3.0,ws8.22.0.
- API/processor/Android providers: `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke/runtime@sha256:f40b56e23652eb08a8af98f0822360df8a9182bdc645f01152737928f2397f6b` (provider cleanup/wire behavior through commit`97940773`).
- Worker: `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke/ci-worker@sha256:5ed0d8ccdc2068efcc29ba561e47cb6226182baf6639ed976ac76b357d4c7685`. Node22.18,Maestro2.11,JDK21; standalone transport behavior through commit`923e49b0`.

## End-to-end runs

Worker image `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke/ci-worker@sha256:5ed0d8ccdc2068efcc29ba561e47cb6226182baf6639ed976ac76b357d4c7685` was pulled successfully with integrated GitLab job credentials.

- Pipeline6492: nonroot helper attempted `//.gitconfig`; fixed by runner environment `HOME=/tmp`. No device lease was allocated.
- Pipeline6493: checkout and all worker network checks passed, then strict CLI rejected the broad-permission GitLab file variable before allocation.
- Pipeline6496, demo commit32482625: actual file variable mode666, owner1000 confirmed; before_script chmod600 fixed admission. All three worker network artifacts passed and were uploaded successfully. Runner confirmed the explicit15minute job timeout.
- The two Appium workers created W3C sessions but GET/source hit a coordinator GET-body bug, causing quarantine when cleanup could not be confirmed. Maestro's actual shell service included a trailing LF, rejected by the first transport validator; its native cleanup was confirmed and its lease released. The runtime fixes were deployed. After Grid confirmed0sessions and targeted native checks found no UiAutomator2/Maestro instrumentation, the coordinator was stopped and its two known session IDs were restored from CI traces with a state backup. No marker or ownership was cleared manually; the corrected cleanup reconfirmed session termination and released both leases at startup.

- Pipeline6497, same demo commit32482625 and worker5ed0d8cc: the GET/HEAD-body and Maestro shell trailing-LF fixes allowed execution to progress. Appium33635 produced `appium-before.png` and `appium-after-scroll.png`; Maestro33634 created its flow diagnostic log. Around07:56:03UTC coordinator connectivity was lost, its ADB stream was interrupted and the remaining worker stopped after heartbeat failure. All three jobs failed safely rather than continuing without a confirmed lease. All worker isolation JSON artifacts passed and were uploaded. Traces/archives were saved privately for diagnosis; these screenshots are evidence of command execution, not a completed pass.
- Runner cleanup and pod termination grace were increased to180seconds so the wrapper has time for its120second cleanup request and process stop. The explicit job timeout remains15minutes. No new pipeline is started until coordinator recovery is confirmed.

## Successful Android validation

[Pipeline6501](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/pipelines/6501) passed all3jobs in99seconds on demo commitca11772e and runtime33fa05d9. GitLab JUnit summary:3tests,3success,0failed/error/skipped.

| Job | Engine | Result |
|---|---|---|
| [33639](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33639) | Appium Android | Passed; foreground package, Settings tree, gestures, before/after PNG, JUnit |
| [33640](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33640) | Maestro Android | Passed; Settings resource IDs before/after gestures, screenshots, commands/logs, JUnit |
| [33641](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33641) | Appium Android | Passed after waiting for a device; same assertions/artifacts |

All3actual worker network-isolation artifacts passed. Authoritative coordinator timeline confirmed max held leases2 and a queued third request. Huawei's Maestro lease was released at08:10:40.804UTC and the queued Appium lease became active at that same timestamp. All leases were released and coordinator restart count remained0. Cleanup grace was allowed to finish naturally before another pipeline; no worker pod was forcibly deleted.

The image storage quota was adjusted from18Gi to20Gi to accommodate at most4pods (3active plus1finishing cleanup), matching the existing pod/CPU/memory quota. No access permission or network policy changed.

## Successful combined Android/iOS validation

[Pipeline6505](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/pipelines/6505) passed in115seconds on demo commit`51734890`. GitLab JUnit summary:4tests,4success,0failed/error/skipped. The runtime and worker digests above were unchanged.

| Job | Engine and device | Result |
|---|---|---|
| [33646](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33646) | Appium Android,MiA2 `2a3e120` | Passed;2PNG,JUnit |
| [33647](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33647) | Maestro Android,Huawei `2GDYD24423010014` | Passed;2PNG,commands/logs,JUnit |
| [33648](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33648) | Queued Appium Android,same Huawei | Passed;2PNG,JUnit |
| [33649](https://gitlab.finservice.tech/gfs/platform/quality/farm-connection-smoke/-/jobs/33649) | Appium iOS,iPhone14Plus `00008110-000625A02146201E` | Passed;2PNG,JUnit |

All4worker network checks passed. Total artifacts:20files,8PNG,4JUnit XML. The fourth job was admitted without a resource-quota error while a previous pod was finishing cleanup.

The coordinator timeline recorded at most2held devices. Maestro released Huawei at08:30:49.225UTC; the queued Appium lease became active at the same timestamp. The iPhone lease ran from08:31:02.357UTC through confirmed release at08:31:43.259UTC. The final coordinator pod had0restarts during validation.

Authoritative final checks: all34global leases terminal (26released,8expired from earlier diagnostic runs),0held/quarantined,Grid0sessions,and no coordinator error. Both Android phones and the iPhone were present/ready in STF with no owner,usage or automation lease ID. Targeted Android process checks found no UiAutomator2/Maestro driver process. The latest Maestro lease retained its provider cleanup acknowledgment; a fresh snapshot confirmed0Maestro packages and exact restoration of every tracked setting to its saved baseline.

At08:36:47UTC the job namespace was empty after every pipeline6505pod finished its configured cleanup grace naturally. No worker was force-deleted. The runner manager remains online for future runs. The external MR's final docs-only commit`e781ab4b` synchronizes existing-WDA guidance; its executable test code is unchanged from the validated commit`51734890`.

The preceding pipeline6502 passed3Android tests but its iOS capability `bundleId` triggered host USB discovery before existing-WDA attachment. Server logs identified the failed internal SID; exact local GET/DELETE/GET confirmed404invalid-session and Grid reported0sessions. Its backed-up recovery metadata was repaired while the coordinator was stopped, then normal startup cleanup released the lease. The final iOS smoke omits `bundleId`/`app` at session creation and activates the installed app after connecting. Business-application installation/upgrade is not covered by this Settings smoke.

No multi-hour stability claim is made by these smoke tests.
