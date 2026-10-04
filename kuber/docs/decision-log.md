# Decision Log

## Purpose

This file keeps background reasoning, rejected alternatives, and explanatory context that is useful for humans but not required in the day-to-day implementation spec.

## Recorded decisions

### Kubernetes scope

- Everything related to DeviceHub except iOS execution stays in Kubernetes.
- iOS execution stays on the Mac mini because it depends on Apple tooling.

### Android execution model

- Use one dedicated Android worker in phase 1.
- Android USB passthrough comes from Proxmox into `k3s-worker-1`.

### MongoDB

- MongoDB stays in Kubernetes.
- Phase 1 uses a simple single-instance model with persistent storage.
- No multi-node MongoDB topology in phase 1.

### OpenLDAP

- OpenLDAP and phpLDAPadmin stay in Kubernetes.
- phpLDAPadmin remains continuously available.
- Pin OpenLDAP image to `osixia/openldap:1.5.0` (avoid `latest`).
- Pin phpLDAPadmin image to `osixia/phpldapadmin:0.9.0` (avoid `latest`).
- Phase 1 allows plain `LDAP_ADMIN_PASSWORD` in manifest temporarily; migrate to Kubernetes Secret in a later hardening step.

### mitmproxy

- `mitmproxy` and `mitmweb` are valid parts of the platform.
- Traffic interception is supported where proxying and certificate trust allow it.
- Certificate pinning remains a known limitation.
- `mitmproxy` was moved into its own namespace to separate interception concerns from the main DeviceHub runtime.

### Appium Grid

- Appium Grid control plane stays in Kubernetes.
- Android Appium nodes run in Kubernetes.
- iOS Appium nodes run on the Mac mini and attach externally.

### Observability stack

- Selected stack:
  - `Traefik`
  - `Prometheus + Grafana`
  - `Loki + Promtail`
  - `Alertmanager`
  - later `cert-manager + Let's Encrypt`

### Storage model

- Phase 1 uses `local-path` storage on `k3s-worker-2`.
- Persistent storage is used for:
  - `mongodb`
  - `openldap`
  - `devicehub-storage-temp`
- `devicehub-storage-plugin-apk` and `devicehub-storage-plugin-image` use `devicehub-storage-temp` as backend storage.

### Scaling model

- `devicehub-processor`, `devicehub-storage-plugin-apk`, and `devicehub-storage-plugin-image` are scalable.
- `adbd` and `devicehub-provider` scale only as a pair.
- Most other control services stay singleton in phase 1.

### Argo CD

- Use Argo CD for GitOps.
- Use a root app / app-of-apps model.
- Use one shared `AppProject` for the whole platform in phase 1.

### Shared AppProject

- name: `devicehub-platform`
- repo: `git@github.com:mdub1na/devicehub.git`
- cluster: `https://kubernetes.default.svc`
- allowed cluster-scoped resources at start: `Namespace`

### Documentation audit and cleanup on 2026-05-29

- Keep `decision-log.md` as an append-only history of decisions. Do not rewrite earlier entries to match the current implementation state; add new entries when decisions evolve.
- Current GitOps documentation should describe the live manifest layout, not the original proposed layout.
- Public HTTPS is now part of the implemented platform through `Traefik`, `cert-manager`, and Let's Encrypt.
- The current Argo CD applications use `https://github.com/mdub1na/devicehub.git` with `targetRevision: kuber`.
- Android execution now has two explicit ADB/provider pairs: `adbd` + `devicehub-provider` and `adbd-2` + `devicehub-provider-2`.
- `mitmproxy` and `observability` remain reserved GitOps slices for later work. Their namespace-only applications are intentional placeholders, not incomplete cleanup targets.
- Remove `kuber/ios-backup`; it was an obsolete backup/working directory and included a large checked-in Selenium jar.
- Do not move plaintext credentials to Kubernetes Secrets during this audit. Secret management remains a later hardening task.
- Keep evaluating `kuber/scripts` separately: iOS provider scripts may still be operationally useful for the external Mac mini, while the Argo CD repo-server patch script looks like a one-off workaround that should either become a runbook note or be removed after confirmation.

### iOS provider startup model on 2026-05-29

- Do not run the external iOS provider through `launchctl`.
- Start the iOS provider manually from a console command when it is needed.
- Remove the launchctl plist from `kuber/scripts/ios` to avoid documenting or preserving an unsupported startup path.

## Explanatory notes

### What `root` means

- `root` is the top-level GitOps entrypoint.
- It contains only child `Application` objects, not ordinary service manifests.

### What `AppProject` means

- `AppProject` defines deployment boundaries for Argo CD applications:
  - allowed repos
  - allowed destinations
  - allowed resource scope

### What `required affinity` means

- It is a hard scheduling rule.
- If a node with the required label is unavailable, the pod should not run elsewhere.

### What `Sealed Secrets` means

- `Sealed Secrets` is a GitOps-friendly way to keep encrypted secret manifests in git.
- It is intentionally deferred until secret management becomes a real implementation need.
