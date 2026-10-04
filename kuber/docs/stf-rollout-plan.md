# STF GitOps Rollout Plan

Deploy Android STF from `mdub1na/stf`, branch `develop`, to the existing k3s
cluster. Upgrade the Kubernetes servers before switching the application.
The old MongoDB and its data may be deleted. iOS and Java test API adaptation
are outside this rollout.

## Execution boundaries

- Preserve LDAP data, ADB DNS names, the two ADB/provider pools, public domains,
  Appium Grid with 8 + 8 nodes, and system ports 8200-8209 per ADB pool.
- Keep existing application, namespace and service names during this migration.
  The `devicehub` deployment slice will run STF despite its historical name.
- Publish workload changes through Git and synchronize them through Argo CD.
  Initial Argo CD source changes and Secrets are bootstrap exceptions.
- Server maintenance covers only the three Kubernetes VMs. Proxmox and the
  Mac mini are excluded. Do not reset the cluster, reinstall its distribution,
  or upgrade Ubuntu to another major release.
- Never reboot two Kubernetes servers together. Expect a brief API/ingress
  outage when rebooting the single control-plane server and workload downtime
  for USB-bound ADB and node-local storage.
- Missing SSH/registry access blocks dependent steps only. Continue preparing
  and validating the repository while those accesses are being resolved.

## Current checkpoint

Snapshot: 2026-10-04. No server updates or workload source changes applied yet.

- [x] Kubernetes API and GitHub access verified; GitHub Actions enabled.
- [x] All three nodes Ready: Ubuntu 26.04 LTS, k3s v1.35.5+k3s1.
- [x] Initial Argo CD sources inspected: DeviceHub repository, `kuber` branch.
- [ ] SSH and sudo on 192.168.0.121-123: deferred; the user will provide access
  later. The initial control-server `mdub1na` login was refused.
- [x] Maintenance scope confirmed: Kubernetes VMs only; no Proxmox host update.
- [ ] Android USB visibility: both ADB device lists were empty at preflight.
- [ ] Container build/publish verified; local Docker daemon is not running.
- [x] GHCR build workflow prepared and locally committed as `9758acdf`.
- [x] GitHub authorization refreshed by the user; `workflow` scope verified.
- [x] Prepared commits `9758acdf` and `1b0390e4` pushed to `origin/develop`.
- [ ] First Docker build/publish verified. Initial run:
  [37221865853](https://github.com/mdub1na/stf/actions/runs/37221865853).
  Both architecture build jobs have started and GHCR login succeeded.
- [x] STF/RethinkDB manifests prepared; ten local Kustomize slices render.
- [x] STF/RethinkDB client-side schema checks and 15-command CLI audit passed.
- [x] Five isolated Secret bootstrap checks passed using in-memory module mocks:
  creation, idempotency, wrong cluster, failed LDAP bind and missing credential.
- [x] Secret bootstrap explicitly confirmed and completed: current LDAP bind
  verified, three Secrets created, repeated execution preserved all three.
- [ ] Server maintenance completed.
- [ ] STF/RethinkDB manifests and image verified.
- [ ] GitOps source switched and STF functional checks passed.
- [ ] Old MongoDB/iOS resources removed and final state documented.

## Server maintenance

1. Inspect SSH/sudo, OS releases, disk/memory, package holds, repositories,
   pending upgrades, reboot-required flags, k3s service arguments and datastore
   type. Proxmox host updates are excluded by the user.
2. Preserve the k3s configuration/token/datastore and LDAP persistent data
   before host maintenance. MongoDB data does not need a backup. Identify the
   correct datastore backup procedure; do not assume embedded etcd.
3. Resolve an explicit supported k3s version from official releases. Default to
   the latest patch in the existing 1.35 branch; do not downgrade or skip minor
   versions. Retain all current installation options and systemd configuration.
4. Check the Grid for active sessions, stop affected work, and coordinate Argo
   automatic reconciliation. Cordon/drain with awareness of local PVC affinity
   and USB workloads; do not force-delete persistent data to make drain succeed.
5. Update OS packages within Ubuntu 26.04 and k3s on the control server first.
   Reboot if required, wait for SSH/API/Ready/DNS/ingress, then uncordon.
6. Repeat for the Android worker, then the storage worker, checking services
   after each node. Do not treat storage-bound Pending pods as movable workloads.
7. Record before/after package/kernel/k3s versions and repeat node, LDAP, ADB,
   Grid and ingress checks before application migration.

Official references: [k3s manual upgrades](https://docs.k3s.io/upgrades/manual)
and [Kubernetes node drain](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/).

## Application rollout

1. Sanitize and commit the copied `kuber` tree. Remove active iOS bridges and
   scripts. Exclude deployment resources from Docker/npm packaging. Use
   separately bootstrapped Kubernetes Secrets; publish references, not values.
2. Build/publish `ghcr.io/mdub1na/stf` from `develop` with a full commit SHA tag.
   Verify an amd64 build and node pull access; pin deployment images by digest.
3. Replace the MongoDB slice with internal-only RethinkDB, local-path PVC on
   the storage worker, readiness checks and a successful `stf migrate` Job.
   Apply the PVC and StatefulSet in the same sync wave so WaitForFirstConsumer
   volume binding does not deadlock the application.
4. Correct STF CLI/environment contracts, shared authentication secret,
   LDAP settings, messaging connections, storage URLs and provider commands.
   Verify all rendered manifests before any synchronization.
5. Fix HTTP/static/auth/storage/WebSocket routing and preserve dynamic screen
   forwarding. Check public TLS without disabling certificate verification.
6. Push prepared commits to `develop`. Suspend affected auto-sync policies for
   the cutover, update project/source permissions and the existing root app,
   and ensure only one Application owns each existing resource.
7. Synchronize database/migration first and wait for success. Then synchronize
   STF core, providers and routing. Root sync-wave numbers alone do not prove
   that a child application's workloads or database are ready.
8. Verify LDAP login, devices from both pools, screen/touch, capture/release,
   APK install, authenticated standard STF API and the unchanged Appium Grid.
   If devices are disconnected, report that functional gate as pending.
9. Delete the old MongoDB Application/workloads/PVC and iOS bridges, without
   preserving MongoDB data. Remove stale source references, restore intended
   auto-sync policies, and confirm repeatable Synced/Healthy reconciliation.
10. Update architecture, access inventory, README and decision log; push final
    commits and report completed checks and remaining blockers. Java clients
    using `/api/v1/autotests` remain incompatible until their separate adaptation.
