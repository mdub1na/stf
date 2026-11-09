# STF on Kubernetes

The Helm chart in [`kubernetes/helm`](.) deploys the STF server, a browser-facing proxy and an optional single-node RethinkDB. Android and Linux iOS USB providers are opt-in and can be assigned to separate nodes. The optional coordinator queues device requests and manages leases for CI test runners.

Run the commands below from the root of the STF repository. Examples and verification scripts are provided in the repository checkout.

## Prerequisites

- Kubernetes 1.27 or later, Helm 3 or later, and `kubectl` configured for the intended cluster.
- A default StorageClass for the bundled database, or a reviewed existing claim/external database configuration.
- An existing session Secret in the release namespace. All STF units must keep the same session key across upgrades.
- For USB devices, Linux worker nodes with the devices visible to the host. iOS additionally needs host `usbmuxd`, a trusted pairing and signed WebDriverAgent, as described in the [iOS provider guide](../../doc/ios-provider.md).

The default authentication mode is `mock`, intended for private development. Configure LDAP or OAuth2 before making a shared installation reachable. The chart does not provision certificates, Apple signing accounts or device trust.

## Quickstart: a new installation

These commands create a separate installation with no USB providers. They do not adopt an existing STF namespace or migrate a running farm. Review the rendered resources first; use your actual Kubernetes context in place of `YOUR_CONTEXT`.

```sh
helm lint kubernetes/helm --set session.existingSecret=stf-session
helm template stf kubernetes/helm --namespace stf \
  --set session.existingSecret=stf-session > /tmp/stf-kubernetes.yaml

KUBE_CONTEXT=YOUR_CONTEXT
kubectl --context "$KUBE_CONTEXT" create namespace stf
umask 077
STF_SESSION_DIR=$(mktemp -d)
openssl rand -hex 32 > "$STF_SESSION_DIR/SECRET"
kubectl --context "$KUBE_CONTEXT" --namespace stf create secret generic stf-session \
  --from-file=SECRET="$STF_SESSION_DIR/SECRET"
rm "$STF_SESSION_DIR/SECRET"
rmdir "$STF_SESSION_DIR"

helm upgrade --install stf kubernetes/helm \
  --kube-context "$KUBE_CONTEXT" --namespace stf \
  --set session.existingSecret=stf-session --wait --timeout 10m

kubectl --context "$KUBE_CONTEXT" --namespace stf \
  port-forward service/stf-proxy 7100:7100
```

The default STF image is `devicefarmer/stf:3.9.0`. Pin an immutable `image.digest` when recording a reproducible deployment. The examples use local browser access at `http://localhost:7100`; the database needs a working StorageClass before the installation can become ready. A successful Helm render does not establish cluster or hardware readiness.

## Configuration

Keep installation values in an environment-specific file outside the STF checkout, and pass it with `-f PATH` on every Helm render or upgrade. Sensitive values belong in existing Kubernetes Secrets; the chart references them by name.

| Values | Purpose |
| --- | --- |
| `publicOrigin` | Complete browser-facing HTTP(S) origin, without a path or trailing slash |
| `image.repository`, `image.tag`, `image.digest` | STF server image; a digest takes precedence over the tag |
| `imagePullSecrets` | Existing registry pull credentials in the release namespace |
| `session.existingSecret`, `session.key` | Existing session key; the default key name is `SECRET` |
| `auth.type` | `mock`, `ldap` or `oauth2` |
| `auth.env`, `auth.extraArgs` | Non-sensitive options accepted by the selected STF auth command |
| `auth.existingSecret` | Sensitive authentication environment variables, supplied to the auth unit |
| `database.bundled` | Run the included single-node RethinkDB or use an external database |
| `database.external` | External host, port and optional existing authentication Secret |
| `database.persistence` | Database claim, StorageClass and size |
| `storage.persistence` | Optional persistent upload volume; temporary storage metadata remains process-local |
| `networkPolicy` | Ingress isolation of internal units, allowed proxy sources and remote providers |
| `proxy.ingress` | Optional Ingress, controller class, annotations and existing TLS Secret references |
| `coordinator` | Optional test queue, persistent lease state and worker connections |
| `appium` | Optional Selenium Grid and Appium relays for selected USB devices |
| `core.nodeSelector`, `core.units` | Core scheduling and per-unit overrides |
| `ports.http`, `messaging.app`, `messaging.dev` | HTTP and ZeroMQ ports; override when adopting existing endpoints |
| `proxy.containerPort`, `proxy.service.port` | Proxy listener and Service ports |
| `migration.enabled`, `migration.revision` | Migration gate and explicit rerun revision |
| `bootstrap.adminName`, `bootstrap.adminEmail` | Optional explicit root-owner overrides; empty values preserve an existing owner |
| `resourceNames`, `selectorOverrides` | Explicit names/selectors for a separately reviewed adoption plan |

