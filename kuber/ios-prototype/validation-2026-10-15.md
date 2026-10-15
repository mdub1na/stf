# Linux Kubernetes hardware trial — 2026-10-15

Result: the standalone prototype controls an iPhone 16 Plus running iOS 27.0.1
from `k3s-worker-1` (`192.168.0.122`, Linux amd64), in namespace
`stf-ios-prototype`. The Mac Xcode test was stopped before Linux startup.
This does not yet register the phone in the STF UI or Appium Grid.

The subsequent STF integration is implemented and built; its rollout and
end-to-end phone check are pending cluster connectivity (see the final section).

## Artifact and transport

- Image source commit: `61b83916c5d57eb325309e8c93df3fae458cc9c5`.
- Deployed image: `ghcr.io/mdub1na/stf@sha256:25ecd5d7c0ed84ed1323a7e7c7377943e336c0f14355e1a293246fe39d1ac77f`.
- Node 24.22.0, go-ios 1.3.2, pymobiledevice3 11.32.0, iproxy 2.0.2.
- WDA 16.15.0, built/signed with Xcode 27 and a free Personal Team; installed
  runner ID `dev.mdub1na.stf.WebDriverAgentRunner.xctrunner`.
- This build's profile expires 2026-10-22 at 21:07, Asia/Yekaterinburg.
- Proxmox USB passthrough reaches the Linux VM. Its existing host usbmuxd owns
  the phone. A competing Pod daemon failed with `LIBUSB_ERROR_BUSY`, so the final
  deployment mounts only the host `/run/usbmuxd` socket. Host services were not
  stopped or reconfigured.
- The Pod contains the go-ios kernel tunnel and the unprivileged Node API.
  Remote pairing/cache persist on the PVC; USB pairing belongs to host usbmuxd.
  There is no Service/Ingress or Mac endpoint in the runtime configuration.

## Observed checks

| Check | Result |
| --- | --- |
| Image CI | Native HTTP/process tests: 22 passed; installed tools and entry point checked inside image |
| Linux compatibility CI | Node 22.18.0 and Node 24 passed |
| Kubernetes manifest | API server dry run and actual deployment succeeded |
| Doctor | All seven checks passed on Linux, including selected device, pairing and RSD tunnel |
| Device API | `ready`, no startup error; Pod 2/2 Ready |
| Screenshot through local port-forward | PNG, 1290×2796, 431764 bytes in the recorded request |
| MJPEG through local port-forward | HTTP 200, multipart JPEG stream received and client closed |
| Home and app activation | HTTP 200; Settings activated |
| Swipe and tap | HTTP 200; Settings scrolling/header touch |
| Text | Entered `STF prototype` into the identified Settings search field through `/text`, read value back, cleared it |
| Pod recreation | Returned to 2/2 Ready and produced a new screenshot without a new Trust confirmation |
| Owned WDA session loss | Deliberately removed the prototype session; recovered in 9451 ms, generation advanced 2→3 and a new PNG was returned |
| Child cleanup | After recovery, exactly one iproxy process and one owned go-ios WDA runner remained |

Developer Mode and certificate trust were confirmed on the phone by the user.
Secrets, full pairing records, UDID and screenshots remain outside Git.

## Still pending

This phone was first prepared with Xcode. Linux successfully ran the selected
image-mounter command, but a cold phone reboot followed by fresh Cryptex/DDI
preparation entirely from Linux has not been tested. Also pending: physical USB
unplug/reconnect, landscape control, reboot/passcode recovery, abrupt WDA process
termination and profile renewal. The trial proves the current signed,
prepared-device path; these remaining checks are required before treating it as
an unattended farm service.

## STF integration preview — rollout pending

Integration source: `ce98440ca26f8dbd961112850de6a642fd5387ae`.
Published amd64 image:
`ghcr.io/mdub1na/stf@sha256:c1ca9f65323bc164b112a2c71c944811e17b62fefd37695beb9cd78c26d5e4aa`.

The new `ios-provider` registers the phone through STF's existing wire protocol,
handles ownership, translates touch/text/Home commands, uploads screenshots and
bridges WDA MJPEG to the existing screen WebSocket protocol. Screen access checks
both the authenticated STF identity and owned-device visibility. The iOS UI
shows Dashboard, Screenshots and Info; unsupported Android controls are hidden.

Verified before deployment:

- Local build, lint/type/translation checks passed.
- Server unit suite: 253 passed, including seven new iOS integration tests;
  standalone prototype tests: 22 passed.
- Component suite: 68 passed, including three iOS/Android control checks.
- CI build, lint, unit, component and device-less integration checks passed for
  the source commit; standard amd64/arm64 and Debian image builds passed.
- STF integration image publication and Linux Node 22.18/24 prototype checks passed.
- Kubernetes server dry runs accepted the provider patch and scoped screen network objects.
- Baseline immediately before the preview: four present, ready Android devices.

The first rollout changed the desired `stf-websocket` image. Its new Pod could
not pull from GHCR because the node reported `lookup ghcr.io: Try again`; the
previous Pod remained 1/1 Running. The Kubernetes API at `192.168.0.121:6443`
then stopped responding from the development Mac, as did a short connection
check to the USB VM. The public STF site still returned HTTP 302. The rollout
script was stopped while waiting for the WebSocket deployment, before it could
update the app or add the iOS provider/network objects. The phone has therefore
not yet been verified in the live STF interface.

After connectivity returns:

1. Inspect the pending WebSocket rollout and the GHCR DNS/image-pull error.
2. Remove `ios-image-check` in `stf-ios-prototype` if the timed-out diagnostic
   Pod creation reached the API server.
3. Run `integrate-stf.sh` with the published digest above.
4. Verify the iPhone's listing, reservation/release, authenticated JPEG stream,
   Home, taps/swipes, text and stored screenshots through STF. Check that an
   anonymous client and a second non-owner cannot view or release it.
5. Hide the screen for more than 60 seconds, resume it, and confirm release
   closes the viewer. Recheck the four Android devices.

No temporary validation users were created before connectivity was lost.
The previously observed standalone Linux/WDA results above remain separate
from this unfinished STF end-to-end check.
