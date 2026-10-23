# CI runner validation — 2026-10-23

Infrastructure setup only at this checkpoint; native end-to-end CI results are recorded below once executed.

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

- GitLab CI lint: valid, no errors or warnings.
- Node syntax check for Appium smoke: passed.
- Bash syntax check for Maestro command: passed.
- Kubernetes client dry run: passed.

## End-to-end runs

Pending publication of the immutable worker image and project-scoped coordinator credentials. No multi-hour stability claim is made by these smoke tests.
