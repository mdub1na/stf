# Opt-in coordinator deployment

This directory is not referenced by the farm GitOps root. It starts exactly one
`stf coordinator` process in namespace `stf`. Read the
[service/operator guide](../../doc/coordinator.md) before applying it.

Required operator inputs:

- Replace `SET_IMAGE_DIGEST` with an immutable STF image containing the
  coordinator and the fenced STF lease protocol. Deploy the matching API,
  processor and device-provider code before granting coordinator leases.
- Replace the synthetic `adb-pools.json` with the actual STF provider names,
  ADB Service names and exposed `systemPort` ranges. Do not put private device
  serials or credentials in manifests.
- Create Secret `stf-coordinator-credentials` with keys `stf-token` and
  `api-token` from private files. The first token belongs to an ordinary STF
  service account with access only to the intended device groups. The second
  is a separate high-entropy worker API secret.
- Check the default StorageClass can provision the 1Gi ReadWriteOnce state PVC.
  Preserve this PVC during upgrades, rollbacks and incident investigation.
- Set `--public-url` to a URL reachable by workers. The default is cluster DNS.
  For local port-forward demonstrations set it to `http://127.0.0.1:18080`
  before allocation and forward `18080:8080`.

`kubectl kustomize kuber/coordinator` renders the resources for review. This
prototype has a ClusterIP Service and no Ingress or public DNS requirement.
Health checks disclose no device or token details. Worker/API requests require
a bearer token; the lease WebDriver gateway also supports Basic authentication.

The NetworkPolicy allows clients in `stf`, or a namespace explicitly labelled
`stf-coordinator-access=allowed`; port-forward is an operator access path.
Egress permits cluster DNS, the existing `stf-api` on TCP3000 and Grid router
on TCP4444. The coordinator does not connect directly to ADB. Review selectors
and DNS placement before adapting this deployment to another cluster. If an
upstream URL uses a different service or external HTTPS, update the policy
with that exact destination before starting; do not silently allow all egress.

Use one replica and `Recreate`. The state file and in-process scheduler assume
a single coordinator for these devices and ports. `max-parallel` controls lease
capacity; it does not add coordinator instances or Appium nodes.

To stop the prototype, first cancel/drain leases and verify their cleanup,
then scale the deployment to zero. Keep the state PVC. Do not use
`kubectl delete -k` as a stop command: it would also delete persistent state.
