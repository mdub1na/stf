# Cluster Access And Service Inventory

Resource naming migration: 2026-10-15, Asia/Yekaterinburg. Original snapshot: 2026-10-05. Domain, GitLab OAuth and STF/Grid
checks were repeated during the login cutover; other infrastructure details retain the
2026-10-04 inventory baseline.

This document records access details after the Android STF GitOps rollout.
The cluster now deploys from `mdub1na/stf`, `develop`. Passwords, tokens, private
keys and kubeconfig certificate data are not copied here. Application resources use namespace `stf` and the `stf-` prefix. STF uses `stf.finservice.tech`;
Appium Grid moved to `appium-grid.finservice.tech` on 2026-10-18; other
service domains retain their recorded baseline.

## Repositories

| Purpose | Repository | Local directory |
| --- | --- | --- |
| Active STF development and deployment | `https://github.com/mdub1na/stf` | `/Users/mdub1na/IdeaProjects/stf` |

The live deployment source is STF `develop`; initial STF cutover revision was
`59aaafab05d759017e5017db659e0321bc3879a3`. The checkout has full Git history.
Its remotes are `origin=https://github.com/mdub1na/stf.git` and
`upstream=https://github.com/DeviceFarmer/stf.git`. The clone is self-contained;
deployment changes are developed in isolated worktrees.

## Kubernetes Access

Operational update on 2026-10-15: OpenLDAP and phpLDAPadmin are intentionally
disabled through zero replica overrides in their kustomization. The LDAP PVC
and credentials remain intact. LDAP Services have no ready endpoints; the
retained administration Ingress is unavailable. Re-enable the replicas through
GitOps before using LDAP or its initial secret-bootstrap script. See the
[upgrade and observability review](./cluster-upgrades-and-observability.md).

| Setting | Value |
| --- | --- |
| Distribution | k3s `v1.35.5+k3s1` |
| API server | `https://192.168.0.121:6443` |
| Local kubeconfig | `/absolute/path/to/k3s-lab.yaml` |
| Context / cluster / kubeconfig user | `default` / `default` / `default` |
| Authentication | Embedded client certificate and private key |
| Authorization check | `kubectl auth can-i '*' '*' --all-namespaces` returned `yes` |
| Local k3s join token file | `/absolute/path/to/node-token.txt` |

The join token is for adding k3s nodes; it is not the credential for `kubectl`.
Both local credential files have owner-only filesystem permissions (`0600`).

Execution checks on 2026-10-04: all three servers are
Ubuntu 26.04 LTS/amd64 with k3s v1.35.5+k3s1. The control/storage kernels are
7.0.0-30-generic; the Android worker is on 7.0.0-28-generic. The initial SSH
attempt as `mdub1na` on the control server was refused. Both ADB device lists
were empty before and after deployment. Argo CD is switched to STF. No OS/k3s
upgrade has been applied; the user will provide SSH access later. Deployment
first, maintenance later was explicitly confirmed.

```sh
export KUBECONFIG='/absolute/path/to/k3s-lab.yaml'
kubectl --request-timeout=15s get nodes -o wide
kubectl -n argocd get applications
kubectl get ingress -A
kubectl get svc -A
```

| Host | LAN address | Role | Verified state |
| --- | --- | --- | --- |
| `k3s-control` | `192.168.0.121` | Kubernetes control plane, ingress | `Ready` |
| `k3s-worker-1` | `192.168.0.122` | Android ADB/providers and Appium nodes | `Ready` |
| `k3s-worker-2` | `192.168.0.123` | Storage and Grid control plane | `Ready` |
| Proxmox | `192.168.0.110` | VM host, from infrastructure notes | Host access not tested |
| External Mac mini | `192.168.0.124` | Historical iOS host, now outside deployment scope | Host access not tested |

