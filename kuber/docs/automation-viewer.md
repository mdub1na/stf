# Automated device viewing

A device reserved through `POST /api/v1/user/devices` is marked with
`usage: automation`. The existing Appium harness already uses this API. Direct
Appium sessions that bypass STF reservation are outside this status contract.
The runner must quit Appium before releasing the STF device, including on test
failure. Reservation expiry is the fallback when the runner disappears.

## User behavior

- A ready phone with an automation owner shows **Automated** in violet for all
  users who can access its device group, including users other than the runner.
- Its card, name and status open a viewer without sending a group invite or kick.
- Live screen viewing and local show/hide remain available. Touch, keyboard,
  hardware keys, context commands, rotation and drag/drop installation are
  disabled. Other interaction tabs are disabled; the information tab remains
  readable. The behavior applies to Android, iOS and standalone viewers.
- Ending automation stops the ownership-bound stream. The viewer shows
  “Automation finished”; only an explicit **Use** action can acquire a free
  phone and restore manual controls. A following test is not interrupted.

## Enforcement

`res/app/src/core/control.ts` guards outgoing UI commands. The websocket unit
also checks the current device lease before forwarding manual commands, so an
old tab cannot bypass the disabled controls. It denies automation commands for
owners and administrators too. Commands retain ordering; a join-event guard
covers the interval before database persistence. Release and device recovery
clear that guard. Appium continues through its own Grid/WDA/ADB connection, and
the runner can still release its reservation through the STF API.

The iOS bridge preserves automation usage in `JoinGroupMessage`. Screen access
continues to require an authenticated same-origin request (or a bearer client).
Owners use the owned-device API; other viewers must pass the ordinary visible-
device API and the device must still be automated under the current owner.
Periodic checks and ownership changes revoke streams. Screen viewers do not
extend automation leases.

## Validation and delivery

Component tests cover cross-owner status, disabled controls, command suppression,
stream recovery, opening without ownership changes, explicit acquisition after
release and an immediately following test. Node tests include a real authenticated iOS screen WebSocket, usage propagation
and the server lease guard for Android/iOS. Lint, types, translations and the production build are
checked without opening a browser.

This change is based on the Linux iOS integration branch (PR #4), so its PR is
targeted there to keep the diff limited to automation viewing. It is independent
of the Appium harness change (PR #5). On 2026-10-18 the operator requested a live demonstration. The app, websocket and
iOS-provider containers were updated to the CI-built preview image
`ghcr.io/mdub1na/stf@sha256:a0a370c0beaac2930cf83ca9b6bca9e3771bb142722f1f475e15e24d4abefaa4`.
This is a manual preview rollout; the pull requests remain unmerged.

## Live demonstration — 2026-10-18

A Samsung A55 and iPhone 16 Plus ran the Kotlin Settings demonstrations in
parallel through the public Appium Grid. Both completed 12 up/down cycles:
Android passed in 119.897 seconds and iOS in 135.364 seconds. The operator
confirmed the violet Automated status, live scrolling and disabled controls.

A temporary runner owned the phones. A separate temporary ordinary viewer,
which owned neither phone, received both screen streams and was denied
`shell.command` through the actual STF websocket before any device command was
forwarded. The command payload was the harmless `true` for this diagnostic.
The observer joined part-way through the runs and received 705 Android frames
(529 distinct) and 435 iOS frames (110 distinct). On release the iOS stream
closed; the Android observer sent `off` and closed, as the UI does when it loses
screen interest. The accounts held zero phones afterward; both temporary users
and their credentials were removed, and revoked tokens returned HTTP 401.

An extra account is not required for Automated. The status follows the STF API
reservation usage. These separate accounts only exercise a CI-runner/non-owner-
viewer scenario; the same operator account may also own and watch a test.

The existing Compose CI check used anchor-specific selectors for the hardware
keys. Those controls are native disabled-capable buttons now, so its selectors
were updated to the stable `device-control-key` attribute. This selector change
was not tested by opening a browser locally.
