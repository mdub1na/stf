# Cluster upgrades and observability review

Verified on 2026-10-15, Asia/Yekaterinburg, against the live Kubernetes API,
container runtimes, official release APIs, npm and container registries.
Version candidates below are the pre-upgrade audit snapshot. The audit itself
only disabled LDAP. The subsequently authorized component upgrades are tracked
in [the upgrade rollout](./cluster-upgrade-rollout.md); RethinkDB stays at 2.4.2
and the user deferred K3s until node access is available.

## Current state and capacity

| Node | Allocatable CPU / RAM | Observed RAM usage | Memory requests | Free node filesystem |
| --- | --- | --- | --- | --- |
| k3s-control | 4 CPU / 7.16 GiB | 2.01 GiB | 908 MiB | 99.4 GiB |
| k3s-worker-1 | 4 CPU / 9.21 GiB | 4.64 GiB | 512 MiB | 95.1 GiB |
| k3s-worker-2 | 4 CPU / 9.21 GiB | 2.19 GiB | 1 GiB | 90.2 GiB |

These are idle-time observations, not peak-load capacity measurements. The
Android worker's requests substantially understate its real usage: the 16
Appium relay pods consume roughly 3.5–4 GiB but have no useful aggregate
reservation. Add measured requests/limits before placing more workloads there.
Prefer the storage worker or a dedicated observability VM for telemetry backends.

The cluster has one control-plane node and only the node-local `local-path`
StorageClass (`Delete`, `WaitForFirstConsumer`). Its PVCs are not replicated;
requested PVC sizes are not a substitute for filesystem capacity monitoring.
There is no object store or existing telemetry backend. `observability` contains
only a namespace; no Prometheus, Grafana, Loki, Istio, Kiali or OpenSearch CRDs
were found. Metrics Server supplies current resource usage, not historical
monitoring, alerting or log retention.

Two Argo CD installations are running: the active one in `argocd` and seven
additional pods in `default`, where no Applications exist. Investigate that
instance's configuration, ingress and cluster RBAC before retiring it; it was
not changed by this task. The previous application namespace remains stopped
with its source PVC preserved pending separate deletion approval.

## LDAP is disabled

`openldap` and `phpldapadmin` render with zero replicas through the LDAP
kustomization. Their namespace, 1 GiB PVC, Secrets, Services and TLS resources
remain intact. The retained phpLDAPadmin Ingress has no ready backend and
returns an unavailable response; it is not a running administration UI.

STF selects the GitLab OAuth overlay and has no active LDAP dependency. After
shutdown, all four connected Android devices remained present and ready; all
six registered device records remained in RethinkDB.

To re-enable LDAP, change both replica overrides to `1`, commit the change and
synchronize the `openldap` Application. The initial secret-bootstrap script
performs a live LDAP bind and therefore requires LDAP to be running; do not run
that bootstrap script as part of routine GitLab OAuth deployments.

## Upgrade candidates

