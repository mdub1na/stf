# Linux Kubernetes hardware trial — 2026-10-15

Result: the standalone prototype controls an iPhone 16 Plus running iOS 27.0.1
from `k3s-worker-1` (`192.168.0.122`, Linux amd64), in namespace
`stf-ios-prototype`. The Mac Xcode test was stopped before Linux startup.
The subsequent STF integration also passed its live trial later the same day
(see the final section). Appium Grid registration remains outside this preview.

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
- The initial standalone Pod contained the go-ios kernel tunnel and unprivileged Node API.
  Remote pairing/cache persist on the PVC; USB pairing belongs to host usbmuxd.
  That standalone configuration had no Service/Ingress or Mac endpoint. The later
  STF preview adds only the authenticated screen service described below.

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

## STF integration preview — live trial passed

The phone is registered in the existing STF instance as **iPhone 16 Plus**,
platform **iOS**, version **27.0.1**, display **1290×2796**. All three containers
in `stf-ios-prototype` are Ready. No Mac WDA/Xcode process participates in runtime.

Artifacts currently used:

- iOS provider source: `caa2586ed8ab680f1a3e79e53b3832ebbfba6bba`.
- iOS provider image: `ghcr.io/mdub1na/stf@sha256:216e9046e9c9ac2d321cf21d0b2384f3000bdff11cebed939e1402ee005b184b`.
- STF app/WebSocket image: `ghcr.io/mdub1na/stf@sha256:c1ca9f65323bc164b112a2c71c944811e17b62fefd37695beb9cd78c26d5e4aa`
  (source `ce98440ca26f8dbd961112850de6a642fd5387ae`; its UI/command authorization
  code is unchanged by the subsequent provider-only MJPEG fix).
- Tunnel and prototype API retain the standalone image recorded above.

The provider uses STF's existing registration, ownership and command protocol.
Its screen endpoint verifies the authenticated STF identity, owned-device group
visibility and browser origin. Socket.IO checks iOS ownership before forwarding
commands. The UI exposes Dashboard, Screenshots and Info, with unsupported
Android commands hidden. The prototype token stays inside the Pod.

### Verified through STF

The trial used the real STF API, Socket.IO control messages and public dynamic
screen proxy. It did not automate a desktop browser. Two temporary users
exercised owner/non-owner behavior and were deleted after each test attempt.

| Check | Observed result |
| --- | --- |
| Device list and ownership | iPhone listed, claimed, then released successfully |
| Screen authentication | Anonymous and second non-owner clients both received HTTP 403 |
| Command authorization | Non-owner release request was blocked; the owner retained control |
| JPEG stream | 55 frames received during the trial; first JPEG 125040 bytes |
| Tap, paste, typing and Backspace | Sent through STF; the Settings search field read back the exact expected 23-character value through WDA |
| Text cleanup | Test value cleared from the phone |
| Screenshot | Uploaded through STF storage and downloaded as a valid PNG, 100725 bytes |
| Hidden screen | WebSocket remained open after 65 seconds with viewing disabled |
| Resume | New frames arrived after viewing was enabled again |
| Swipe and Home | STF gesture/Home commands completed; Springboard was confirmed as the active application |
| Release | Ownership released and the viewer connection closed |
| Final device state | iPhone free; all seven present devices Ready: one iOS and six Android |
| Test account cleanup | No `ios-validation-` users remained |
| Temporary Pod cleanup | Image-check Pods removed; only the three-container iOS Pod remained |
| API cleanup | With explicit user approval, the API was restarted to remove a leftover read-only diagnostic process; availability/device state rechecked |

The Android providers, ADB servers, processor and database images were not
changed. The final API restart retained its existing image and configuration.

### Real-device issue found and corrected

WDA 16.15.0 appends `\r\n\r\n` after each JPEG body. The initial multipart
decoder treated that separator as an empty next-part header and closed the
screen. The fix skips complete CRLF pairs between parts while preserving partial
network chunks. Regression tests cover coalesced and byte-by-byte WDA parts,
and the corrected decoder was checked against ten real frames before its image
was deployed. The live STF stream then passed the table above.

The first deployment also encountered a transient node GHCR DNS error and loss
of Mac connectivity to the cluster. After connectivity returned, normal image
pulls succeeded without changes to host services or the container runtime. An
uncached 682 MiB image took about 4–5 minutes to pull, so deployment waits now
allow ten minutes. The corrected provider image was pre-pulled before replacing
the running iOS Pod.

### Build and rollout status

Local build/lint/type/translation checks passed. The server suite passed 253
tests, the standalone prototype suite 22, and the component suite 68. The source
commit's CI covers the normal build, lint, unit/component and device-less
integration checks, the Android matrix, standard amd64/arm64 and Debian builds,
and separate published prototype/STF integration images.

The [source CI run](https://github.com/mdub1na/stf/actions/runs/38784610590)
passed its core checks and the other Android tiers, but its overall report is
red because the Android 12 / API 31 emulator did not finish booting after two
attempts. Tests could not start on that emulator; this was not a failed STF
assertion. Keep the PR in draft until required checks are green.

This remains a manual preview on the open PR branch. Argo CD still targets the
older `develop` images. Remove the iOS provider before syncing an older STF
revision; its command authorization requires the updated WebSocket service.
Use the deployment and rollback steps in README for a repeatable preview.

Cold phone reboot/fresh Linux Cryptex preparation, physical USB reconnect,
landscape, multi-touch, long press, profile renewal and Appium Grid registration
remain unverified or unsupported as described in the runbook. Browser visual
inspection remains a manual check for the operator.
