# Cluster Access And Service Inventory

Snapshot date: 2026-10-04, Asia/Yekaterinburg.

This document records access details for the existing DeviceHub cluster before
moving deployment work to `mdub1na/stf`. Live checks were read-only. Passwords,
tokens, private keys and kubeconfig certificate data are not copied here.

## Repositories

| Purpose | Repository | Local directory |
| --- | --- | --- |
| Existing deployment work | `https://github.com/mdub1na/devicehub` | `/Users/mdub1na/IdeaProjects/devicehub` |
| New STF development | `https://github.com/mdub1na/stf` | `/Users/mdub1na/IdeaProjects/stf` |

The deployment source is currently the `kuber` branch of `devicehub`. Its latest
commit affecting `kuber/` at inspection was `8bf427a2`. Copying files into STF does
not switch the running cluster to that repository.

The new STF checkout is on `master` at `be79c0c9`, with a clean working tree and
full Git history. Its remotes are `origin=https://github.com/mdub1na/stf.git` and
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

Execution preflight on 2026-10-04: the STF checkout is now on `develop` and has
local migration changes, not a clean `master` checkout. All three servers are
Ubuntu 26.04 LTS/amd64 with k3s v1.35.5+k3s1. The control/storage kernels are
7.0.0-30-generic; the Android worker is on 7.0.0-28-generic. The initial SSH
attempt as `mdub1na` on the control server was refused. Both ADB device lists
were empty. No OS/k3s upgrade or Argo CD source change has been applied.
Follow the current STF rollout plan rather than the historical migration notes
at the end of this inventory.

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
| External Mac mini | `192.168.0.124` | iOS provider, from bridge configuration | Host access not tested |

Proxmox's usual UI address is `https://192.168.0.110:8006`; the port and login were
not verified. SSH usernames, passwords and host-specific keys for these hosts
are not established by this inventory. Local SSH configuration is
`/Users/mdub1na/.ssh/config`. The local SSH default user for `192.168.0.121` is
`mdub1na`, but successful login with that user was not tested. The iOS launcher
references `/Users/alfafermer/IdeaProjects/devicehub` on the Mac; this is a path
from configuration, not confirmation of SSH access as `alfafermer`.

## Public HTTPS Entry Points

All four public hosts resolved to `46.191.173.144` during the checks. Their
ingresses use Traefik and advertise LAN address `192.168.0.121`. HTTPS certificate
verification succeeded for all four. Router/NAT administration was not checked.

| Service | URL | Namespace / backend | HTTP check |
| --- | --- | --- | --- |
| DeviceHub UI | `https://devicehub.putmyhexon.ru` | `devicehub`, `devicehub-app:3000` | `200` |
| Argo CD | `https://argocd.putmyhexon.ru` | `argocd`, `argocd-server:80` | `200` |
| phpLDAPadmin | `https://ldap.putmyhexon.ru` | `openldap`, `phpldapadmin:80` | `200` |
| Appium / Selenium Grid | `https://appium-grid.putmyhexon.ru` | `appium`, `appium-grid-router:4444` | `/status`: `200` |

These were unauthenticated HTTP checks, not full UI login or test execution.
An unauthenticated `GET /api/v1/devices` returned `302`; an authenticated API
request was not tested in this inventory.

## Accounts And Credential Locations

