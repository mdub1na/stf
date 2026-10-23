# Technical brief: STF coordinator prototype

| | |
|---|---|
| Date | 2026-10-18 |
| Repository | existing github.com/mdub1na/stf, codex/coordinator-prototype |
| Platforms | Android and iOS physical devices; HTTP clients, Kotlin/JVM runner |
| Stack | Existing TypeScript STF CLI/unit convention, Node.js 22.18+, Appium Grid, STF API |
| Status | Branch research artifact. Replace intent with verified service documentation before merge. |

## 1. Problem and audience

Several test workers must share farm phones without interrupting manual users or one another. Test suites may run for hours. Existing smoke tests reserve one phone once, lack lease renewal and use the same Android system port by default. Grid schedules WebDriver slots but does not coordinate STF ownership, test-worker lifetime or shared remote ADB port allocation.

The prototype is for the operator and trusted internal CI workers. It runs as `stf coordinator`, a separate process using the common STF image. Exactly one coordinator instance is in scope, as explicitly requested. The existing STF UI remains the live viewer.

## 2. Scope

First version: authenticated request queue; idempotent allocation; ready/free device selection; provider-bound Android port allocation; iOS UDID/OS relay matching; fenced renewable STF reservations; lease-scoped WebDriver gateway with session tracking; worker heartbeat and absolute deadline; cancellation and cleanup; persistent state and restart recovery; Kotlin integration; one Android and one iOS hardware demonstration plus queue/expiry/restart exercises.

Out: second coordinator/high availability, a new web UI, user privilege role changes, a general CI execution platform, automatic app build/signing, Maestro execution, session migration after device loss. Preserve existing direct STF smoke mode.

## 3. Domain

| Entity | Identity | Ownership and lifecycle |
|---|---|---|
| Request | server UUID + client Idempotency-Key | Trusted prototype API principal; runId label. queued -> allocated / cancelled / expired / failed. |
| Lease | server UUID used as STF fencing token | One request, one phone; active -> cleaning -> released / expired / quarantined. Creation and recovery may be persisted intermediate states. |
| Worker | client process, runId/request key | Sends heartbeat while test process lives; owns test logic and artifacts. |
| Device | STF serial | Must be visible to coordinator STF service account, ready and unowned; never borrow a manual reservation. |
| Port reservation | (remote ADB host, systemPort) | Held through session cleanup. Same numeric port on distinct hosts is allowed. |
| Appium session | Grid session id | Created only through lease gateway, bound to lease; no commands after expiry. |

Tenancy: one trusted internal API principal in prototype, authenticated with a dedicated secret file. STF uses an ordinary service account restricted by its existing device-group visibility. Keep both secrets out of state, responses and logs. Multi-project authorization is future scope.

## 4. Features and target acceptance

### feature-coordinator-allocation
- Valid request returns202 and enters queue. Same Idempotency-Key plus same request returns the same request; a different payload returns409.
- Worker waits without owning a phone. Scheduler skips blocked requirements without allocating one phone twice; oldest matching request is served.
- Android needs a free matching Grid slot, STF device and unallocated allowed remote ADB systemPort. iOS needs a UP exact-UDID/version relay.
- Cancellation that races allocation cleans its granted lease. Manual reservations are never reclaimed.

### feature-coordinator-renewal
- Heartbeat renews existing unexpired lease up to absolute run deadline. Default prototype TTL180seconds, recommended heartbeat30seconds; short configurable TTLs support expiry validation.
- STF capture carries leaseId. Provider verifies exact owner + leaseId for renewal/release. Stale same-account worker cannot renew or release a newer lease.
- API timeout milliseconds are consistent on Android and iOS. Viewer activity is not worker heartbeat.

### feature-coordinator-session
- WebDriver URL includes lease identity and requires API authentication. Gateway sets authoritative device/ADB/port capabilities; mismatches are rejected before upstream creation.
- One session per lease. Commands may address only that lease's session. Gateway rejects expired, cleaning or quarantined leases.
- Normal finish: quit Appium -> fenced STF release -> release port -> terminal lease. Failure artifacts are collected by runner before quit.
- Failed/ambiguous session creation/deletion or unknown in-flight commands must quarantine rather than offer the phone to another worker.
- Graceful shutdown stops allocations, cleans active sessions and persists outcome. Restart preserves queued requests but recovers old leases before issuing phones. State loss/uncertainty cannot be treated as successful cleanup.

## 5. Screens

No new screens in prototype. Existing STF device-list and control viewer show Automated, live screen and disabled controls. Operator inspection is authenticated JSON status/requests/leases. Therefore there are no design artboards or new fonts/tokens.

### 5a. Sample data

Fixed documentation date2026-10-18. Example runId `settings-demo`, request `request-1`, lease `lease-1`, synthetic serial `ANDROID-EXAMPLE`, model `Example phone`, provider `provider-one`, ADB host `adb-one`, ports8200/8201. Real farm serials, credentials and snapshots stay private.

