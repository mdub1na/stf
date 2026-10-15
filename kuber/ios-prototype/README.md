# iOS Linux prototype in Kubernetes

Manual prototype deployment, outside Argo CD. It uses the USB worker
`k3s-worker-1` and namespace `stf-ios-prototype`. Existing STF/Android resources
are not edited. The phone must be passed through from Proxmox to this VM.

The image contains Node 24, go-ios v1.3.2 (download checksum verified),
pymobiledevice3 v11.32.0, usbmuxd and iproxy. It contains no signing identities,
WDA artifacts, API tokens or kubeconfig. GitHub Actions publishes only a separate
`ios-prototype-COMMIT_SHA` tag in the existing `ghcr.io/mdub1na/stf` package.
The image job runs for same-repository PRs and develop pushes; fork PRs only test.

Three containers share one Pod network and usbmuxd socket. USB access and kernel
tunnel creation use privileged `usbmuxd`/`tunnel` containers. The API runs as
UID 1000 with all capabilities dropped. No host PID/network namespace or
container-runtime socket is mounted. The API binds loopback; there is no
Service or Ingress, and a NetworkPolicy denies Pod ingress. Use port-forward.

Pairing records, remote pairing and the developer-image cache persist on a
5 GiB local-path PVC. Only one replica is supported; deployment uses Recreate.
An existing host usbmuxd must not compete for the same phone. Start with a
development-signed, installed and trusted WDA as described in
[the hardware runbook](../../doc/ios-prototype.md).

Set the private kubeconfig path explicitly; do not rely on the current context.
Create a token outside Git and deploy the image published for the selected
commit (or use its immutable `ghcr.io/mdub1na/stf@sha256:...` digest):

```sh
umask 077
mkdir -p ~/.local/state/stf-ios
openssl rand -hex 32 > ~/.local/state/stf-ios/token
bash kuber/ios-prototype/deploy.sh /private/path/k3s-lab.yaml \
  ghcr.io/mdub1na/stf:ios-prototype-COMMIT_SHA \
  YOUR_UDID YOUR_INSTALLED_WDA_RUNNER_BUNDLE_ID ~/.local/state/stf-ios/token
```

The readiness probe checks the device state, not just API liveness. A running
Pod can remain 2/3 ready while waiting for USB, Trust, a tunnel or WDA.

```sh
export KUBECONFIG='/private/path/k3s-lab.yaml'
kubectl -n stf-ios-prototype get pods -o wide
kubectl -n stf-ios-prototype logs deployment/ios-prototype -c usbmuxd
kubectl -n stf-ios-prototype logs deployment/ios-prototype -c tunnel
kubectl -n stf-ios-prototype logs deployment/ios-prototype -c prototype
kubectl -n stf-ios-prototype exec deployment/ios-prototype -c prototype -- \
  node tools/ios-prototype/main.mts --doctor --udid YOUR_UDID \
  --image-mounter pymobiledevice3
kubectl -n stf-ios-prototype port-forward deployment/ios-prototype 7400:7400
```

In another terminal, use the authenticated API examples from the hardware
runbook. Stop any Mac Xcode/WDA test before starting Linux control of this phone.
No Mac process participates in this deployment's runtime.

Stop the prototype with `kubectl -n stf-ios-prototype scale deployment
ios-prototype --replicas=0`. To remove this trial completely, delete its
namespace; that also deletes its local PVC, pairing records and API token.
Do not delete the PVC if pairing/cache persistence is still needed.