Proxmox's usual UI address is `https://192.168.0.110:8006`; the port and login were
not verified. SSH usernames, passwords and host-specific keys for these hosts
are not established by this inventory. Local SSH configuration is
`/Users/mdub1na/.ssh/config`. The local SSH default user for `192.168.0.121` is
`mdub1na`; the initial login was refused. Proxmox and Mac mini updates are
excluded from the maintenance scope. Removed iOS bridge configuration is not
evidence of working SSH access to the Mac.

## Public HTTPS Entry Points

The public ingress address is `46.191.173.144`; Traefik advertises LAN address
`192.168.0.121`. The new STF A-record was verified through authoritative REG.RU
DNS, public resolvers and Kubernetes. During cutover, the laptop resolver still
cached the former `136.115.23.98` answer. New-domain TLS verification passed
from Kubernetes and from the laptop using the correct IP without disabling
certificate validation. On 2026-10-05 at 13:55 local time, after the router cache
expired and the macOS DNS cache was flushed, a normal hostname request connected
to `46.191.173.144` with valid TLS and redirected to GitLab. Router/NAT
administration was not changed.

| Service | URL | Namespace / backend | HTTP check |
| --- | --- | --- | --- |
| STF UI | `https://stf.finservice.tech` | `stf`, `stf-app:3000` | Without a session, `/`: `302` to the STF login page (`200`); only `/auth/oauth/start` redirects to GitLab |
| GitLab identity provider | `https://gitlab.finservice.tech` | External OAuth/OIDC provider | HTTPS discovery and client authentication verified |
| Argo CD | `https://argocd.putmyhexon.ru` | `argocd`, `argocd-server:80` | `200` |
| phpLDAPadmin | `https://ldap.putmyhexon.ru` | `openldap`, `phpldapadmin:80` | Disabled; no backend pods |
| Appium / Selenium Grid | `https://appium-grid.finservice.tech` | `appium`, `appium-grid-router:4444` | `/status`: `200` |

Normal LDAP login was confirmed by the user after the initial deployment;
GitLab OAuth replaced it on 2026-10-05. GitLab login created the approved account;
only that account's role was changed to `admin`, with the original administrator
preserved. The user confirmed browser login and logout; administrator UI access awaits
confirmation.
OAuth callback/state/PKCE/cookie checks passed; Grid remains ready with 16 UP
nodes and zero sessions.
New-domain redirect, JS/logo loading,
WebSocket handshake, `/auth/contact` database access and temporary file
upload/download passed. An unauthenticated `GET /api/v1/devices` returned `401`.
An explicit authenticated REST API token request and connected-device test
execution remain unverified.

## Accounts And Credential Locations

| Access | Account / method | Credential location |
| --- | --- | --- |
| Kubernetes | Client certificate in `default` context | Local kubeconfig above |
| Argo CD | Built-in `admin` account | Initial password: Secret `argocd/argocd-initial-admin-secret`, key `password`; current password may have changed |
| LDAP administration | `CN=admin,DC=ldap,DC=putmyhexon,DC=ru` | Secret `openldap/openldap-credentials`, key `LDAP_ADMIN_PASSWORD`; existing LDAP bind verified |
| STF UI | GitLab user with `email_verified: true` | Sign in at GitLab; STF does not receive the GitLab password |
| STF GitLab OAuth client | Confidential OAuth application, scopes `openid profile email` | Secret `stf/stf-gitlab-oauth`, keys `STF_AUTH_OAUTH2_OAUTH_CLIENT_ID`, `STF_AUTH_OAUTH2_OAUTH_CLIENT_SECRET` |
| STF LDAP bind (rollback) | `CN=admin,DC=ldap,DC=putmyhexon,DC=ru` | Retained Secret `stf/stf-ldap-bind`, key `LDAP_BIND_CREDENTIALS` |
| STF REST API | `Authorization: Bearer <token>` | Generate a new token through STF Settings / Keys / Access Tokens; legacy platform tokens are not reused |
| STF service signing | Shared `SECRET` for app/auth/api/websocket | Secret `stf/stf-session`, key `SECRET` |
| Grid | No authentication configured in checked Grid manifests | `/status` was accessible without credentials |
| RethinkDB | No database password configured; internal driver access restricted by NetworkPolicy | `gitops/rethinkdb/rethinkdb-statefulset.yaml` and `rethinkdb-network-policy.yaml` |

