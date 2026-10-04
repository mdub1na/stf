# GitOps Layout

## Rules

- `root/` contains only top-level `Argo CD Application` resources.
- each child directory maps to one platform slice.
- each child directory owns its namespace resources when it needs a dedicated namespace.
- ingress resources live next to the applications they expose.
- `mitmproxy/` and `observability/` are reserved slices for later implementation and currently contain namespace placeholders only.
- secret values are bootstrapped separately; manifests reference Kubernetes
  Secrets. See the STF deployment runbook for the required keys.

## Current structure

```text
kuber/
  README.md
  appium-tests/
  bugs/
  docs/
  gitops/
  scripts/
```

## Bootstrap

```text
gitops/bootstrap/
  argocd/
    kustomization.yaml
    namespace.yaml
  root-app.yaml
```

`bootstrap/argocd` creates the Argo CD namespace before the upstream Argo CD install is applied.
`bootstrap/root-app.yaml` creates the app-of-apps entrypoint.

## Root Applications

```text
gitops/root/
  kustomization.yaml
  argocd-app.yaml
  traefik-app.yaml
  cert-manager-app.yaml
  rethinkdb-app.yaml
  openldap-app.yaml
  devicehub-app.yaml
  appium-app.yaml
  mitmproxy-app.yaml
  observability-app.yaml
```

`root/` points all child applications at `mdub1na/stf`, revision `develop`.
The live cluster was switched to this source on 2026-10-04. STF and RethinkDB
remain manual-sync; the root and infrastructure applications use prune/self-heal.

## Argo CD Config

```text
gitops/argocd/
  namespace.yaml
  kustomization.yaml
  project.yaml
  argocd-cmd-params-cm.yaml
  argocd-issuer.yaml
  argocd-ingress.yaml
```

This slice owns the shared `devicehub-platform` AppProject, Argo CD server ingress, and HTTPS issuer for the Argo CD namespace.

## Traefik

```text
gitops/traefik/
  kustomization.yaml
  traefik-helmchart.yaml
  traefik-helmchartconfig.yaml
```

Traefik is installed through k3s `HelmChart` resources in `kube-system` and is pinned to the control node.

## cert-manager

```text
gitops/cert-manager/
  kustomization.yaml
  cert-manager-helmchart.yaml
```

cert-manager is installed through k3s `HelmChart` resources and provides Let's Encrypt HTTP-01 issuers for the public ingress endpoints.

## RethinkDB

```text
gitops/rethinkdb/
  namespace.yaml
  kustomization.yaml
  rethinkdb-pvc.yaml
  rethinkdb-service.yaml
  rethinkdb-statefulset.yaml
  rethinkdb-network-policy.yaml
  stf-migrate-job.yaml
```

RethinkDB uses a new local-path PVC on the storage worker and an internal driver
Service. Its PVC and StatefulSet share a sync wave. The migration hook runs
after readiness and bootstraps STF; no MongoDB data conversion is performed.

## OpenLDAP

```text
gitops/openldap/
  namespace.yaml
  kustomization.yaml
  openldap-pvc.yaml
  openldap-service.yaml
  openldap-statefulset.yaml
  phpldapadmin-deployment.yaml
  phpldapadmin-service.yaml
  phpldapadmin-issuer.yaml
  phpldapadmin-ingress.yaml
```

OpenLDAP and phpLDAPadmin run on the storage node. The existing LDAP PVC is
retained; the administrator password comes from `openldap-credentials`.

## STF With Historical Resource Names

```text
gitops/devicehub/
  namespace.yaml
  kustomization.yaml
  devicehub-configmap.yaml
  devicehub-core-deployments.yaml
  devicehub-core-services.yaml
  devicehub-storage-temp-pvc.yaml
  devicehub-android-deployments.yaml
  devicehub-android-services.yaml
  devicehub-dynamic-proxy.yaml
  devicehub-issuer.yaml
  devicehub-ingress.yaml
  stf-runtime-patch.yaml
  stf-session-patch.yaml
  stf-http-probes-patch.yaml
```

This slice owns STF core services, two Android ADB/provider pairs, storage, and
public HTTPS ingress. Kustomize replaces the legacy base image with the pinned
STF image and applies resources/probes/Secret references. iOS bridges are removed.

## Appium

```text
gitops/appium/
  namespace.yaml
  kustomization.yaml
  appium-grid-services.yaml
  appium-grid-deployments.yaml
  android-appium-node-config.yaml
  android-appium-nodes-deployment.yaml
  appium-grid-issuer.yaml
  appium-grid-ingress.yaml
```

Appium Grid control-plane components run on the storage node. Android Appium
node replicas run on the Android node and connect to the retained ADB services,
with eight nodes per ADB pool. The copied Java tests still require adaptation
from DeviceHub-specific APIs to standard STF APIs.

## Reserved Slices

```text
gitops/mitmproxy/
  namespace.yaml
  kustomization.yaml

gitops/observability/
  namespace.yaml
  kustomization.yaml
```

These directories intentionally reserve namespace and Argo CD application boundaries. Their workloads will be added later.
