# Cluster Access And Service Inventory

Snapshot date: 2026-10-04, Asia/Yekaterinburg.

This document records access details after the Android STF GitOps rollout.
The cluster now deploys from `mdub1na/stf`, `develop`. Passwords, tokens, private
keys and kubeconfig certificate data are not copied here. Historical `devicehub`
service names and public domains are intentionally preserved.

## Repositories

| Purpose | Repository | Local directory |
| --- | --- | --- |
| Historical DeviceHub work | `https://github.com/mdub1na/devicehub` | `/Users/mdub1na/IdeaProjects/devicehub` |
| Active STF development and deployment | `https://github.com/mdub1na/stf` | `/Users/mdub1na/IdeaProjects/stf` |

The live deployment source is STF `develop`; controlled cutover revision was
`59aaafab05d759017e5017db659e0321bc3879a3`. The checkout has full Git history.
Its remotes are `origin=https://github.com/mdub1na/stf.git` and
`upstream=https://github.com/DeviceFarmer/stf.git`. The clone is self-contained;
it does not depend on the existing DeviceHub checkout for Git objects.

## Kubernetes Access

| Setting | Value |
| --- | --- |
| Distribution | k3s `v1.35.5+k3s1` |
| API server | `https://192.168.0.121:6443` |
| Local kubeconfig | `/Users/mdub1na/Desktop/devicehub home cluster/k3s-lab.yaml` |
| Context / cluster / kubeconfig user | `default` / `default` / `default` |
| Authentication | Embedded client certificate and private key |
| Authorization check | `kubectl auth can-i '*' '*' --all-namespaces` returned `yes` |
| Local k3s join token file | `/Users/mdub1na/Desktop/devicehub home cluster/node-token.txt` |

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
export KUBECONFIG='/Users/mdub1na/Desktop/devicehub home cluster/k3s-lab.yaml'
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

All four public hosts resolved to `46.191.173.144` during the checks. Their
ingresses use Traefik and advertise LAN address `192.168.0.121`. HTTPS certificate
verification succeeded for all four. Router/NAT administration was not checked.

| Service | URL | Namespace / backend | HTTP check |
| --- | --- | --- | --- |
| STF UI | `https://devicehub.putmyhexon.ru` | `devicehub`, `devicehub-app:3000` | `/`: `302` to LDAP; `/auth/ldap/`: `200` |
| Argo CD | `https://argocd.putmyhexon.ru` | `argocd`, `argocd-server:80` | `200` |
| phpLDAPadmin | `https://ldap.putmyhexon.ru` | `openldap`, `phpldapadmin:80` | `200` |
| Appium / Selenium Grid | `https://appium-grid.putmyhexon.ru` | `appium`, `appium-grid-router:4444` | `/status`: `200` |

Normal LDAP login was confirmed by the user after deployment. JS/logo loading,
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
| STF UI | LDAP user, searched by `CN` | User password in LDAP; normal login confirmed by the user, no password copied here |
| STF LDAP bind | `CN=admin,DC=ldap,DC=putmyhexon,DC=ru` | Secret `devicehub/devicehub-ldap-bind`, key `LDAP_BIND_CREDENTIALS` |
| STF REST API | `Authorization: Bearer <token>` | Generate a new token through STF Settings / Keys / Access Tokens; old DeviceHub tokens are not reused |
| STF service signing | Shared `SECRET` for app/auth/api/websocket | Secret `devicehub/devicehub-session`, key `SECRET` |
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
| STF API | `devicehub-api.devicehub.svc.cluster.local:3000` | `https://devicehub.putmyhexon.ru/api/v1` |
| STF auth | `devicehub-auth.devicehub.svc.cluster.local:3000` | `https://devicehub.putmyhexon.ru/auth/ldap/` |
| STF WebSocket | `devicehub-websocket.devicehub.svc.cluster.local:3000` | `wss://devicehub.putmyhexon.ru/socket.io/` |
| Device/provider proxy | `devicehub-dynamic-proxy.devicehub.svc.cluster.local:8080` | `https://devicehub.putmyhexon.ru/d/` |
| APK / image / temp storage | `devicehub-storage-plugin-apk`, `devicehub-storage-plugin-image`, `devicehub-storage-temp` in `devicehub`, port `3000` | `/s/apk/`, `/s/image/`, `/s/` on DeviceHub host |
| RethinkDB driver | `rethinkdb.rethinkdb.svc.cluster.local:28015`, database `stf` | Internal only; no public ingress or NodePort |
| OpenLDAP | `openldap.openldap.svc.cluster.local:389` | Port-forward local `1389` to `389` |
| ADB pool 1 | `adbd.devicehub.svc.cluster.local:5037` | Port-forward local `15037` to `5037` |
| ADB pool 2 | `adbd-2.devicehub.svc.cluster.local:5037` | Port-forward local `15038` to `5037` |
| Android provider 1 | `devicehub-provider.devicehub.svc.cluster.local:12010-12040` | STF `/d/devicehub-provider/<port>/` proxy |
| Android provider 2 | `devicehub-provider-2.devicehub.svc.cluster.local:12041-12070` | STF `/d/devicehub-provider-2/<port>/` proxy |
| App-side ZeroMQ | `devicehub-triproxy-app.devicehub.svc.cluster.local:7150,7160,7170` | Internal service |
| Device-side ZeroMQ | `devicehub-triproxy-dev.devicehub.svc.cluster.local:7250,7260,7270` | Internal service |

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
kubectl -n devicehub port-forward svc/adbd 15037:5037
kubectl -n devicehub port-forward svc/adbd-2 15038:5037
```

For ADB diagnostics through the two local forwards:

```sh
adb -H 127.0.0.1 -P 15037 devices -l
adb -H 127.0.0.1 -P 15038 devices -l
```

Both new STF providers reached their corresponding ADB servers successfully;
both returned an empty device list. No actual Appium session was run after
cutover because no Android device is connected.

## Appium Grid Layout

| Pool | Replicas | ADB server | Exposed UiAutomator2 system ports |
| --- | --- | --- | --- |
| `android-appium-node-1` | `8` | `adbd.devicehub.svc.cluster.local:5037` | `8200-8209` on `adbd` |
| `android-appium-node-2` | `8` | `adbd-2.devicehub.svc.cluster.local:5037` | `8200-8209` on `adbd-2` |

Each pod contains Appium `appium/appium:v2.11.4-p2`, an ADB proxy, and Selenium
relay `selenium/node-base:4.39.0`. Relay listens on port `6666` and forwards to
Appium on pod-local port `4733`. Native and Chrome stereotypes share
`max-sessions = 1`; they are alternative capabilities, not two parallel sessions
per pod. Port ranges are scoped to each ADB server; concurrent sessions sharing
an ADB server need distinct `appium:systemPort` values.

The live Grid `/status` check returned `ready=true`, 16 nodes `UP` (8 per pool),
and zero active sessions. The control-plane services in namespace `appium` are:

| Service | Ports |
| --- | --- |
| `appium-grid-router` | `4444` |
| `appium-grid-distributor` | `5553` |
| `appium-grid-sessions` | `5556` |
| `appium-grid-session-queue` | `5559` |
| `appium-grid-event-bus` | `4442`, `4443` |

Historical Java/Gradle tests and their old DeviceHub setup are in
[`../appium-tests/README.md`](../appium-tests/README.md). Their
`/api/v1/autotests` allocation API is absent from STF and must be adapted before
these tests can validate the new deployment.

## Argo CD And Installed Components

The ingress points to Argo CD in namespace `argocd`. A second Argo CD installation
also exists in namespace `default`; do not confuse its Secrets or services with
the installation behind `argocd.putmyhexon.ru`.

Every Application below currently uses
`https://github.com/mdub1na/stf.git`, revision `develop`:

