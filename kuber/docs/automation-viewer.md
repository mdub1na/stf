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
of the Appium harness change (PR #5). The running farm has not been updated by
this change; rollout needs matching app, websocket and iOS-provider images.