The bundled database is a single StatefulSet, not a highly available database service. If `database.bundled: false`, set `database.external.host`, port and database name, and verify the database is reachable from the release namespace. Refer to [`values.yaml`](values.yaml) for the exact keys. A claim alone does not preserve in-progress upload metadata across a storage-process restart.

For remote access, set `publicOrigin` to the URL users open and configure `proxy.ingress` or an equivalent private gateway. Keep HTTP and WebSocket traffic on that same origin. TLS certificates and DNS records are operator inputs.

## Network isolation

RethinkDB, the ZeroMQ triproxies, provider ports and USB ADB servers do not authenticate their clients. By default the chart renders NetworkPolicies so that internal units accept connections only from pods of the same release, and the proxy accepts connections on its HTTP port. Public HTTP and WebSocket routes must enter through the chart proxy. Existing Ingress routes that target core Services directly need to be moved to the proxy or covered by separately reviewed policies. Egress is not restricted. The policies take effect only with a CNI plugin that enforces NetworkPolicy; without one, every unit is reachable from any pod in the cluster.

- `networkPolicy.proxyFrom` narrows who can reach the proxy, for example to the Ingress controller's namespace. Pods of the release are always allowed. Traffic arriving through a NodePort or LoadBalancer Service, or from a `hostNetwork` Ingress controller, comes from node addresses that a `namespaceSelector` does not match; add an `ipBlock` for them or leave `proxyFrom` empty.
- `networkPolicy.remoteProvidersFrom` admits providers of another release to this release's `triproxy-dev` pub and pull ports only. Their storage/API requests also need HTTP access; include those sources in `proxyFrom` when restricting the proxy, or add a narrow policy for direct internal access.
- `proxy.extraScreenRoutes` pointing at iOS screen Services of another release need a policy in that release admitting this release's proxy on port 17440.
- Network selectors use fixed release and component labels on pod templates, independently of `selectorOverrides`. Legacy Deployment and Service selectors stay unchanged. Overrides may omit these labels, but conflicting values are rejected while isolation is enabled.
- Existing NetworkPolicies are additive: another policy can allow traffic this chart does not. Review them when adopting an existing installation. Externally managed databases and ADB servers need their own policies.
- `networkPolicy.coordinatorFrom` allows selected CI pods or a private gateway to reach the coordinator's HTTP and WebSocket port through its ClusterIP Service.

## USB providers

Both `android.providers` and `ios.devices` are empty by default. A device-free cluster can validate the server lifecycle; it cannot validate USB permissions, passthrough or device interaction. The namespace policy must allow the chart's privileged Android ADB/iOS tunnel containers and host device mounts when those providers are enabled.

Android entries select the Linux USB node and optionally restrict serials:

```yaml
android:
  providers:
    - name: android-a
      nodeSelector:
        kubernetes.io/hostname: usb-worker
      serials: []
      capacity: 8
      minPort: 7400
```

Android providers fetch install URLs through the complete proxy so APK metadata routes are available. Set an entry's `storageUrl` to an existing full gateway when adopting a farm; the raw temporary-storage endpoint cannot serve APK metadata.

Use one USB ADB server per node, selected by an explicit `kubernetes.io/hostname`. Additional labels do not partition a host's USB bus. To share an existing server, configure `externalAdb` and disjoint serial lists rather than starting competing ADB services. USB passthrough and host permissions remain node preparation tasks. Set `adbKeysClaim` to an existing claim when ADB trust keys must survive replacement of its pod.

For iOS, build the Linux runtime from the same STF checkout and make it available to the cluster. The chart deliberately supplies no published iOS runtime image name:

```sh
docker build -f docker/ios/Dockerfile -t YOUR_REGISTRY/stf-ios-runtime:VERSION .
```

Set `ios.image.repository` and `tag` or `digest` after publishing or loading that actual image. Prepare a private token Secret for each device, then configure:

