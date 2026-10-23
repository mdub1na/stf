# Personal Team WDA renewal

This service signs WebDriverAgent on a Mac and replaces it on an idle Linux USB
device. It keeps the same runner bundle ID and signing identity. Signing keys
stay in the Mac Keychain. Linux receives only a verified signed application.

Apple's [Personal Team rules](https://developer.apple.com/help/account/basics/about-your-developer-account)
give provisioning profiles a seven-day lifetime. Renewing requires rebuilding
and reinstalling the application; replacing a profile file alone is insufficient.
Xcode account authentication, two-factor authentication, agreements, a locked
Keychain or device trust may still require a person. A failed attempt remains
visible in the private status file and never becomes a successful renewal.

## Lifecycle

1. `service.py` checks the configured devices hourly. Profiles with more than
   48 hours left need no build or device restart. Disconnected devices with no
   usable metadata are skipped; existing interrupted operations are resumed.
2. `sign.py` builds pinned WDA `e7e2665a00633dc174d7fc579f7e606bc9ba782a`
   with the existing Xcode account. It verifies the exact bundle, Personal Team,
   device membership, expiry improvement and signatures, including nested code.
   An exact local profile-cache refresh is permitted only with backup/restore.
   See [SIGNER.md](SIGNER.md). Certificates and portal profiles are not revoked.
3. `worker.py` creates a durable operator-only coordinator drain for one serial.
   New allocations stop immediately; existing tests finish normally. A manual
   owner is never interrupted. Drain records have no automatic timeout that
   could reopen a phone after an uncertain installation.
4. Before stopping the phone pod, the worker confirms the selected Deployment,
   ConfigMap values, pod ownership, image, zero target Grid sessions and its own
   fenced STF ownership. It preserves a private snapshot and recovery journal.
5. A short-lived non-root installer pod mounts only the selected node's usbmuxd
   socket and temporary directories. It has no Kubernetes token, signing key,
   STF token or coordinator credential. The archive hash, paths, profile and
   device are checked again before `ios install` replaces WDA.
6. The original phone Deployment resumes. The worker requires a ready WDA and
   a real PNG before retiring any superseded exact-bundle profile UUIDs. Other
   apps, wildcard profiles, certificates and pairing state are preserved. A
   second controlled restart refreshes profile telemetry when necessary.
7. The worker confirms the new unambiguous expiry, readiness, screenshot, empty
   target Grid and cleared ownership before completing the coordinator drain.
   The accepted embedded profile becomes the next signing baseline.

Deployment changes during an operation, foreign ownership, unknown sessions,
unknown signing metadata or invalid artifacts stop the operation. The recovery
journal preserves the operation and artifact identity. The worker restores the
original replica count when safe and keeps the coordinator drain on failure.
Expired-profile recovery additionally requires fresh selected-device USB proof;
it does not treat an offline phone or a missing profile as permission to install.

## Coordinator contract

The operator credential can use:

| Method | Route | Meaning |
| --- | --- | --- |
| POST | `/api/v1/maintenance` | `{serial, operationId}`; idempotent drain, UUID operation ID |
| GET | `/api/v1/maintenance/:id` | `draining` while any nonterminal lease remains, otherwise `ready` |
| DELETE | `/api/v1/maintenance/:id` | Complete only after fresh free-device, signing and Grid checks |

Project CI credentials receive 403 for these operations. This API does not
install WDA or mutate STF ownership. The Mac worker reads credentials only
inside the existing coordinator pod and sends no credential to the installer.

iOS allocation requires a canonical, unambiguous profile check no older than
one hour. Its expiry must exceed the requested maximum test duration by five
minutes. A heartbeat cannot extend a test through profile expiry. Android
allocation is unchanged. Completing a drain requires signing that covers the
coordinator's full configured duration limit and an UP relay for that phone.

