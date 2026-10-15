# iOS Linux prototype in Kubernetes

Manual prototype deployment, outside Argo CD. It uses the USB worker
`k3s-worker-1` and namespace `stf-ios-prototype`. Existing STF/Android resources
are not edited. The phone must be passed through from Proxmox to this VM.
The [2026-10-15 hardware record](validation-2026-10-15.md) records the first
successful Linux run and its remaining checks.

The image contains Node 24, go-ios v1.3.2 (download checksum verified),
pymobiledevice3 v11.32.0, usbmuxd and iproxy. It contains no signing identities,
WDA artifacts, API tokens or kubeconfig. GitHub Actions publishes only a separate
`ios-prototype-COMMIT_SHA` tag in the existing `ghcr.io/mdub1na/stf` package.
The image job runs for same-repository PRs touching prototype files and develop
pushes; fork PRs only test.

Two containers share one Pod network and the existing host `/run/usbmuxd`
socket. The host's usbmuxd already owns the phone's USB interface; a second
daemon in a Pod fails with `LIBUSB_ERROR_BUSY`. Kernel tunnel creation uses a
privileged `tunnel` container. The API runs as
UID 1000 with all capabilities dropped. No host PID/network namespace or
container-runtime socket is mounted. The API binds loopback; there is no
Service or Ingress, and a NetworkPolicy denies Pod ingress. Use port-forward.

Remote pairing and the developer-image cache persist on a 5 GiB local-path PVC.
USB pairing records remain with the host usbmuxd. Only one replica is supported;
deployment uses Recreate. This deployment requires an existing host usbmuxd
socket, mounted into both containers; it does not install or stop host services.
Start with a
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
Pod can remain 1/2 ready while waiting for USB, Trust, a tunnel or WDA.

Both socket-mounted containers also check that `/run/usbmuxd` accepts connections
every ten seconds. After two failures Kubernetes restarts the affected container
and resolves the host socket path again. This handles hosts that recreate the
socket when the last USB device is unplugged: the previous file mount otherwise
keeps an unreachable inode even after the phone returns. A listening usbmuxd
passes this check without a connected phone; device/WDA recovery still belongs
to the prototype runtime. Repeated daemon outages can incur Kubernetes restart
backoff, so this is recovery rather than an immediate reconnect guarantee.

```sh
export KUBECONFIG='/private/path/k3s-lab.yaml'
kubectl -n stf-ios-prototype get pods -o wide
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

Stop the prototype with
`kubectl -n stf-ios-prototype scale deployment ios-prototype --replicas=0`.
To remove this trial, delete its namespace; that also deletes its local PVC,
remote pairing/cache and API token. USB pairing records managed by the host
usbmuxd remain on the host. Keep the PVC while remote pairing/cache is needed.

## STF integration preview

After the standalone phone is ready, the `STF iOS integration image` CI job
publishes the complete STF application with the `ios-provider` command. Deploy
its commit tag or digest to the preview:

```sh
bash kuber/ios-prototype/integrate-stf.sh /private/path/k3s-lab.yaml \
  ghcr.io/mdub1na/stf:ios-stf-COMMIT_SHA
```

This updates the STF app, API and WebSocket unit, then adds an unprivileged provider
sidecar to the existing phone Pod. It does not change Android providers or the
database. The example targets the existing `stf.finservice.tech` deployment;
adjust the public origin, screen URL and internal service names for another
installation. Set `--market-name` for the connected phone; the model identifier
and iOS version come from the device.

The provider registers an ordinary STF device with platform `iOS`. The current
preview supports portrait viewing, single-finger taps/swipes, Home, text input
and screenshots. iOS pages hide APK/ADB, shell, logs, file exploration and
rotation commands. Long press, multi-touch, clipboard read, app installation,
landscape and Appium Grid registration remain outside this preview.

Screen traffic is exposed only through the existing dynamic proxy. The provider
accepts the configured browser origin and authenticates the forwarded signed
session cookie against the STF owned-device API. Missing/non-owner credentials
are rejected, access is checked again every five seconds, and release or backend
recovery closes viewers immediately. Socket.IO checks iOS ownership and group
visibility before forwarding controls. The private prototype API stays on
loopback; its token is never sent to the browser.

This is a manual preview deployment on the PR branch. Argo CD's desired images
still point to `develop`; synchronizing that application can revert the app and
WebSocket images. Remove the iOS provider sidecar before syncing an older STF
revision: its command authorization requires the updated WebSocket service. Promote the image through the normal GitOps process after
review and merge.

To roll back, first remove the provider sidecar, then restore the recorded
pre-preview app/API/WebSocket image digests and remove the preview network objects:

```sh
kubectl --kubeconfig /private/path/k3s-lab.yaml -n stf-ios-prototype \
  patch deployment ios-prototype --type=strategic \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"stf-provider","$patch":"delete"}]}}}}'
# Restore stf-app, stf-api and stf-websocket with `kubectl set image` and saved digests.
kubectl --kubeconfig /private/path/k3s-lab.yaml delete -f kuber/ios-prototype/stf-network.yaml
```
