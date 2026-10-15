# Linux Kubernetes hardware trial — 2026-10-15

Result: the standalone prototype controls an iPhone 16 Plus running iOS 27.0.1
from `k3s-worker-1` (`192.168.0.122`, Linux amd64), in namespace
`stf-ios-prototype`. The Mac Xcode test was stopped before Linux startup.
This does not yet register the phone in the STF UI or Appium Grid.

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

Developer Mode and certificate trust were confirmed on the phone by the user.
Secrets, full pairing records, UDID and screenshots remain outside Git.

## Still pending

This phone was first prepared with Xcode. Linux successfully ran the selected
image-mounter command, but a cold phone reboot followed by fresh Cryptex/DDI
preparation entirely from Linux has not been tested. Also pending: physical USB
unplug/reconnect, landscape control, reboot/passcode recovery, deliberate WDA
failure recovery and profile renewal. The trial proves the current signed,
prepared-device path; these remaining checks are required before treating it as
an unattended farm service.
