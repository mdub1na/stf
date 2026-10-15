# STF Migration Architecture

The deployed GitOps source runs Android STF with RethinkDB in place of
the legacy MongoDB-based farm. It uses the `stf` namespace, service names,
node labels, two ADB/provider pairs and 8 + 8 Appium nodes.
RethinkDB gets a new `5Gi` local-path PVC on the storage worker; LDAP and temp
storage PVCs remain unchanged. iOS bridges are removed; Mac mini operations are
excluded. The old MongoDB namespace, workloads and persistent data were deleted.

The farm uses <https://stf.finservice.tech> since 2026-10-05. Argo CD, LDAP
administration and Appium Grid retain their previous public domains. An explicit
GitOps Certificate supplies the farm ingress TLS Secret; app/auth redirect,
WebSocket/storage URLs and both provider screen/public URLs use the new host.

The live cluster was switched on 2026-10-04. All ten Argo CD Applications use
`https://github.com/mdub1na/stf.git`, revision `develop`, and are Synced/Healthy.
STF and RethinkDB synchronize manually; the root and infrastructure applications
have automatic prune/self-heal. Passwords and the shared session key are supplied
by separately bootstrapped Kubernetes Secrets, not the ConfigMap or Git.

The initial rollout verified LDAP login, HTTPS/static routing, WebSocket
handshake, database access and temp storage upload/download. GitLab OAuth replaced
the active STF login on 2026-10-05: the existing child Application now selects
`kuber/gitops/stf-gitlab`, extending the unchanged LDAP base. The overlay pins
updated app/auth images for the explicit GitLab sign-in page and server-side
logout; other pod templates are unchanged.
All users of `gitlab.finservice.tech` with a verified email may sign in; state
and S256 PKCE are enabled. GitLab roles do not automatically grant STF privileges.
The user confirmed GitLab browser login. The approved account was explicitly
promoted to `admin`; administrator UI access awaits user confirmation.
LDAP data/base and the shared session key are preserved for rollback.

Since 2026-10-15, both OpenLDAP and phpLDAPadmin have zero desired replicas.
Their PVC and credentials are preserved; an LDAP rollback requires explicitly
re-enabling the replicas. GitLab OAuth remains the active login mechanism.
The [upgrade and observability review](./cluster-upgrades-and-observability.md)
records current capacity, version candidates and telemetry deployment stages.

Android screen/touch and test execution still await connected-device validation;
empty ADB lists were the initial rollout snapshot, not a permanent current state.
The rollout status is tracked in [the execution plan](./stf-rollout-plan.md);
the source/secret/database sequence is in
[the deployment runbook](./stf-deployment.md). Server maintenance awaits SSH.

## Original STF Architecture

The sections below record the original deployment, not the current STF runtime.

## Runtime zones

### Kubernetes

- STF services
- `MongoDB`
- `OpenLDAP`
- `phpLDAPadmin`
- `Traefik`
- `cert-manager`
- Appium Grid control plane
- Android Appium nodes
- `mitmproxy` / `mitmweb`
- observability
- `Argo CD`

### External Mac mini

- WebDriverAgent
- iOS tooling
- iOS Appium nodes
- future iOS-side integration processes

## Namespaces

- `argocd`
- `mongodb`
- `openldap`
- `stf`
- `appium`
- `mitmproxy`
- `observability`

## Node labels

| Node | Label |
| --- | --- |
| `k3s-control` | `stf.role=control` |
| `k3s-worker-1` | `stf.role=android` |
| `k3s-worker-2` | `stf.role=storage` |

## Node roles

| Node | Role | Main workloads |
| --- | --- | --- |
| `k3s-control` | control / GitOps | `argocd`, `traefik`, light control-plane infra |
| `k3s-worker-1` | Android execution | `adbd`, `adbd-2`, `stf-provider`, `stf-provider-2`, Android device workers, Android Appium nodes |
| `k3s-worker-2` | storage / stateful | `mongodb`, `openldap`, `stf-storage-temp`, Appium Grid control plane, observability |
| `Mac mini` | iOS execution | WebDriverAgent, iOS Appium nodes, Apple tooling |

## Required affinity

| Workload | Required label | Reason |
| --- | --- | --- |
| `adbd`, `adbd-2` | `stf.role=android` | own USB-attached Android devices |
| `stf-provider`, `stf-provider-2` | `stf.role=android` | must run next to their ADB endpoints |
| `mongodb` | `stf.role=storage` | fixed persistent data |
| `openldap` | `stf.role=storage` | fixed persistent data |
| `stf-storage-temp` | `stf.role=storage` | fixed persistent temp storage backend |

Everything else stays movable in phase 1.

## Storage

### Persistent workloads

| Workload | Storage | Size | Placement |
| --- | --- | --- | --- |
| `mongodb` | PVC via `local-path` | `5Gi` | `k3s-worker-2` |
| `openldap` | PVC via `local-path` | `1Gi` | `k3s-worker-2` |
| `stf-storage-temp` | PVC via `local-path` | `5Gi` | `k3s-worker-2` |

### Storage rules

- `local-path` on `k3s-worker-2` is the phase 1 storage model.
- `stf-storage-plugin-apk` and `stf-storage-plugin-image` use `stf-storage-temp` as backend storage.
- temp cleanup is expected to be handled by the application services.

## Scaling policy

### Singleton

- all `argocd` workloads
- `traefik`
- `cert-manager`
- all `mongodb` workloads
- all `openldap` workloads
- `stf-app`
- `stf-auth`
- `stf-api`
- `stf-websocket`
- `stf-api-groups-engine`
- `stf-reaper`
- `stf-triproxy-app`
- `stf-triproxy-dev`
- `stf-storage-temp`
- Appium Grid control plane
- `mitmproxy`
- `mitmweb`
- `prometheus`
- `grafana`
- `loki`
- `alertmanager`

### Scalable

- `stf-processor`
- `stf-storage-plugin-apk`
- `stf-storage-plugin-image`
- Android Appium nodes
- `promtail`

### Paired scaling

- `adbd` + `stf-provider`
- `adbd-2` + `stf-provider-2`

Each ADB/provider pair scales and rolls together as one Android execution pair.

## Kubernetes resource types

### `StatefulSet`

- `argocd-application-controller`
- `mongodb`
- `openldap`
- `prometheus`
- `loki`

### `Job`

- `mongodb-init`
- `stf-migrate`

### `DaemonSet`

- `promtail`

### `Deployment`

- all remaining phase 1 workloads

## Argo CD model

### Root model

- use a root app / app-of-apps pattern
- `root/` contains only top-level `Application` resources

### Shared AppProject

| Setting | Value |
| --- | --- |
| name | `stf-platform` |
| repo | `https://github.com/mdub1na/stf.git` |
| cluster | `https://kubernetes.default.svc` |
| namespaces | `argocd`, `mongodb`, `openldap`, `stf`, `appium`, `mitmproxy`, `observability`, `kube-system` |
| allowed cluster-scoped resources | `Namespace` |

### Applications using the shared AppProject

- `argocd`
- `traefik`
- `cert-manager`
- `mongodb`
- `openldap`
- `stf`
- `appium`
- `mitmproxy`
- `observability`