LDAP settings: URL `ldap://openldap.openldap.svc.cluster.local:389`, base DN
`DC=ldap,DC=putmyhexon,DC=ru`, user search DN
`OU=users,DC=ldap,DC=putmyhexon,DC=ru`, search field `CN`. LDAP TLS is disabled in
the StatefulSet; public phpLDAPadmin HTTPS is a separate connection.

To display the Argo CD initial password locally, when needed:

```sh
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o go-template='{{.data.password | base64decode}}{{"\n"}}'
```

To display the configured LDAP administrator password locally:

```sh
kubectl -n openldap get secret openldap-credentials \
  -o go-template='{{index .data "LDAP_ADMIN_PASSWORD" | base64decode}}{{"\n"}}'
```

Only display secrets in a private terminal when required. The bootstrap script
verified the preserved LDAP administrator bind without printing its password.
Secrets are outside Git and need a separate secure disaster-recovery backup.

## LAN And Cluster-Internal Service Access

Cluster DNS names below are usable inside Kubernetes. For laptop access, use a
public ingress, a NodePort, or `kubectl port-forward`.

| Service | Cluster-internal endpoint | LAN / local alternative |
| --- | --- | --- |
| STF API | `stf-api.stf.svc.cluster.local:3000` | `https://stf.finservice.tech/api/v1` |
| STF auth | `stf-auth.stf.svc.cluster.local:3000` | `https://stf.finservice.tech/auth/oauth/` |
| STF WebSocket | `stf-websocket.stf.svc.cluster.local:3000` | `wss://stf.finservice.tech/socket.io/` |
| Device/provider proxy | `stf-dynamic-proxy.stf.svc.cluster.local:8080` | `https://stf.finservice.tech/d/` |
| APK / image / temp storage | `stf-storage-plugin-apk`, `stf-storage-plugin-image`, `stf-storage-temp` in `stf`, port `3000` | `/s/apk/`, `/s/image/`, `/s/` on the STF host |
| RethinkDB driver | `rethinkdb.rethinkdb.svc.cluster.local:28015`, database `stf` | Internal only; no public ingress or NodePort |
| OpenLDAP | `openldap.openldap.svc.cluster.local:389` | Port-forward local `1389` to `389` |
| ADB pool 1 | `adbd.stf.svc.cluster.local:5037` | Port-forward local `15037` to `5037` |
| ADB pool 2 | `adbd-2.stf.svc.cluster.local:5037` | Port-forward local `15038` to `5037` |
| Android provider 1 | `stf-provider.stf.svc.cluster.local:12010-12040` | STF `/d/stf-provider/<port>/` proxy |
| Android provider 2 | `stf-provider-2.stf.svc.cluster.local:12041-12070` | STF `/d/stf-provider-2/<port>/` proxy |
| App-side ZeroMQ | `stf-triproxy-app.stf.svc.cluster.local:7150,7160,7170` | Internal service |
| Device-side ZeroMQ | `stf-triproxy-dev.stf.svc.cluster.local:7250,7260,7270` | Internal service |

The old MongoDB namespace, PVC/PV, NodePort `32017`, iOS bridge Services,
Endpoints and NodePorts have been removed. STF API access to RethinkDB and all
six initialized tables were verified. WebSocket transport is supported;
Socket.IO polling is disabled by the application.

Run each long-running port-forward in its own terminal:

```sh
kubectl -n appium port-forward svc/appium-grid-router 4444:4444
kubectl -n argocd port-forward svc/argocd-server 8080:80
kubectl -n rethinkdb port-forward svc/rethinkdb 28015:28015
kubectl -n openldap port-forward svc/openldap 1389:389
kubectl -n stf port-forward svc/adbd 15037:5037
kubectl -n stf port-forward svc/adbd-2 15038:5037
```