Coordinator state migrates from version 1 to version 2 without changing existing
requests or leases. Version 2 persists drains. An older runtime rejects it,
preventing a rollback from silently ignoring maintenance. A rollback requires
stopped admission, no held/queued operations, an empty drain list and a reviewed
reverse migration of the **current** state that preserves all records. Never
restore an old backup over history created after the upgrade.

## Private configuration and Mac service

Keep configuration, source cache, profiles, artifacts, logs and journals outside
Git. Use directories `0700` and JSON/profile/archive files `0600`. Account IDs,
device IDs, kubeconfig contents and profile data are operator configuration.
`sign.py` documents its configuration in [SIGNER.md](SIGNER.md).

Worker configuration:

```json
{
  "version": 1,
  "kubeconfig": "/secure/farm-kubeconfig",
  "stateDirectory": "/secure/wda/worker",
  "coordinatorNamespace": "stf",
  "coordinatorDeployment": "stf-coordinator",
  "stfApiUrl": "http://stf-api.stf.svc.cluster.local:3000/api/v1",
  "gridUrl": "http://appium-grid-router.appium.svc.cluster.local:4444",
  "minValidityHours": 48,
  "drainTimeoutSeconds": 7200,
  "allowExpiredWdaRecovery": false,
  "devices": [{
    "serial": "YOUR_DEVICE_UDID",
    "namespace": "YOUR_IOS_NAMESPACE",
    "deployment": "YOUR_PHONE_DEPLOYMENT",
    "bundleId": "YOUR_INSTALLED_WDA_RUNNER.xctrunner"
  }]
}
```

`allowExpiredWdaRecovery` is an explicit opt-in for a connected phone whose
known WDA profile has already expired. It still requires the worker's fresh USB
profile proof, matching Deployment, no foreign owner and no Grid session. Leave
it disabled until this recovery path is verified for the selected provider.

Service configuration:

```json
{
  "version": 1,
  "stateDirectory": "/secure/wda/service",
  "signerConfigPath": "/secure/wda/config/signer.json",
  "workerConfigPath": "/secure/wda/config/worker.json",
  "renewBeforeHours": 48,
  "checkIntervalSeconds": 3600
}
```

Before enabling the service, deploy the reviewed coordinator runtime and test one
signed artifact on one available phone. The existing provider must support
fenced automation lease IDs. Do not place Apple credentials in a Kubernetes
Secret or farm CI job to make this work.

```sh
python3 tools/wda-renewal/service.py --config /secure/wda/config/service.json --once
python3 tools/wda-renewal/install-service.py --config /secure/wda/config/service.json --install-root /secure/wda/runtime
python3 tools/wda-renewal/service.py --config /secure/wda/config/service.json --status
```

The LaunchAgent `tech.finservice.stf.wda-renewal` uses immutable private copies
of the code and all three configurations, so changing or archiving a development
worktree does not alter it. Configuration changes require a reviewed reinstall.
It runs as the logged-in user and uses `caffeinate -s` to prevent system sleep
on AC without keeping the display lit. The Mac must remain powered, connected
to AC and logged in with an accessible signing Keychain. The service cannot
renew profiles while the Mac is shut down, and it does not bypass Apple login
or device unlock prompts. No global power settings or automatic login are set.

On a failure inspect the private status and attempt logs. Do not clear a drain
merely to make a failed job green. Re-running the worker uses the same journal;
do not replace its pending artifact with a different build. Stop or replace the
service only after confirming no renewal operation is pending.

## Verification

```sh
python3 -m unittest discover -s tools/wda-renewal -p 'test_*.py'
npm run test:unit
```

The Python tests use fake devices, processes and Kubernetes clients. They cover
signature/profile constraints, unsafe archives, cache rollback, durable recovery,
foreign ownership, busy Grid, exact-profile retirement and service scheduling.
A real signing build, installation, fresh telemetry and Appium CI smoke must be
recorded separately; fixture tests cannot prove Apple authentication or USB
availability.
