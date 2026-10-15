# Component upgrade rollout — 2026-10-15

The user authorized the audited component upgrades, with RethinkDB explicitly
excluded. K3s was subsequently deferred because SSH access is unavailable.
No node, datastore, CNI, storage-provisioner or observability installation is
part of this rollout. LDAP remains at zero replicas.

## Selected versions

| Component | Previous | Selected target |
| --- | --- | --- |
| Active Argo CD, namespace `argocd` | 3.4.2 | 3.5.5, release-pinned bootstrap |
| cert-manager | 1.20.1 | 1.20.4, matching chart and CRDs |
| Traefik | 3.6.12 | 3.6.25, pinned image digest with existing chart 39.0.7 |
| STF dynamic proxy | NGINX 1.27 | NGINX 1.30.6-alpine, pinned digest |
| Selenium Grid and all relay containers | 4.39.0 | 4.51.0-20261010, pinned digests |
| Appium | 2.11.4 | 3.8.0, image `v3.8.0-p1` pinned by digest |
| Appium Node.js / UiAutomator2 | 18.20.4 / 3.8.0 | 24.21.0 LTS / 8.7.0, bundled in the selected image |
| RethinkDB | 2.4.2 | Remains 2.4.2; no manifest or workload change |
| K3s and bundled add-ons | 1.35.5+k3s1 | Deferred by the user; remains 1.35.5+k3s1 |

Traefik 3.7/chart 41 and K3s 1.36 are separate future minor-version migrations.
The existing Traefik and `traefik-crd` charts stay aligned at 39.0.7 for this
3.6 patch upgrade. No CRD schema migration or release ownership change is needed.
The existing ADB binary/image and STF worker/app/auth digests remain unchanged.
The unused Argo CD installation in `default` is outside the active installation
upgrade; retiring it still requires the configuration/ownership audit.

## Preflight and canaries

- Save the original Argo Application specs, workload/HelmChart specs and Argo CD
  configuration/Secrets outside Git with owner-only permissions. Never commit
  backup credentials or copy them into the PR.
- Confirm no active Grid sessions and no owned connected STF devices.
- Run the pinned Appium image separately from the Grid. Verify Node/npm/Appium
  and installed drivers. Create and close native UiAutomator2 sessions against
  Android APIs 31, 35 and 36 without launching or resetting user applications.
- Use an already exposed ADB system port (8200–8209). A temporary test on 8250
  was outside the Service range; the corrected test uses 8209. This required no
  production Service change.
- Run NGINX 1.30.6 with the existing configuration. Check `nginx -t` and compare
  the real STF display route: both existing and canary proxies must complete
  the WebSocket handshake with HTTP 101. No video frames are retained.

## Deployment order

1. Pause root automation before temporarily changing child sources. Keep the
   original policies for restoration. Synchronize only the selected applications;
   do not synchronize the RethinkDB application or run its migration hook.
2. Apply `gitops/bootstrap/argocd` with server-side apply and an explicit field
   manager. The upstream install URL is pinned to `v3.5.5`; preserve live Secret
   and ConfigMap data. Check all active Argo workloads and server/repo versions.
3. Synchronize cert-manager and check its rollout and existing Certificate
   readiness. Synchronize the Traefik patch and check ingress with valid TLS.
4. Synchronize the STF GitLab overlay: only the dynamic proxy image changes.
   Recheck the real WebSocket route and four present/ready devices.
5. Synchronize Appium/Grid. Both eight-node pools use a rolling update with
   maxSurge 1/maxUnavailable 0; all Selenium components use the same release.
   Scoped `uiautomator2:chromedriver_autodownload` replaces the Appium 2 flag.
   Add explicit resource reservations and Appium startup/readiness probes.
6. Check all 16 Grid relays registered and UP, then create/close a native session
   through the Grid. Confirm the runtime versions and no pod restart/OOM loop.
7. After required PR checks pass, merge to `develop`, restore child sources and
   original automation, and refresh all Applications. Remove canary resources
   and the completed task branch/worktree.

During a Grid control-plane rollout, temporarily mixed versions are expected;
new sessions are verified only after the whole Grid reaches the selected release.
Existing sessions must be idle before beginning that rollout.

## Verification and rollback

Before completing the rollout, require all ten existing Applications Synced/Healthy, all 16 Grid
nodes UP, four present/ready devices, valid public ingress TLS and Ready
Certificates. Compare the RethinkDB StatefulSet spec, pod UID/image ID and PVC
identity with preflight: none should change. OpenLDAP/phpLDAPadmin must stay at
zero replicas and their original PVC must stay Bound.

For application-image failures, restore the prior Git versions through the same
Applications; retain the preflight specs as an emergency fallback. A failed
Appium canary blocks the pool rollout. For Argo CD, reapply the pinned 3.4.2
install and restore only the configuration fields actually changed; never reset
live Secrets wholesale. The version-pinned bootstrap is the installer, while
`argocd-config` continues to own the ingress and configuration slice.

No K3s rollback or datastore restoration is required because K3s is unchanged.
Before a future K3s upgrade, arrange authenticated sudo access and take a
verified datastore/server-token backup through that access. The attempted
backup pods were rejected by automatic approval review and were never created.
