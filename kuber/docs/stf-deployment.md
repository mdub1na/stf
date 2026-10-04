# STF Deployment Runbook

This runbook applies after the server maintenance gates in
[the rollout plan](./stf-rollout-plan.md) pass. Do not switch Argo CD to a
revision whose image has not built successfully and cannot be pulled by nodes.

## Image and secrets

GitHub Actions builds the root Dockerfile on pushes to `develop` and publishes
`ghcr.io/mdub1na/stf:<full-commit-sha>`. The deployment image tag is centralized
in the `devicehub` and `rethinkdb` kustomizations. Replace it with the verified
registry digest before the live rollout. A private GHCR package requires node
pull credentials in both namespaces; publishing does not imply anonymous access.
The current tag is a preparation placeholder and has not been published.
Replace it with the digest of the first successful workflow build. GitOps-only
changes do not trigger a new application image build.

The `devicehub` slice retains historical resource names and runs STF, not
DeviceHub. Its base image is replaced by Kustomize; apply the slice with Argo CD,
not individual base Deployment files.

Before the first source change, run:

```sh
export KUBECONFIG='/Users/mdub1na/Desktop/devicehub home cluster/k3s-lab.yaml'
node kuber/scripts/bootstrap-stf-secrets.mjs
```

The script checks the target API and current LDAP administrator bind, copies
the existing LDAP password to Secrets, creates a random STF session secret,
and preserves already-existing Secrets. It neither resets LDAP nor prints
credential values. Run it before removing credentials from the live ConfigMap.
Secrets are bootstrap state outside Git; their values must be kept outside the
repository for disaster recovery.

Required Secrets:

| Namespace | Secret | Required key |
| --- | --- | --- |
| openldap | openldap-credentials | LDAP_ADMIN_PASSWORD |
| devicehub | devicehub-ldap-bind | LDAP_BIND_CREDENTIALS |
| devicehub | devicehub-session | SECRET |

## Source cutover

1. Verify the pushed `develop` commit, successful image build and node pull
   access. Render every local Kustomize slice and inspect Argo CD differences.
2. Temporarily suspend reconciliation on the existing root and affected child
   Applications, including `argocd-config`, so old sources cannot revert the
   source/project changes. Do not create a second root managing the same objects.
3. Bootstrap the updated AppProject and source of the existing `devicehub-root`.
   Switch the existing child Applications to this repository. Do not reinstall
   the Argo CD installation in either `argocd` or `default`.
4. Synchronize `rethinkdb` and wait for the StatefulSet and successful migration
   hook. The application is initially manual-sync. A successful hook is removed;
   verify Argo CD's operation result, not a permanently present Job.
5. Synchronize OpenLDAP with the existing PVC and new Secret reference, then STF
   core/providers/ingress. The `devicehub` Application remains manual-sync.
6. Validate before restoring the intended automatic synchronization policies.

RethinkDB has no public ingress or NodePort. A NetworkPolicy permits driver-port
access only from the `devicehub` and `rethinkdb` namespaces. It uses a new PVC;
neither the MongoDB PVC nor old application data is reused.

## Validation and cleanup

Check LDAP login, devices from both ADB pools, screen streaming and touch,
capture/release, APK install, standard authenticated API, public TLS, and the
16 Grid nodes. Disconnected devices leave device-specific checks pending;
an empty device list alone does not show that STF's provider is broken.

Old MongoDB may be deleted without a backup. Deleting its Argo Application
without a resources finalizer does not remove its workloads. Perform the old
Application's cascading cleanup explicitly after STF validation, including its
PVC and namespace. Do not delete LDAP or STF storage PVCs. Remove the old iOS
bridge Services/Endpoints/NodePorts through the application synchronization.

The copied Java tests still depend on DeviceHub's `/api/v1/autotests` API. They
are historical code pending a separate STF client adaptation, not validation
of this rollout. iOS support and Mac mini changes are explicitly out of scope.
