# STF Kubernetes Deployment

This directory contains the Android STF GitOps deployment on
the existing Proxmox/k3s infrastructure. iOS is excluded from this rollout.
Application workloads, services and node role labels use the `stf` name. The farm's public address is <https://stf.finservice.tech>;
Appium Grid uses <https://appium-grid.finservice.tech>; Argo CD and the retained
LDAP administration ingress keep their existing domains.

STF was deployed on 2026-10-04; its public domain was changed on 2026-10-05. All ten
Argo CD Applications now use this repository's `develop` branch and are
Synced/Healthy. GitLab OAuth login was deployed on 2026-10-05; its redirect and
security checks passed, and the user confirmed browser login and logout. The approved
account was explicitly promoted to administrator; its role was verified in the
database, while administrator UI access awaits confirmation. OpenLDAP and
phpLDAPadmin are intentionally scaled to zero since 2026-10-15; their data and
credentials are preserved for a deliberate rollback. The Grid has 16 Android nodes plus one validated Linux iOS relay.
Android Settings smoke passed on all six connected phones. One Linux iPhone
also passed Appium Grid smoke with concurrent STF viewing; the other iPhones
are not yet registered with Grid. See the rollout plan
for verified results and pending work.

## Documents

- [Current requirements](./docs/requirements.md)
- [Current architecture](./docs/architecture.md)
- [Cluster access and service inventory](./docs/cluster-access.md)
- [Appium validation and remaining iOS work](./docs/appium-validation-2026-10-18.md)
- [Cluster upgrade and observability review](./docs/cluster-upgrades-and-observability.md)
- [Component upgrade rollout](./docs/cluster-upgrade-rollout.md)
- [STF rollout and server maintenance plan](./docs/stf-rollout-plan.md)
- [STF deployment runbook](./docs/stf-deployment.md)
- [Historical STF roadmap](./docs/roadmap.md)
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
- extend the validated single-phone iOS Appium setup when needed; Kotlin smoke
  tests use standard STF APIs, with Android 18/18 and iOS 3/3 final runs
- update the three Kubernetes servers after SSH access is provided
- implement the reserved `mitmproxy` and `observability` slices when we are ready for those layers
- follow the upgrade and observability review for measured capacity and staged version candidates
- back up the bootstrapped Secrets outside Git and evaluate encrypted GitOps secret management
