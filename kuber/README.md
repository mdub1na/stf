# STF Kubernetes Deployment

This directory contains the GitOps migration from DeviceHub to Android STF on
the existing Proxmox/k3s infrastructure. iOS is excluded from this rollout.
Historical `devicehub` service names are retained to preserve ADB and Appium
connectivity. The farm's public address is <https://stf.finservice.tech>;
Argo CD, LDAP administration and Appium Grid retain their existing domains.

STF was deployed on 2026-10-04; its public domain was changed on 2026-10-05. All ten
Argo CD Applications now use this repository's `develop` branch and are
Synced/Healthy. GitLab OAuth login was deployed on 2026-10-05; its redirect and
security checks passed, and the user confirmed browser login. The approved
account was explicitly promoted to administrator; its role was verified in the
database, while administrator UI access awaits confirmation. The LDAP base
remains available for rollback; the 16-node Appium Grid is unchanged.
Device-specific checks await connected Android devices. See the rollout plan
for verified results and pending work.

## Documents

- [Current requirements](./docs/requirements.md)
- [Current architecture](./docs/architecture.md)
- [Cluster access and service inventory](./docs/cluster-access.md)
- [STF rollout and server maintenance plan](./docs/stf-rollout-plan.md)
- [STF deployment runbook](./docs/stf-deployment.md)
- [Historical DeviceHub roadmap](./docs/roadmap.md)
- [GitOps layout](./docs/gitops-layout.md)
- [Decision log](./docs/decision-log.md)

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
- iOS execution is a separate future project; no Mac mini changes are included.
- Main Kubernetes namespaces:
  - `devicehub`
  - `rethinkdb`
  - `appium`
  - `openldap`
  - `mitmproxy`
  - `observability`
- Selected platform stack:
  - `Traefik`
  - `cert-manager + Let's Encrypt`
  - `Prometheus + Grafana`
  - `Loki + Promtail`
  - `Alertmanager`
- `Argo CD` is used as the GitOps deployment layer for Kubernetes workloads.

## Next focus

- confirm administrator UI access with the approved account; browser login is
  confirmed and its database role is `admin`; retain the LDAP base until confirmed
- keep GitOps documentation aligned with the live manifests
- verify screen/touch, capture/release and APK installation with connected Android devices
- adapt the copied Java tests from DeviceHub-specific APIs to standard STF APIs
- update the three Kubernetes servers after SSH access is provided
- implement the reserved `mitmproxy` and `observability` slices when we are ready for those layers
- back up the bootstrapped Secrets outside Git and evaluate encrypted GitOps secret management