| Component | Verified running | Candidate | Recommended sequence / gate |
| --- | --- | --- | --- |
| K3s, all three nodes | 1.35.5+k3s1 | 1.35.9+k3s1; then stable 1.36.5+k3s1 | Patch the existing minor first. Upgrade server before agents; preserve node flags, USB passthrough and datastore backups. Do not skip a minor to reach latest 1.37.1. |
| Argo CD | 3.4.2 | 3.4.11; later 3.5.5 | Patch the active installation first. Back up configuration/Secrets and pin install manifests to a release rather than the floating `stable` URL. |
| cert-manager | chart/images 1.20.1 | 1.20.4; later 1.21.2 | Patch with the matching chart and CRDs. Verify existing Certificates and renewal challenges. |
| Traefik | 3.6.12, chart 39.0.7 | 3.6.25 as an interim patch; 3.7.14 with chart 41.7.1 as a migration candidate | Review chart migration notes and actual chart appVersion. Coordinate the separate bundled `traefik-crd` chart with GitOps ownership; do not change the image alone. |
| STF dynamic proxy | nginx:1.27-alpine | nginx:1.30.6-alpine | Published image verified. Test configuration, dynamic provider routing and WebSocket Upgrade on a canary before cutover. |
| Selenium Grid, all relay/control containers | 4.39.0 | 4.51.0-20261010 | Published container tag verified. Keep Grid component versions aligned; validate relay matching and session routing on one pool before both. |
| Appium / Node / UiAutomator2 | 2.11.4 / 18.20.4 / 3.8.0 | Appium 3.8.0 / Node 24 LTS / UiAutomator2 8.7.0 | Highest migration priority: Node 18 is EOL. Build a pinned image and test one relay with Android APIs 31, 35 and 36 before rolling all 16. |
| RethinkDB | rethinkdb:2.4.2 | rethinkdb:2.4.4-bookworm-slim | The exact image exists for amd64; plain `rethinkdb:2.4.4` does not. Require a tested logical backup/restore and STF compatibility check. Do not assume an on-disk downgrade is safe. |
| CoreDNS / Metrics Server / local-path provisioner | 1.14.3 / 0.8.1 / 0.0.36 | Review with the K3s bundle | Upstream Metrics Server 0.9.0 and provisioner 0.0.37 exist; keep K3s-managed add-ons aligned with the selected K3s release rather than patching them independently. |
| ADB | platform-tools 37.0.0-14910828 | Pin the already tested image digest | The running binary is recent; the risk is the mutable `devicefarmer/adb:latest` tag, not an established need to replace ADB. |

Argo CD's Redis and Dex should be reviewed as part of its release manifests.
STF app/auth and worker images are already pinned by digest; compare upstream
changes and rebuild deliberately rather than replacing them with `latest`.
Ubuntu 26.04 / kernel package updates require SSH or a guest-agent package
inventory: no host package-upgrade claim was verified through Kubernetes.