For ADB diagnostics through the two local forwards:

```sh
adb -H 127.0.0.1 -P 15037 devices -l
adb -H 127.0.0.1 -P 15038 devices -l
```

The initial cutover had no connected Android phones. On 2026-10-18 both ADB
pools reported six phones in total, and real Appium Settings sessions passed
on each; see the [validation record](./appium-validation-2026-10-18.md).

## Appium Grid Layout

| Pool | Replicas | ADB server | Exposed UiAutomator2 system ports |
| --- | --- | --- | --- |
| `android-appium-node-1` | `4` | `adbd.stf.svc.cluster.local:5037` | `8200-8209` on `adbd` |
| `android-appium-node-2` | `3` | `adbd-2.stf.svc.cluster.local:5037` | `8200-8209` on `adbd-2` |

The upgraded pods contain Appium `appium/appium:v3.8.0-p1` (Node 24 LTS,
UiAutomator2 8.7.0), an ADB proxy, and Selenium relay
`selenium/node-base:4.51.0-20261010`, with Appium/Selenium pinned by digest. Relay listens on port `6666` and forwards to
Appium on pod-local port `4733`. Native and Chrome stereotypes share
`max-sessions = 1`; they are alternative capabilities, not two parallel sessions
per pod. Port ranges are scoped to each ADB server; concurrent sessions sharing
an ADB server need distinct `appium:systemPort` values.

On 2026-10-18 the operator requested seven Android nodes and three iOS nodes.
All three Linux iPhone runtimes now have an Appium sidecar and a dedicated
single-session Grid relay. Current capacity is **7 Android + 3 iOS**; all ten
nodes report UP. Generated resources and rollback are described in
[the node runbook](../appium-tests/ios-node/README.md).

The earlier Grid `/status` check returned `ready=true`, 16 nodes `UP` (8 per pool),
and zero active sessions. The control-plane services in namespace `appium` are:

| Service | Ports |
| --- | --- |
| `appium-grid-router` | `4444` |
| `appium-grid-distributor` | `5553` |
| `appium-grid-sessions` | `5556` |
| `appium-grid-session-queue` | `5559` |
| `appium-grid-event-bus` | `4442`, `4443` |

Kotlin/Gradle tests use standard STF capture/release endpoints; see
[`../appium-tests/README.md`](../appium-tests/README.md). Android Settings passed
18/18 sequential runs on six connected phones across both ADB pools on
2026-10-18. The initial Linux iOS sidecar/relay passed three final Grid runs with
concurrent STF viewing, followed by registration of the two other iPhones. See the
[validation record](./appium-validation-2026-10-18.md).

Appium reconciliation is temporarily paused with the Application annotation
`argocd.argoproj.io/skip-reconcile: "true"` while the capacity and ingress changes
are pending in the Appium PR. This prevents `develop` from restoring 16 Android
nodes. After merging the PR, remove this annotation from `argocd/appium` and
verify synchronization, seven Android replicas and three private iOS relays.
The iOS preview resources are applied separately, outside the Appium GitOps tree.

## Argo CD And Installed Components

The ingress points to Argo CD in namespace `argocd`. A second Argo CD installation
also exists in namespace `default`; do not confuse its Secrets or services with
the installation behind `argocd.putmyhexon.ru`.

Every Application below currently uses
`https://github.com/mdub1na/stf.git`, revision `develop`:

