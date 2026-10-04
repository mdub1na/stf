# Original DeviceHub Roadmap

Historical reference. The current implementation plan is
[STF GitOps rollout](./stf-rollout-plan.md), including server maintenance.

## Phase 1 rollout order

1. Prepare nodes
   - verify node health
   - apply node labels
   - verify Android USB passthrough path

2. Create namespaces
   - `argocd`
   - `mongodb`
   - `openldap`
   - `devicehub`
   - `appium`
   - `mitmproxy`
   - `observability`

3. Prepare storage on `k3s-worker-2`
   - `mongodb` PVC `5Gi`
   - `openldap` PVC `1Gi`
   - `devicehub-storage-temp` PVC `5Gi`

4. Deploy `Argo CD`

5. Deploy `MongoDB`
   - `mongodb`
   - `mongodb-init`
   - `devicehub-migrate`

6. Deploy `OpenLDAP`
   - `openldap`
   - `phpldapadmin`
   - temporary: keep `LDAP_ADMIN_PASSWORD` in plain manifest (move to Kubernetes Secret later)

7. Deploy DeviceHub core
   - singleton control services
   - `devicehub-storage-temp`
   - initial replicas for scalable services

8. Deploy Android execution pair
   - `adbd`
   - `devicehub-provider`

9. Deploy `Appium Grid`
   - control plane
   - Android Appium nodes

10. Deploy `mitmproxy`
    - `mitmproxy`
    - `mitmweb`

11. Deploy observability
    - `prometheus`
    - `grafana`
    - `loki`
    - `promtail`
    - `alertmanager`

12. Configure ingress and HTTPS
    - DeviceHub
    - `phpldapadmin`
    - Appium Grid
    - `mitmweb`
    - Argo CD
    - `cert-manager`
    - Let's Encrypt certificates

13. Later hardening
    - Argo CD IP whitelist (allow only trusted public IP ranges)
    - enable TLS for OpenLDAP and secure ldap admin access paths
    - move plaintext credentials into Kubernetes Secret / sealed secret flow

## Backlog (after baseline stabilization)

- add explicit liveness/readiness/startup health checks for platform services (`argocd-config`, `openldap`) and DeviceHub services
- define and apply per-service `resources.requests` / `resources.limits` for all core workloads
- write a dedicated runbook for manual `ios-provider` startup and operations (macOS prerequisites, Xcode/WDA signing, `idb`, troubleshooting)

## Validation checkpoints

- MongoDB is healthy and persistent
- OpenLDAP and phpLDAPadmin are working
- DeviceHub authenticates against LDAP
- Android devices are visible through the provider
- browser-based manual testing works
- Android automation works through Appium Grid
- `mitmproxy` works for supported traffic interception flows
- observability stack is collecting metrics and logs
- public HTTPS ingress works for DeviceHub, phpLDAPadmin, Appium Grid, and Argo CD

## Sequencing rules

- do not deploy DeviceHub before MongoDB is ready
- do not wire LDAP auth before OpenLDAP is ready
- do not deploy `adbd` or `devicehub-provider` before Android node labels are applied
- do not expose new public ingress endpoints before their service is validated internally