```yaml
ios:
  image:
    repository: YOUR_REGISTRY/stf-ios-runtime
    tag: VERSION
  devices:
    - name: iphone-a
      udid: YOUR_DEVICE_UDID
      wdaBundleId: com.example.WebDriverAgentRunner.xctrunner
      tokenSecret: iphone-a-token
      tokenKey: token
      nodeSelector:
        kubernetes.io/hostname: usb-worker
      persistence:
        size: 5Gi
```

The [USB values example](examples/usb.yaml) combines Android and iOS configuration with OAuth2 for its public Ingress. Replace the domain, identity-provider URLs, device identifiers and runtime image before applying it.

Register the OAuth client callback as `https://stf.example.com/auth/oauth/callback` and create an existing Secret named `stf-oauth` in the release namespace with keys `STF_AUTH_OAUTH2_OAUTH_CLIENT_ID` and `STF_AUTH_OAUTH2_OAUTH_CLIENT_SECRET`. Keep the secret values out of Helm values files. The provider's UserInfo response must include `email`; `email_verified: false` is rejected.

Keep the pairing/state claim for each phone. Confirm that the selected node exposes the expected usbmuxd socket and has already established trust with that iPhone. WDA must be signed and installed beforehand; the Kubernetes chart does not perform signing or first-time device preparation. See the [provider limits and recovery behavior](../../doc/ios-provider.md).

## Automation coordinator

Enable the coordinator to reserve STF devices for tests running in another process or CI repository. Deploy a matching STF build containing `stf coordinator` and the fenced reservation protocol in the API, processors and providers. The chart's default STF image predates this feature. Configure `image` with the matching build, or use `coordinator.image` to select a separate compatible coordinator image.

Create a Kubernetes Secret in the release namespace. Supply `stf-token` from a dedicated STF account with access to the intended device groups, and `api-token` as a separate high-entropy coordinator operator token. The coordinator reads both from files and expects tokens of at least 24 characters with no internal whitespace. To give CI projects separate credentials and quotas, store the project policy JSON in the same Secret and set `coordinator.projectTokensKey` to its key. See the [coordinator guide](../../doc/coordinator.md) for the format.

Add this to your release values to run Maestro on its Android devices:

```yaml
coordinator:
  enabled: true
  existingSecret: stf-coordinator-credentials
  maxParallel: 8
```

`maxParallel` caps active leases across runners and projects. The coordinator uses one replica and stores the queue and lease history on a persistent claim. Set `coordinator.persistence.existingClaim` when adopting existing state. Drain active leases before replacing the coordinator or changing its upstream configuration, and keep the same claim during upgrades. Use one coordinator for each device pool.

The default STF API endpoint is the release's API Service. Set `coordinator.stfApiUrl` to the full `/api/v1` URL for an existing installation. The chart derives ADB pools from `android.providers`, including their `externalAdb` settings. To connect to Android providers managed outside this release, set `coordinator.adbPools` with their exact STF provider names, ADB Service hosts and ports, and `systemPorts: []`. An explicit pool list replaces the derived one.

The coordinator Service is reachable at `http://<service>.<namespace>.svc:8080` inside the cluster. For a local check, forward its port and inspect readiness:

```sh
kubectl --context "$KUBE_CONTEXT" --namespace stf port-forward service/stf-coordinator 8080:8080
# Run in a second terminal.
curl --fail http://127.0.0.1:8080/readyz
```

Run Maestro from the test repository using [`stf autotest run`](../../tools/test-runner/README.md) with `--runner maestro`. Workers outside the cluster need a private HTTPS route to the coordinator that supports WebSocket upgrades. Allow that gateway in `networkPolicy.coordinatorFrom` and use its URL as `coordinator.publicUrl` for worker-facing links.

### Appium with Selenium Grid

To install the bundled Grid, build and publish the Appium image from this checkout. It includes UiAutomator2 and XCUITest, so pods start with both drivers available. Its pinned Appium base is Linux amd64. Android Appium relays and iPhone pods with an Appium sidecar are scheduled on amd64 by default. Set `appium.nodeArchitecture` to match a compatible image you supply, or clear it for a multi-architecture image.

```sh
docker buildx build --platform linux/amd64 --push \
  -f docker/appium/Dockerfile -t YOUR_REGISTRY/stf-appium:VERSION .
```

Enable the coordinator and add `appium.enabled` and your image reference to the release values. For each Android pool that should run Appium, set the number of relay replicas and supply at least one distinct UiAutomator2 `systemPort` per replica.

