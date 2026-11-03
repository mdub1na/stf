# Preparing the Remote ADB Internet pilot

These files prepare a deployment candidate. They do not activate it. The STF
Application still tracks `kuber/gitops/stf-gitlab` with manual synchronization;
the new `kuber/gitops/stf-adb-pilot` overlay is not referenced by any Application.
No gateway image has been published as part of this preparation. Its explicit
`unpublished-do-not-apply` image marker must never be deployed.

## Image and local checks

The standalone image uses only Node and the locked `ws` dependency, with no ADB
SDK, USB access or STF server dependencies. Its official base is
`node:22.23.2-bookworm-slim`, pinned to the real multi-architecture index
`sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`.
The index was read from Docker Hub's Registry API on 20 October 2026 and contains
Linux amd64 and arm64 images. Update the digest deliberately when refreshing Node.

```sh
docker build -t stf-adb-gateway:test tools/adb-tunnel
python3 kuber/scripts/check-adb-pilot.py
```

The validation script uses only `kubectl kustomize`, without cluster access. It
renders the current GitLab overlay and the inactive pilot, proves that existing
STF objects remain unchanged, checks the four gateway resources and prevents an
Application switch while the pilot image is unpinned. It does not validate live
admission policies, network reachability or ingress behavior.

The ADB gateway image workflow builds amd64 and arm64 images on native runners
and starts each actual image with a read-only root filesystem, no capabilities,
no elevated privileges and no network access. Health is checked from inside the
container, and a root-filesystem write is required to fail. PR checks never log
in to GHCR or push images.

Publication is a separate, explicit manual action through the already registered
`Docker` workflow. After the change is merged to `develop` and publication is
separately authorized, use:

```sh
gh workflow run docker.yml --ref develop -f component=adb-gateway -f publish_gateway=true
```

The existing entrypoint calls the reusable gateway workflow from that same
`develop` commit. This avoids relying on registration of a new manual workflow
on this fork's default branch (`master`). `component=farm` remains the default,
preserving existing farm-image behavior. Selecting `adb-gateway` skips farm
builds; `publish_gateway=false` runs gateway checks without publishing. Only an
explicit manual gateway publication on `develop` can push images. Other refs
and ordinary PR events cannot publish. Tested architectures are combined as
`ghcr.io/mdub1na/stf-adb-gateway:<commit SHA>`. This preparation does not merge the
PR, dispatch publication or change package visibility. Confirm that cluster
nodes can pull the resulting package.

## Activation contract

Only after a separate rollout authorization and a successful published build:

1. Inspect the published multi-architecture image with
   `docker buildx imagetools inspect ghcr.io/mdub1na/stf-adb-gateway:<commit SHA>`.
   Record its actual `sha256` index digest and confirm amd64/arm64 coverage. Do
   not substitute a source commit SHA for a registry digest.
2. In the pilot `kustomization.yaml`, remove `newTag` and set `digest` to that
   verified `sha256:...` value. Review this image pin as an ordinary GitOps change.
3. Run the offline render check and review the full resulting diff. The pilot
   adds only a ConfigMap, Deployment, ClusterIP Service and separate Ingress.
   The ConfigMap contains trusted provider DNS names and explicit per-device ADB
   ports; it contains no user access token or shared session secret.
4. From the intended provider network, verify DNS and HTTPS reachability to
   `https://stf.finservice.tech` with normal certificate validation, plus TCP
   access to the configured device bridges. Public-DNS/hairpin reachability from
   the gateway pod was not established by the earlier local port-forward test.
5. Review the Argo Application source change to `kuber/gitops/stf-adb-pilot` and
   authorize its manual synchronization in the explicit lab cluster context.
   Keep the current `stf-gitlab` source recorded as the rollback target. Neither
   Argo source nor any cluster resource is changed by this document.

Use one replica with `Recreate`: tickets and attached streams live in process
memory. Scaling or overlapping rolling replicas needs session routing/storage
design first. A restart intentionally ends existing sessions and requires users
to reconnect; it never transparently reacquires a phone.

The deployment runs as UID/GID 1000 with RuntimeDefault seccomp, a read-only root,
all capabilities dropped and no service-account token. Its only volume is the
read-only generated configuration; no host device, shared auth secret or
Kubernetes API permission is needed. Network policy is not claimed by these
manifests: provider/API/DNS connectivity follows the cluster's existing policy.

## HTTPS route and pilot acceptance

The separate Ingress exposes `/adb-tunnel/` only on `websecure` using the existing
`stf-finservice-tech-tls` certificate. Keep the request path, Authorization header
and WebSocket Upgrade intact. Do not attach browser-login middleware, strip the
prefix, redirect to GitLab OAuth or log Authorization headers. The internal
plain HTTP listener remains behind the ClusterIP; no raw ADB port, NodePort or
shared farm ADB server port `5037` is published. `/healthz` is used by pod probes
and has no separate public route.

Before calling the pilot available, verify certificate/hostname validation and
the actual external ingress from a workstation without the previous local TLS
frontend or Kubernetes port-forward. Use the developer's own STF token, public
ADB key and occupied Android device. Run/install, Logcat, a real Android Studio
breakpoint, simultaneous STF screen, release while attached and revocation of a
dedicated disposable token are the acceptance checks. Record WAN transfer
behavior with a representative APK. Existing local-device and JDI results do not
replace these public-ingress and GUI checks.

Rollback switches the Application back to its recorded `stf-gitlab` source and
manually synchronizes removal of only the pilot gateway objects. Verify the Argo
prune diff before approving it; existing STF resources must stay unchanged.
Terminate pilot streams, preserve the normal ADB server and release only devices
reserved for the test. The user's browser login and existing screen routes are
independent of this gateway.
