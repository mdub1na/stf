# STF Kubernetes Deployment

This directory contains the STF GitOps deployment on the existing Proxmox/k3s
infrastructure. Android resources are managed by the overlays here. Linux iOS
runtimes and their Appium relays are configured separately for each phone.
Application workloads, services and node role labels use the `stf` name. The farm's public address is <https://stf.finservice.tech>;
Appium Grid uses <https://appium-grid.finservice.tech>; Argo CD and the retained
LDAP administration ingress keep their existing domains.

Argo CD Applications use this repository's `develop` branch. STF uses GitLab
OAuth; OpenLDAP and phpLDAPadmin remain scaled to zero, with data and credentials
preserved for rollback. The Appium overlay configures seven Android relays
(four and three across the ADB pools). Each Linux iPhone needs a separate Appium
sidecar and device-bound relay. Configured capacity and connected-device
availability are separate checks; see the service inventory and node runbook.

The optional `stf coordinator` process queues device requests and renews leases
for trusted workers. Its [deployment](coordinator/README.md) is separate from
the GitOps root.

## Documents

- [Current requirements](./docs/requirements.md)
- [Current architecture](./docs/architecture.md)
- [Cluster access and service inventory](./docs/cluster-access.md)
- [Appium client and smoke checks](./appium-tests/README.md)
- [Linux iOS Appium node setup and rollback](./appium-tests/ios-node/README.md)
- [Cluster upgrade and observability review](./docs/cluster-upgrades-and-observability.md)
- [Component upgrade rollout](./docs/cluster-upgrade-rollout.md)
- [STF rollout and server maintenance plan](./docs/stf-rollout-plan.md)
- [STF deployment runbook](./docs/stf-deployment.md)
- [Historical STF roadmap](./docs/roadmap.md)
- [GitOps layout](./docs/gitops-layout.md)
- [Decision log](./docs/decision-log.md)
- [Linux iOS provider](../doc/ios-provider.md)
- [Local iOS setup and signing](../docker/ios/README.md)
- [Kubernetes iPhone fleet](./ios-prototype/README.md)
- [Device lease coordinator](../doc/coordinator.md)

## Reading order for implementation

1. `requirements.md`
2. `architecture.md`
3. `stf-rollout-plan.md`
4. `gitops-layout.md`

Use `decision-log.md` only for background reasoning and past choices.

## Bootstrap quick start

For a new cluster only; do not reinstall Argo CD on the existing cluster.
For migration, follow the rollout plan and deployment runbook instead.

1. Apply Argo CD install manifests:
   `kubectl apply -k kuber/gitops/bootstrap/argocd`
2. Apply root app:
   `kubectl apply -f kuber/gitops/bootstrap/root-app.yaml`
3. Confirm Argo CD applications:
   `kubectl -n argocd get applications`

## Current decisions

- Kubernetes cluster:
  - `k3s-control` - `192.168.0.121`
  - `k3s-worker-1` - `192.168.0.122`
  - `k3s-worker-2` - `192.168.0.123`
- Android devices will be connected to the Proxmox host and passed through into one dedicated Android worker VM.
- Linux iOS runtime and Appium resources are configured separately; WDA signing remains external to the Linux node.
- Main Kubernetes namespaces:
  - `stf`
  - `rethinkdb`
  - `appium`
  - `openldap`
  - `mitmproxy`
  - `observability`
- Selected platform stack:
  - `Traefik`
  - `cert-manager + Let's Encrypt`
  - `Prometheus + Grafana`
  - `Loki + Grafana Alloy` (proposed; observability is not deployed yet)
  - `Alertmanager`
- `Argo CD` is used as the GitOps deployment layer for Kubernetes workloads.

## Next focus

- confirm administrator UI access with the approved account; browser login is
  confirmed and its database role is `admin`; LDAP stays paused unless explicitly re-enabled
- keep GitOps documentation aligned with the live manifests
- verify screen/touch, capture/release and APK installation with connected Android devices
- keep per-phone iOS relay configuration aligned with the installed iOS version
  and verify Appium cleanup without replacing the STF WDA session
- update the three Kubernetes servers after SSH access is provided
- implement the reserved `mitmproxy` and `observability` slices when we are ready for those layers
- follow the upgrade and observability review for measured capacity and staged version candidates
- back up the bootstrapped Secrets outside Git and evaluate encrypted GitOps secret management
