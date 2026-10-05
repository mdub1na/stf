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

### STF GitOps rollout on 2026-10-04

- Switch the existing root and child Applications to `mdub1na/stf`, `develop`;
  preserve historical namespace/service/domain names and Android/Appium wiring.
- Deploy before server upgrades, as confirmed by the user. Update only the
  three Kubernetes VMs once SSH access is provided; exclude Proxmox and Mac mini.
- Use fresh RethinkDB storage and a successful STF migration hook. The user
  allowed deleting old MongoDB data, so no MongoDB conversion or backup was done.
- Publish a public GHCR image and pin its verified multiarch digest in GitOps.
- Preserve LDAP and temp storage PVCs. Replace plaintext manifest/ConfigMap
  credentials with separately bootstrapped Secrets without LDAP password reset.
- Remove iOS bridges and launcher scripts from active deployment scope.
- Restore root/infrastructure auto-sync; keep STF and RethinkDB manual-sync.
- Preserve the 8 + 8 Appium nodes. Copied Java tests are historical until adapted
  away from DeviceHub-specific allocation APIs. Devices were disconnected at
  rollout, so screen/touch/capture/APK/test checks remain pending.

### STF public domain on 2026-10-05

- Change only the farm address from `devicehub.putmyhexon.ru` to
  `stf.finservice.tech`; keep LDAP, Argo CD and Appium Grid domains unchanged.
- Pre-issue an explicit GitOps Certificate, then change ingress and all
  app/auth/WebSocket/storage/provider public URLs through Argo CD.
- Trigger app/auth environment reload with existing pod-template annotations.
  Do not rotate session/LDAP credentials or rebuild the unchanged application.
- Remove generated TLS resources for the old host after new TLS validation.
- Treat client DNS cache propagation separately from service/certificate health;
  never disable TLS verification. Users log in again on the new hostname.

### STF GitLab login on 2026-10-05

- Replace the active LDAP login with confidential OAuth through
  `gitlab.finservice.tech`; callback is `/auth/oauth/callback` on the STF host.
- The user approved all users of that GitLab with a verified email, without
  email-domain or group restrictions. Request only `openid profile email`.
- Require state protection and use S256 PKCE, a separate short-lived signed
  state cookie and verified-email checks. Deny missing/invalid claims.
- Bootstrap client credentials in a separate Kubernetes Secret, never Git.
  Preserve the existing STF session signing key.
- Keep the existing Application and historical service names. Select the
  `stf-gitlab` overlay; pin its auth image separately to avoid other pod restarts.
- Preserve LDAP storage/base and the original administrator for explicit
  GitOps rollback until real login and administrative access are confirmed.
- Promote only the account explicitly approved by the user after its first
  successful login; do not map GitLab roles to STF administrator privileges.

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