| Access | Account / method | Credential location |
| --- | --- | --- |
| Kubernetes | Client certificate in `default` context | Local kubeconfig above |
| Argo CD | Built-in `admin` account | Initial password: Secret `argocd/argocd-initial-admin-secret`, key `password`; current password may have changed |
| LDAP administration | `CN=admin,DC=ldap,DC=putmyhexon,DC=ru` | `LDAP_ADMIN_PASSWORD` in `gitops/openldap/openldap-statefulset.yaml` and the OpenLDAP container environment |
| DeviceHub UI | LDAP user, searched by `CN` | User password in LDAP; no user's current password was retrieved |
| DeviceHub LDAP bind | `CN=admin,DC=ldap,DC=putmyhexon,DC=ru` | `LDAP_BIND_CREDENTIALS` in ConfigMap `devicehub/devicehub-env`, source `gitops/devicehub/devicehub-configmap.yaml` |
| DeviceHub REST API | `Authorization: Bearer <token>` | Generate/manage through DeviceHub Settings / Keys / Access Tokens; no current token was validated |
| DeviceHub service signing | Shared application secrets | Keys `STF_SECRET`, `STF_APP_SECRET`, `STF_AUTH_LDAP_SECRET` in the same ConfigMap |
| Grid | No authentication configured in checked Grid manifests | `/status` was accessible without credentials |
| MongoDB | No username/password or `--auth` configured in checked manifests | `gitops/mongodb/mongodb-statefulset.yaml`; authenticated access was not tested |

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
kubectl -n openldap exec openldap-0 -- printenv LDAP_ADMIN_PASSWORD
```

The latter is the configured startup value; password changes persisted in LDAP
can make it differ from the current password. Live login was not attempted.

## LAN And Cluster-Internal Service Access

Cluster DNS names below are usable inside Kubernetes. For laptop access, use a
public ingress, a NodePort, or `kubectl port-forward`.

| Service | Cluster-internal endpoint | LAN / local alternative |
| --- | --- | --- |
| DeviceHub API | `devicehub-api.devicehub.svc.cluster.local:3000` | `https://devicehub.putmyhexon.ru/api/v1` |
| DeviceHub auth | `devicehub-auth.devicehub.svc.cluster.local:3000` | `https://devicehub.putmyhexon.ru/auth/ldap/` |
| DeviceHub WebSocket | `devicehub-websocket.devicehub.svc.cluster.local:3000` | `https://devicehub.putmyhexon.ru/socket.io/` |
| Device/provider proxy | `devicehub-dynamic-proxy.devicehub.svc.cluster.local:8080` | `https://devicehub.putmyhexon.ru/d/` |
| APK / image / temp storage | `devicehub-storage-plugin-apk`, `devicehub-storage-plugin-image`, `devicehub-storage-temp` in `devicehub`, port `3000` | `/s/apk/`, `/s/image/`, `/s/` on DeviceHub host |
| MongoDB | `devicehub-mongo.mongodb.svc.cluster.local:27017` | NodePort `32017`, used at `192.168.0.123:32017` by the Mac launcher |
| OpenLDAP | `openldap.openldap.svc.cluster.local:389` | Port-forward local `1389` to `389` |
| ADB pool 1 | `adbd.devicehub.svc.cluster.local:5037` | Port-forward local `15037` to `5037` |
| ADB pool 2 | `adbd-2.devicehub.svc.cluster.local:5037` | Port-forward local `15038` to `5037` |
| Android provider 1 | `devicehub-provider.devicehub.svc.cluster.local:12010-12040` | DeviceHub `/d/devicehub-provider/<port>/` proxy |
| Android provider 2 | `devicehub-provider-2.devicehub.svc.cluster.local:12041-12070` | DeviceHub `/d/devicehub-provider-2/<port>/` proxy |
| App-side ZeroMQ | `devicehub-triproxy-app.devicehub.svc.cluster.local:7150,7160,7170` | Internal service |
| Device-side ZeroMQ | `devicehub-triproxy-dev.devicehub.svc.cluster.local:7250,7260,7270` | iOS bridge NodePorts below |
| iOS ZeroMQ subscribe | `devicehub-ios-bridge-triproxy-dev.devicehub.svc.cluster.local:7250` | NodePort `31250`, launcher uses `192.168.0.121:31250` |
| iOS ZeroMQ push | Same service, port `7270` | NodePort `31270`, launcher uses `192.168.0.121:31270` |
| iOS APK storage bridge | `devicehub-ios-bridge-storage-apk.devicehub.svc.cluster.local:3000` | NodePort `31300` |
| iOS provider bridge | `ios-provider.devicehub.svc.cluster.local:18000-18009,18200-18209` | Configured external endpoint `192.168.0.124` |

MongoDB replica set name is `devicehub-rs`. The checked connection string is
`mongodb://192.168.0.123:32017/?directConnection=true`. NodePort existence was
verified; database login and Mac connectivity were not tested.

Run each long-running port-forward in its own terminal:

```sh
kubectl -n appium port-forward svc/appium-grid-router 4444:4444
kubectl -n argocd port-forward svc/argocd-server 8080:80
kubectl -n mongodb port-forward svc/devicehub-mongo 27017:27017
kubectl -n openldap port-forward svc/openldap 1389:389
kubectl -n devicehub port-forward svc/adbd 15037:5037
kubectl -n devicehub port-forward svc/adbd-2 15038:5037
```

For ADB diagnostics through the two local forwards:

```sh
adb -H 127.0.0.1 -P 15037 devices -l
adb -H 127.0.0.1 -P 15038 devices -l
```

Device visibility and actual Appium sessions were not tested during collection.

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

Existing Java/Gradle tests and detailed test setup are in
[`../appium-tests/README.md`](../appium-tests/README.md).

## Argo CD And Installed Components

The ingress points to Argo CD in namespace `argocd`. A second Argo CD installation
also exists in namespace `default`; do not confuse its Secrets or services with
the installation behind `argocd.putmyhexon.ru`.