| Application | Source path | Sync / health at inspection | Automatic sync |
| --- | --- | --- | --- |
| `devicehub-root` | `kuber/gitops/root` | Synced / Healthy | prune + self-heal |
| `argocd-config` | `kuber/gitops/argocd` | Synced / Healthy | prune + self-heal |
| `traefik` | `kuber/gitops/traefik` | Synced / Healthy | prune + self-heal |
| `cert-manager` | `kuber/gitops/cert-manager` | Synced / Healthy | prune + self-heal |
| `rethinkdb` | `kuber/gitops/rethinkdb` | Synced / Healthy | Manual |
| `openldap` | `kuber/gitops/openldap` | Synced / Healthy | prune + self-heal |
| `devicehub` | `kuber/gitops/devicehub` | Synced / Healthy | Manual |
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
`osixia/phpldapadmin:0.9.0`, Argo CD `v3.4.2`, Traefik `v3.6.12`, cert-manager
`v1.20.1`, Selenium Grid `4.39.0`. CoreDNS, metrics-server and local-path-provisioner
are also installed.

Persistent volumes use `local-path`, with these PVCs all `Bound`:

| Namespace | PVC | Capacity |
| --- | --- | --- |
| `rethinkdb` | `rethinkdb-data` | `5Gi` |
| `openldap` | `openldap-data-pvc` | `1Gi` |
| `devicehub` | `devicehub-storage-temp-pvc` | `5Gi` |

The four ingress Certificates are `Ready=True`, with expiration on 2027-01-02.
Their TLS Secrets are `appium/appium-grid-putmyhexon-ru-tls`,
`argocd/argocd-putmyhexon-ru-tls`, `devicehub/devicehub-putmyhexon-ru-tls` and
`openldap/ldap-putmyhexon-ru-tls`. ACME issuer/account key name in each ingress
namespace is `letsencrypt-http` / `letsencrypt-http-account-key`.

## Remaining Access And Validation Gates

- SSH/sudo access to the three Kubernetes servers is deferred. No host update,
  reboot, Proxmox change or Mac mini change was performed during STF deployment.
- Connected-device screen/touch, capture/release and APK tests await Android
  devices. Both ADB/provider pairs and the 16-node Grid are reachable.
- A new authenticated STF API token check and Java client adaptation remain
  separate tasks; DeviceHub-specific APIs and old tokens are not compatible.
- Back up k3s, LDAP, RethinkDB and the bootstrapped Secrets before maintenance.
  The kubeconfig and join token stay outside the repository.
- Router/NAT administration and external host credentials remain unverified.

## Source Files

- `../README.md`, `requirements.md`, `architecture.md`
- `../gitops/devicehub/devicehub-configmap.yaml`
- `../gitops/devicehub/devicehub-ingress.yaml`
- `../gitops/devicehub/devicehub-android-services.yaml`
- `../gitops/openldap/openldap-statefulset.yaml`
- `../gitops/rethinkdb/rethinkdb-statefulset.yaml`
- `../gitops/rethinkdb/rethinkdb-network-policy.yaml`
- `../gitops/appium/android-appium-node-config.yaml`
- `../scripts/bootstrap-stf-secrets.mjs`
- Live `kubectl` node, Service, Ingress, workload, PVC, Application, Secret metadata
  and Certificate queries; Grid `/status`; unauthenticated HTTPS status checks.
