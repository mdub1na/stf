# STF resource naming migration

This runbook moves the application to namespace `stf`. The deployment source is
`mdub1na/stf`, branch `develop`, overlay `kuber/gitops/stf-gitlab`.

## Preserve state

- Record the source Application specifications and workload replica counts.
- Export rollback resources to a private directory outside the repository.
  Never commit Kubernetes Secret values or kubeconfig credentials.
- Preserve RethinkDB in namespace `rethinkdb`; it contains users, tokens, groups
  and device records. Do not run a database migration for a resource rename.
- Copy the existing LDAP bind, session, GitLab OAuth, issuer-account and TLS
  Secrets into `stf`, preserving their data and types. Do not rotate keys.
- Provision `stf-storage-temp-pvc` on the storage node. Stop source writers,
  copy the previous volume's complete directory tree including ownership and
  modes, and compare file checksums and directory metadata before cutover.

## Cut over

All STF process pods set `enableServiceLinks: false`. Kubernetes otherwise
injects `STF_*_SERVICE_*` and `STF_*_PORT_*` variables from the renamed Services.
The STF command-line parser treats those variables as unknown options and
exits. Explicit ConfigMap and Secret variables remain available; service
discovery uses DNS.

1. Pause automatic synchronization while the namespace and project change.
2. Add `stf.role` labels to the existing control, Android and storage nodes.
3. Create namespace `stf`, its Secrets, services and PVC. Keep the public Ingress
   on the source application until the destination is ready.
4. Stop source providers and application workloads before starting destination
   workloads so two providers cannot claim the same ADB pools.
5. Update the RethinkDB driver NetworkPolicy to allow namespace `stf`, then
   start the renamed workloads. The RethinkDB PVC is never replaced.
6. Update both Appium pools to use `adbd.stf.svc.cluster.local` and
   `adbd-2.stf.svc.cluster.local`. Keep all 16 Grid nodes.
7. Switch the Ingress to the ready services. Verify HTTPS, the local login page,
   GitLab authorization redirect, API authentication boundary, WebSocket and
   Grid health. Check both ADB pools and provider registration.
8. Synchronize Argo CD applications `stf-root`, `stf` and their dependencies at
   the merged `develop` revision. Preserve the manual sync policies of `stf`
   and `rethinkdb` and the existing automatic policies of other applications.

## Cleanup and rollback

Before deleting the previous namespace, verify copied Secret data, volume
contents, RethinkDB availability, ready replicas and the public application.
Remove the previous Argo CD Applications without a resources finalizer, the
unused project and node role labels after all applications use `stf-platform`.
Delete migration helper pods and check that the previous PVC/PV are gone.

Until cleanup, rollback consists of stopping destination providers, restoring
source replica counts and Ingress, restoring the source Appium/NetworkPolicy
configuration and resuming its Applications. Keep private rollback exports
until the final checks complete.

Kubeconfig files are external operator inputs. Replace `/absolute/path/to` in
the access documentation with the actual local directory; the migration does
not rename or move operator credential files.