```yaml
appium:
  enabled: true
  image: {repository: YOUR_REGISTRY/stf-appium, tag: VERSION}
android:
  providers:
    - name: android-a
      nodeSelector: {kubernetes.io/hostname: usb-worker}
      appium: {replicas: 2, systemPorts: [8200, 8201]}
```

Each relay handles one session. The chart adds the selected ports to its Android ADB Service. For an external ADB server, make its configured `systemPorts` and ADB control port reachable from the relays. Pools sharing an ADB host need disjoint `systemPorts`. Android providers without an `appium` entry continue to serve Maestro.

The bundled Android Appium server checks whether it can stop a child process
before enabling automatic logcat capture. When the runtime denies the signal,
Appium disables capture to avoid a driver crash during session teardown.
Appium log commands require capture. Keep the session default on affected
nodes. See the [containerd AppArmor issue](https://github.com/containerd/containerd/issues/14485).

To add an iPhone, set `appium: {platformVersion: '27.0.1'}` on its `ios.devices` entry, using the exact version reported by STF. After an iOS update, update this value to refresh the Grid slot. Appium and its relay share the provider pod. They reuse the running STF WDA session, so WDA must be signed, installed and trusted as described under USB providers. The device's pairing state stays on its existing claim.

CI connects to the coordinator and runs the test with `stf autotest run --runner appium`. The Hub and relay endpoints are for internal traffic. With an enforcing CNI, the chart limits Hub access to the coordinator and relay pods. See the [CI worker guide](../../doc/ci-runners.md) for the worker contract. If first Appium sessions start slowly on your devices, increase `coordinator.upstreamTimeoutSeconds` from its 30-second default.

For a separately deployed Grid, use `coordinator.appiumGridUrl` in place of `appium.enabled`. Supply explicit `coordinator.adbPools` entries for Android and expose their `systemPorts` and ADB control port to the Appium nodes. With both Grid options off, the coordinator runs Maestro on Android. Drain active Appium leases against the original Grid before changing or disabling it. The coordinator needs that Grid to clean up any Appium leases still held in persistent state.

## Database migration and upgrades

The chart renders `stf migrate` as an ordinary Job whose name depends on the relevant image/configuration. Core units wait for that exact Job to complete. Their init container has read access only to that named Job; the application container does not receive a Kubernetes token. The chart uses this barrier for both Helm and Argo CD rendering, without lifecycle hooks.

For an existing database already prepared for the exact selected image, `migration.enabled: false` omits the migration Job, barrier and its RBAC. The operator must verify schema compatibility before using that mode.

Keep the session Secret, database claim and device state claims stable during upgrades. Review migration changes before changing the image. `migration.revision` explicitly requests another migration when the other inputs have not changed. An installation that cannot migrate remains blocked rather than starting against an unprepared database.

Existing farms need a separate adoption plan: compare names, namespaces, immutable selectors, Pod templates, PVC ownership, images and Secret references before using `resourceNames` or `existingClaim`. Matching a resource name does not make an existing resource safe for Helm adoption. Do not run the Quickstart or install Argo CD over a working farm to switch its Git source.

## Verification

Run `helm lint` and `helm template` with the actual values file before an installation. Review optional database, auth, ingress and provider branches separately. Chart fixture tests require Python 3, PyYAML 6 and Helm on `PATH`:

```sh
python3 kubernetes/helm/tests/render_test.py
```

Set `HELM=/path/to/helm` if Helm is installed elsewhere. These tests validate rendered manifests and migration behavior without proving real USB operation.

The API-only smoke creates and removes its own Kind cluster, installs and upgrades the chart, checks login/session and database persistence, and never reuses the current Kubernetes context. With Docker, Kind, Helm and kubectl available:

```sh
python3 kubernetes/helm/tests/smoke.py \
  --cluster-name stf-chart-local \
  --kubeconfig /tmp/stf-chart-new.kubeconfig \
  --artifacts /tmp/stf-chart-smoke
```

Use a new kubeconfig path. The current smoke was verified with Helm 4.3.1 and Kubernetes 1.37.0. For a hardware check, confirm database readiness, completed migration, healthy STF units and browser login. For each enabled provider, check device discovery, live screen, input, disconnect/reconnect and persistence across pod replacement. Record the tested image, cluster and devices separately; a device-free smoke test does not establish those hardware results.

Bootstrap administrator fields are optional. Empty values preserve the existing root owner during migration; set them explicitly only when changing that owner is intended. A fresh database uses STF's built-in bootstrap defaults.