| Application | Source path | Sync / health at inspection | Automatic sync |
| --- | --- | --- | --- |
| `stf-root` | `kuber/gitops/root` | Synced / Healthy | prune + self-heal |
| `argocd-config` | `kuber/gitops/argocd` | Synced / Healthy | prune + self-heal |
| `traefik` | `kuber/gitops/traefik` | Synced / Healthy | prune + self-heal |
| `cert-manager` | `kuber/gitops/cert-manager` | Synced / Healthy | prune + self-heal |
| `rethinkdb` | `kuber/gitops/rethinkdb` | Synced / Healthy | Manual |
| `openldap` | `kuber/gitops/openldap` | Synced / Healthy | prune + self-heal |
| `stf` | `kuber/gitops/stf-gitlab` | Synced / Healthy | Manual |
| `appium` | `kuber/gitops/appium` | Synced / Healthy | prune + self-heal |
| `mitmproxy` | `kuber/gitops/mitmproxy` | Synced / Healthy | prune + self-heal |
| `observability` | `kuber/gitops/observability` | Synced / Healthy | prune + self-heal |

`mitmproxy` and `observability` currently contain namespace-only manifests; no
mitmproxy, Grafana, Prometheus, Loki or Alertmanager workloads or services were
found in the live workload/service inventory. Their presence as healthy Argo CD
Applications does not mean those products are deployed.

Live main images: STF `ghcr.io/mdub1na/stf` pinned to the verified digest in
[the deployment runbook](./stf-deployment.md), RethinkDB `rethinkdb:2.4.2`,
OpenLDAP `osixia/openldap:1.5.0`, phpLDAPadmin
`osixia/phpldapadmin:0.9.0` (both LDAP workloads paused), active Argo CD `v3.5.5`,
Traefik `v3.6.25`, cert-manager `v1.20.4`, Selenium Grid `4.51.0-20261010` and
NGINX `1.30.6-alpine`. See [the component rollout](./cluster-upgrade-rollout.md)
for checks and scope. K3s remains 1.35.5+k3s1 by user request; bundled CoreDNS,
metrics-server and local-path-provisioner are unchanged.

Persistent volumes use `local-path`, with these PVCs all `Bound`:

| Namespace | PVC | Capacity |
| --- | --- | --- |
| `rethinkdb` | `rethinkdb-data` | `5Gi` |
| `openldap` | `openldap-data-pvc` | `1Gi` |
| `stf` | `stf-storage-temp-pvc` | `5Gi` |

The STF Certificate `stf-finservice-tech-tls` is `Ready=True`, expiring on
2027-01-03. Other ingress Certificates were Ready with expiration on 2027-01-02
at the original inventory check.
Their TLS Secrets are `appium/appium-grid-putmyhexon-ru-tls`,
`argocd/argocd-putmyhexon-ru-tls`, `stf/stf-finservice-tech-tls` and
`openldap/ldap-putmyhexon-ru-tls`. ACME issuer/account key name in each ingress
namespace is `letsencrypt-http` / `letsencrypt-http-account-key`.

## Remaining Access And Validation Gates

- SSH/sudo access to the three Kubernetes servers is deferred. No host update,
  reboot, Proxmox change or Mac mini change was performed during STF deployment.
- Connected-device screen/touch, capture/release and APK tests await Android
  devices. Both ADB/provider pairs and the 16-node Grid are reachable.
- A new authenticated STF API token check and Java client adaptation remain
  separate tasks; legacy allocation APIs and old tokens are not compatible.
- Back up k3s, LDAP, RethinkDB and the bootstrapped Secrets before maintenance.
  The kubeconfig and join token stay outside the repository.
- Router/NAT administration and external host credentials remain unverified.

## Source Files

- `../README.md`, `requirements.md`, `architecture.md`
- `../gitops/stf/stf-configmap.yaml`
- `../gitops/stf/stf-ingress.yaml`
- `../gitops/stf/stf-android-services.yaml`
- `../gitops/openldap/openldap-statefulset.yaml`
- `../gitops/rethinkdb/rethinkdb-statefulset.yaml`
- `../gitops/rethinkdb/rethinkdb-network-policy.yaml`
- `../gitops/appium/android-appium-node-config.yaml`
- `../scripts/bootstrap-stf-secrets.mjs`
- Live `kubectl` node, Service, Ingress, workload, PVC, Application, Secret metadata
  and Certificate queries; Grid `/status`; unauthenticated HTTPS status checks.