## 6. API decisions (target, not observations)

All API routes require bearer API token. WebDriver gateway also accepts HTTP Basic (username coordinator, password API token) for Appium Java Client. Health endpoints expose no identities.

| Method | Path | Request | Response / errors |
|---|---|---|---|
| GET | /healthz, /readyz | none | 200healthy;503not ready |
| GET | /api/v1/status | none | counts;401 |
| POST | /api/v1/requests | Idempotency-Key; runId, platform, optional serial/model/provider/queueTimeoutSeconds/maxDurationSeconds | 202{request};400,401,409,429 |
| GET | /api/v1/requests/:id | none | {request};401,404 |
| DELETE | /api/v1/requests/:id | none | 202{request};401,404 |
| GET | /api/v1/leases | none | {leases};401 |
| GET | /api/v1/leases/:id | none | {lease};401,404 |
| POST | /api/v1/leases/:id/renew | {} | {lease};401,404,409expired/lost |
| DELETE | /api/v1/leases/:id | none | 202{lease};401,404 |
| POST | /api/v1/leases/:id/recover | {} | retry quarantined cleanup;401,404,409 |
| any | /api/v1/leases/:id/webdriver/session... | W3C WebDriver | lease-scoped upstream response;401,404,409 |

Lease reply includes device{serial,platform,model,version,provider}, id,state,expiresAt,deadlineAt,heartbeatIntervalSeconds,capabilities,webdriverUrl. Queue request wrapper is `{request:...}`, lease wrapper `{lease:...}`. Errors are `{error:{code,message}}`; WebDriver errors retain W3C shape. Secrets and upstream response dumps are never echoed.

Existing STF API extension: capture accepts optional leaseId; POST /api/v1/user/devices/:serial/automation/renew {leaseId,timeoutMs field named timeout}; POST /.../automation/release {leaseId}. Both authenticate normal STF owner, verify exact lease at provider, and wait for acknowledgement. Legacy capture/release remain compatible.

## 7. Modules

| Module | Role | Storage/config | Status |
|---|---|---|---|
| lib/cli/coordinator | CLI flags/env and lifecycle | STF_COORDINATOR_* | new |
| lib/units/coordinator | HTTP API, scheduler, gateway, upstream clients, recovery | atomic persistent state file, two token files, ADB pools config | new |
| lib/units/api + wire + device + ios-provider + processor | fenced STF lease operations and timeout consistency | existing bus/database | extend |
| kuber/appium-tests | Kotlin queued allocation/heartbeat/gateway adapter | COORDINATOR_URL/TOKEN | extend |
| kuber/coordinator | opt-in single replica Deployment/Service/PVC/NetworkPolicy; no GitOps rollout until validated | private generated secrets/pool config | new |

## 8. Verified foundations and decisions

| Claim / decision | Evidence / status |
|---|---|
| STF commands are independent CLI/unit processes | lib/cli/index.ts and lib/cli/provider/index.ts verified |
| Existing client uses GET devices, POST capture, DELETE release | kuber/appium-tests/.../StfClient.kt verified |
| Existing Android driver explicitly uses systemPort8200 | DriverFactory.kt:25 verified |
| Shared ADB pools publish8200..8209 | kuber/gitops/stf/stf-android-services.yaml verified |
| Existing iOS provider misinterprets REST timeout milliseconds | lib/units/ios-provider/bridge.ts:293,406 verified; fix in prototype |
| Existing Grid has session queue but no STF lease coordination | local Grid manifests; official Selenium components docs verified in conversation |
| One durable local state file | decision for explicitly single instance; atomic replacement and restrictive permissions required |
| No new UI | decision: demonstrate through current STF viewer and API snapshots |
| Gateway owns all prototype Appium sessions | decision: binds lease to session and enables expiry/recovery enforcement |
| Recovering unknown creation outcomes | fail-closed decision; quarantine until cleanup can be proved, no blind reissue |

## 9. Ordered delivery seeds

1. Fenced STF lease renewal/release + consistent timeout units; stale requests cannot affect a newer owner.
2. Coordinator state machine, persistence, scheduler and port leases; meaningful fake-upstream tests.
3. Authenticated API and lease WebDriver gateway; queue, heartbeat, deadline, failure/restart tests.
4. CLI, deployment and Kotlin adapter; preserve direct smoke path.
5. Build/lint/tests, immutable preview image; controlled hardware validation on free devices.
6. Record observed results/limits in service docs and open dependent PR. No merge requested.

## 10. Open validation questions

- Verify real Grid capability/session shapes and WDA adapter teardown against prototype gateway.
- Verify strict provider lease acknowledgements and restart behavior on one free Android/iPhone.
- Measure heartbeat during slow WebDriver commands and expire a short diagnostic lease.
- A multi-hour soak remains a separate observation if wall time does not permit it; do not claim hours of stability from a short TTL demonstration.