The [K3s channel API](https://update.k3s.io/v1-release/channels) currently points
`stable` to 1.36.5+k3s1 and `latest` to 1.37.1+k3s1. Follow the
[server-first, no-skipped-minors upgrade procedure](https://docs.k3s.io/upgrades/manual).
Release evidence: [K3s 1.35.9](https://github.com/k3s-io/k3s/releases/tag/v1.35.9%2Bk3s1),
[Argo CD 3.4.11](https://github.com/argoproj/argo-cd/releases/tag/v3.4.11),
[cert-manager 1.20.4](https://github.com/cert-manager/cert-manager/releases/tag/v1.20.4),
[Traefik chart 41.7.1](https://github.com/traefik/traefik-helm-chart/releases/tag/v41.7.1),
[NGINX 1.30.6](https://github.com/nginx/nginx/releases/tag/release-1.30.6),
[Selenium containers](https://github.com/SeleniumHQ/docker-selenium/releases/tag/4.51.0-20261010),
[RethinkDB 2.4.4](https://github.com/rethinkdb/rethinkdb/releases/tag/v2.4.4).
Appium candidates were checked against the official npm package metadata;
its [migration guide](https://appium.io/docs/en/latest/guides/migrating-2-to-3/)
requires supported Node/npm versions, scoped insecure-feature flags and W3C
endpoint compatibility. [Node release status](https://nodejs.org/en/about/previous-releases)
confirms that Node 18 is EOL and Node 24 is LTS. Both active Appium pools
currently pass unscoped `--allow-insecure chromedriver_autodownload`; the
Appium 3 migration must use `uiautomator2:chromedriver_autodownload` instead.

## What to add to observability

| Layer | Suggested components | Value for this farm | Decision |
| --- | --- | --- | --- |
| Metrics and alerts | kube-prometheus-stack: Prometheus, Grafana, Alertmanager, kube-state-metrics, node-exporter; blackbox-exporter | Node/disk capacity, pod failures, certificates, ingress health, GitOps drift and availability | First deployment |
| Logs and Kubernetes events | Loki single-binary + Grafana Alloy | Search correlated STF, Appium, Selenium and infrastructure logs without a full-text search cluster | Add next |
| Application traces | OpenTelemetry Collector + Tempo | Trace HTTP/auth/API delays once applications emit spans | Add after instrumentation |
| Full-text search / security analytics | OpenSearch + OpenSearch Dashboards; optionally Data Prepper | Indexed field/full-text investigations and analytics beyond the log-label workflow | Optional, preferably dedicated capacity |
| Service mesh and topology | Istio Ambient + Kiali + Prometheus | Workload identity, mTLS, traffic policies and mesh-aware service graph | Separate pilot after baseline monitoring |
| Network flow visibility | Cilium + Hubble | Kernel/network flow visibility and policy debugging | Alternative future network project, not a simple monitoring add-on |

### First deployment: metrics, then logs

Use one Prometheus and one Alertmanager replica initially. Retain 7–15 days of
metrics in roughly 15–20 GiB and begin with 3 days of logs in roughly 30 GiB.
These are starting capacity budgets, not promises about retention: measure
series cardinality and GB/day for 48 hours and adjust. Keep node filesystem
headroom for STF data, RethinkDB, images and logs.

Existing Argo CD metrics Services and Traefik's Prometheus entrypoint on 9100
are already available. cert-manager explicitly has `prometheus.enabled: false`;
enable it and its ServiceMonitor only after the monitoring CRDs exist. Adapt
the chart's control-plane scrapes to K3s. K3s embeds components into one process;
scraping every default component endpoint can duplicate metrics or target
unavailable ports. Its optional supervisor metrics require
`supervisor-metrics: true`; see [K3s metrics](https://docs.k3s.io/reference/metrics).

Start with alerts for disk pressure, node/pod readiness and restarts, PVC space,
certificate expiry, Argo CD drift, Grid availability and queue growth, and the
number of available Android devices/providers. STF already exposes native
Prometheus metrics at `/api/v1/metrics`; the route and controller were verified
inside the deployed API image, as well as in `lib/util/metrics.ts` and
`lib/units/api/controllers/metrics.ts`. It provides `stf_devices_total`,
`stf_devices_available`, `stf_devices_busy`, device-state counts, active-provider
counts, user/group aggregates and default Node process metrics. The endpoint
requires an administrator access token: keep the bearer token in a dedicated
Kubernetes Secret and restrict the scrape path. Do not make it public or add a
duplicate device-count exporter. An authenticated live scrape was not attempted
because this audit did not create or retrieve an administrator token.

ADB transport health and Selenium Grid JSON counters still need dedicated probes
or exporters; ordinary Kubernetes metrics do not supply those. Prefer aggregated
counts without user or device identifiers. Use the existing STF API instead of
broadly opening RethinkDB to the observability namespace.

Use Alloy for pod logs and Kubernetes events. Promtail is already
[end of life](https://grafana.com/docs/alloy/latest/set-up/migrate/from-promtail/).
Use low-cardinality Loki labels such as namespace, application and container;
keep device serials and session IDs as parsed fields. Redact credentials before
shipping logs. [Loki's monolithic mode](https://grafana.com/docs/loki/latest/get-started/deployment-modes/)
is appropriate for an initial small deployment. Do not deploy the heavier
distributed or deprecated simple-scalable mode by default.

### OpenSearch: possible, but not the baseline requirement

OpenSearch 3.9.0 and matching Dashboards are current candidates. It is useful
when indexed full-text/field queries or security analytics are a real
requirement. The [official Helm guide](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/helm/)
deploys three nodes by default, recommends at least 8 GiB available for that
deployment and requires `vm.max_map_count >= 262144`. Heap is only part of its
memory use. Persistent disks, credentials/TLS, shard sizing, retention and
snapshot storage also need explicit configuration.

A single-node lab experiment is feasible; budget roughly 3–4 GiB including
Dashboards and avoid the Android worker. For a sustained search cluster, add
dedicated SSD-backed capacity, preferably a separate VM or node group. Do not
install both a full OpenSearch log pipeline and Loki for all logs initially:
choose one primary log backend, then pilot search on a limited data set if needed.

### Istio and Kiali: a networking change with observability benefits

Istio 1.31.1 supports Kubernetes 1.35 according to the
[support matrix](https://istio.io/latest/docs/releases/supported-releases/).
Kiali 2.33.0 is the current candidate; validate the exact chart/operator and
Istio pairing for the pilot. [Kiali requires an installed Istio mesh](https://kiali.io/docs/installation/installation-guide/prerequisites/);
Prometheus supplies traffic history and metrics. Installing Kiali alone will
not produce a useful mesh graph of the existing STF deployment.

Prefer an opt-in Ambient pilot over injecting a sidecar into every STF and
Appium pod. Ambient uses per-node ztunnels; full L7 traffic metrics require
[waypoint proxies](https://istio.io/latest/docs/ambient/usage/l7-features/).
The [K3s platform prerequisite](https://istio.io/latest/docs/ambient/install/platform-prerequisites/)
is `global.platform=k3s` for its CNI paths. Keep Traefik on ports 80/443 and do
not introduce a competing ingress gateway just to install a mesh.

STF uses ZeroMQ, ADB, WebSocket and long-lived device streams. Opaque TCP flows
will not become meaningful HTTP/RPC traces automatically. Initially exclude
ADB/providers and test WebSocket reconnects, streaming and device sessions
before enrolling them. OpenTelemetry application instrumentation is still
needed for end-to-end spans and propagation across ZeroMQ.

[Cilium on K3s](https://docs.cilium.io/en/stable/installation/k3s/) changes the
cluster's CNI setup; Hubble is consequently a separate migration decision.
Do not replace Flannel solely to get a dashboard during the initial rollout.

## Initial resource envelopes

These are planning estimates for a small non-HA deployment, not vendor
minimums or measurements of installed components. Revisit them under load.

| Increment | Additional RAM budget | Initial persistent storage |
| --- | --- | --- |
| Metrics, Grafana and alerts | 2–3 GiB | 15–20 GiB Prometheus |
| Loki plus Alloy agents | 1.5–2.5 GiB | About 30 GiB, short retention |
| Tempo plus OTel collector | 1–2 GiB | 10–20 GiB or external object storage |
| Ambient/Kiali pilot with a waypoint | 1–2 GiB | Reuse telemetry backends |
| OpenSearch single-node experiment and Dashboards | 3–4 GiB | Separate budget after measuring ingestion |

The metrics-and-logs baseline is a reasonable fit after resource reservations
are corrected. Adding every optional layer together would consume much of the
current headroom and concentrate risk on the storage worker. External object
storage, a dedicated telemetry VM and backup/restore tests should precede a
larger retention or HA design. Rediscover peak Appium usage before final sizing.

## Suggested order of work

1. Keep LDAP paused, correct Appium resource reservations, investigate duplicate
   Argo CD, and verify off-cluster backups and restore procedures.
2. Deploy metrics/alerts and Loki/Alloy through the existing observability slice;
   expose dashboards with authentication and internal access controls.
3. Patch K3s 1.35, Argo CD 3.4 and cert-manager 1.20; migrate NGINX and the
   Appium/Node/driver image on a canary; align Selenium components afterward.
4. Evaluate K3s 1.36 stable and the Traefik chart/CRD migration in a maintenance
   window. Upgrade the RethinkDB image only after backup/restore validation.
5. Add traces after instrumentation. Pilot Istio/Kiali only for an explicit
   mTLS/policy/topology requirement; pilot OpenSearch only for a search use case.

No infrastructure versions or observability products were installed by this
review. LDAP replicas are the only desired workload change.