Every Application below currently uses
`https://github.com/mdub1na/devicehub.git`, revision `kuber`:

| Application | Source path | Sync / health at inspection | Automatic sync |
| --- | --- | --- | --- |
| `devicehub-root` | `kuber/gitops/root` | Synced / Healthy | prune + self-heal |
| `argocd-config` | `kuber/gitops/argocd` | Synced / Healthy | prune + self-heal |
| `traefik` | `kuber/gitops/traefik` | Synced / Healthy | prune + self-heal |
| `cert-manager` | `kuber/gitops/cert-manager` | Synced / Healthy | prune + self-heal |
| `mongodb` | `kuber/gitops/mongodb` | OutOfSync / Healthy | prune + self-heal |
| `openldap` | `kuber/gitops/openldap` | Synced / Healthy | prune + self-heal |
| `devicehub` | `kuber/gitops/devicehub` | Synced / Healthy | Manual |
| `appium` | `kuber/gitops/appium` | Synced / Healthy | prune + self-heal |
| `mitmproxy` | `kuber/gitops/mitmproxy` | Synced / Healthy | prune + self-heal |
| `observability` | `kuber/gitops/observability` | Synced / Healthy | prune + self-heal |

`mitmproxy` and `observability` currently contain namespace-only manifests; no
mitmproxy, Grafana, Prometheus, Loki or Alertmanager workloads or services were
found in the live workload/service inventory. Their presence as healthy Argo CD
Applications does not mean those products are deployed.

Live main images: DeviceHub `mdub1na/devicehub:kuber-amd64-4f59199e`, MongoDB
`mongo:7.0`, OpenLDAP `osixia/openldap:1.5.0`, phpLDAPadmin
`osixia/phpldapadmin:0.9.0`, Argo CD `v3.4.2`, Traefik `v3.6.12`, cert-manager
`v1.20.1`, Selenium Grid `4.39.0`. CoreDNS, metrics-server and local-path-provisioner
are also installed.

Persistent volumes use `local-path`, with these PVCs all `Bound`:

| Namespace | PVC | Capacity |
| --- | --- | --- |
| `mongodb` | `mongodb-data-pvc` | `5Gi` |
| `openldap` | `openldap-data-pvc` | `1Gi` |
| `devicehub` | `devicehub-storage-temp-pvc` | `5Gi` |

The four ingress Certificates are `Ready=True`, with expiration on 2027-01-02.
Their TLS Secrets are `appium/appium-grid-putmyhexon-ru-tls`,
`argocd/argocd-putmyhexon-ru-tls`, `devicehub/devicehub-putmyhexon-ru-tls` and
`openldap/ldap-putmyhexon-ru-tls`. ACME issuer/account key name in each ingress
namespace is `letsencrypt-http` / `letsencrypt-http-account-key`.

## Context For The STF Migration

- Copy `kuber/` from the existing `devicehub` checkout after reviewing the snapshot.
- Keep the external kubeconfig, join token, LDAP data and other credentials in
  their existing storage locations; they are not migration source files.
- Update repository references in `gitops/bootstrap/root-app.yaml`,
  `gitops/root/*-app.yaml` and `gitops/argocd/project.yaml` when the new STF branch
  and its manifests are ready to be the source of deployments.
- Inspect the current `mongodb` OutOfSync difference before changing its source.
- Check STF's images, CLI arguments, database requirements and authentication
  against these DeviceHub-specific manifests before deploying them.
- The iOS launcher has a hardcoded DeviceHub checkout path and calls the
  DeviceHub-specific `ios-provider`; carry it as historical material until the
  new application supports the required iOS integration.
- SSH credentials, Proxmox login, external Mac service state, router/NAT settings,
  current LDAP user passwords and an authenticated DeviceHub API token remain
  unverified. No host login or credential reset was performed.

## Source Files

- `../README.md`, `requirements.md`, `architecture.md`
- `../gitops/devicehub/devicehub-configmap.yaml`
- `../gitops/devicehub/devicehub-ingress.yaml`
- `../gitops/devicehub/devicehub-android-services.yaml`
- `../gitops/devicehub/devicehub-ios-bridge-services.yaml`
- `../gitops/devicehub/devicehub-ios-provider-bridge.yaml`
- `../gitops/openldap/openldap-statefulset.yaml`
- `../gitops/mongodb/mongodb-statefulset.yaml`
- `../gitops/appium/android-appium-node-config.yaml`
- `../scripts/ios/devicehub-ios-provider.sh`
- Live `kubectl` node, Service, Ingress, workload, PVC, Application, Secret metadata
  and Certificate queries; Grid `/status`; unauthenticated HTTPS status checks.
