# WDA renewal validation — 2026-10-23

This record covers one connected iPhone 14 Plus and the current signing Mac.
Two other configured iPhones were offline. Their installation and provider
fencing were not verified, and they are not enabled in the renewal service.

## Signing and coordinator

- Personal Team remained unchanged. The existing development signing identity
  was used; no certificate or Apple portal profile was revoked.
- WDA v16.15.0, source `e7e2665a00633dc174d7fc579f7e606bc9ba782a`, was
  rebuilt by the reusable signing CLI. Xcode's exact stale local profile cache
  needed a backed-up refresh before it issued a longer-lived profile.
- The old installed profile expired at `2026-10-23T17:44:57Z`. The new profile
  expires at `2026-10-30T14:55:27Z` (19:55:27 Asia/Yekaterinburg).
- Deep and nested runtime code signatures passed. A ZIP round trip preserved
  application bytes and executable modes. The accepted archive SHA-256 is
  `0fce8fe29a10b6a32a6309239b72613a04f18ca5bd7a3a4b3fe13da8089d6ce6`.
- Coordinator source `e6ee7fda` was compiled with Node 22 and published as
  `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke/runtime@sha256:052897f7093fd43739675417210ccf0d47f65e29e79583e0435e5e103ad72549`.
  The image-only rollout preserved all 38 existing requests, all 38 leases,
  credentials, project policies and Deployment settings. State migrated from
  v1 to v2 with an empty maintenance list. CI runners' original admission
  settings were restored.
- The actual image passed an isolated, network-free migration/drain/allocation
  probe. The full `npm run test:unit` passed, including 404 Mocha tests.
  All 109 offline renewal Python tests passed.

## Installation and recovery

The first service cycle stopped before `ios install`: pymobiledevice3 attempted
to create its cache under the helper image's read-only home. The helper was
removed, the original phone pod returned to 4/4 Ready, and the same persistent
drain and pending artifact remained. The helper now uses private HOME/XDG
directories in its existing `/work` volume; the read-only root filesystem and
helper permissions were retained.

The retry resumed the same operation and signed artifact, without a new build.
It installed WDA, restored the phone, confirmed WDA readiness and a real PNG,
removed one superseded exact-bundle profile UUID, and refreshed telemetry with
a controlled restart. Final checks confirmed:

- A single matching valid WDA profile with the new expiry.
- Original Deployment specification, 4/4 Ready and zero container restarts.
- An UP Grid relay, zero target sessions, no helper pods or maintenance drain.
- Cleared STF owner, usage, claim and automation marker.
- Completed worker journal, no pending service operation, and the accepted
  embedded profile retained privately as the next signing baseline.

The successful cycle completed at `2026-10-23T15:39:50Z`. A subsequent explicit
cycle returned `notDue=1`, `renewed=0`, `failed=0`; it performed no rebuild or
phone restart.

## Scheduled service

LaunchAgent `tech.finservice.stf.wda-renewal` was installed and observed running.
Its first background cycle also returned `notDue=1`, `failed=0` and recorded the
next hourly check. Configuration enables the single validated online phone,
with a 48-hour renewal threshold. Expired-profile recovery remains opt-in.

The installed code matches source commit `5f1e3779`; its combined SHA-256 is
`d3e17efc8e1b62aea72637c99d16c3a4e516932441301710862d88e5ead5999d`.
Code and three private configurations are copied into content-addressed runtime
directories, independently of the development worktree. The LaunchAgent plist
and private state use mode `0600`. A live `caffeinate -s` assertion was observed.

State, profiles and artifacts live in the current user's private
`Library/Application Support/STF/WdaRenewal` directory. Secrets, team/device
identifiers, provisioning files, raw logs and kubeconfig are not committed.

This proves initial signing, renewal, recovery from the observed installer
failure and scheduled checks. It does not prove multi-week operation, renewals
while the Mac is asleep/offline, unattended Apple reauthentication, or the two
offline phones. The Mac must remain running on AC, logged in with its signing
Keychain accessible.

## Real-device CI regression

[ai-tests pipeline 6555](https://gitlab.finservice.tech/gfs/platform/quality/ai-tests/-/pipelines/6555)
completed successfully on unchanged branch `codex/appium-kotlin-ui`, source
`d608b948c32e8d7617992f423e612c02871a7a0f`, with inputs `purpose=ui` and
`ui_platform=iOS`. All five jobs passed. GitLab JUnit summary: 305 tests,
305 successful, zero failed/error/skipped.

The actual farm job was
[ui_smoke 33817](https://gitlab.finservice.tech/gfs/platform/quality/ai-tests/-/jobs/33817),
run `6555-33817`. Its coordinator lease and Grid session used the renewed
iPhone 14 Plus. STF reported automation ownership with the exact active lease
marker. Hardware JUnit and the smoke summary both confirmed one test found,
started and successful; two valid PNG artifacts were present.

[Allure UI 33819](https://gitlab.finservice.tech/gfs/platform/quality/ai-tests/-/jobs/33819)
published its HTML report. Its embedded summary confirmed one passed test and
zero failed/broken/skipped/unknown tests.

After the job, the lease was released without error. There were no held/queued
leases, maintenance records, Grid sessions or STF ownership/automation markers.
The exact old Appium session returned `invalid session`; Appium and WDA stayed
ready. The proxy had zero borrowed WDA sessions and retained the same persistent
baseline WDA session. The phone remained 4/4 Ready with zero container restarts.

Raw JUnit, signed profiles, screenshots, Allure HTML and operator snapshots are
private evidence, not repository files. No ai-tests source or scenario-acceptance
process was changed during this renewal task.
