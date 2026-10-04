# Known Bugs (Backlog)

## Bug: `ios-provider` crashes when `serial` filter is used

### Status
- Open
- Priority: medium
- Scope: upstream DeviceHub code (not `kuber` manifests/scripts)

### Where it happens
- File: `lib/cli/ios-provider/index.js`
- Current code:
  - `filter: !argv.serial?.length ? null : (serial => argv.serial.find(serial))`

### Symptoms
- `ios-provider` starts, then exits with:
  - `TypeError: argv.serial.find is not a function`
  - or
  - `TypeError: string "..." is not a function`
- Triggered when passing one or more iOS UDIDs to `ios-provider [serial..]`.

### Root cause
- `Array.prototype.find` is called with a string value instead of a predicate function.
- The filter function is invalid and throws during device matching.

### Proposed fix (for later)
- Replace buggy expression with a valid membership check:
  - `filter: !argv.serial?.length ? null : (serial => argv.serial.includes(serial))`

### Temporary workaround (current project policy)
- Do not patch core repository code now.
- Run `ios-provider` without serial filtering and handle device selection operationally.
- Keep this issue documented and return to it later as a dedicated upstream fix.

## Bug: `ios-provider` detects non-iOS USB dongles as phantom devices

### Status
- Confirmed in local lab
- Priority: high (causes noisy restarts and ghost devices in UI)
- Scope: runtime environment + USB device detection behavior

### Symptoms
- `ios-provider` logs phantom device like `7423J07` even when only iPhones are expected.
- Device appears in DeviceHub UI with broken state (`display.url` empty), may trigger `No display url`.
- Provider repeatedly restarts worker process for phantom serial.

### Root cause (observed)
- A non-iPhone USB dongle (Bluetooth mouse receiver) connected to Mac mini was detected by provider USB observer as an Apple-like serial.
- The serial was treated as an iOS device candidate and entered normal registration flow.

### Resolution in lab
- Physically unplug non-iOS USB dongle from Mac mini.
- Restart `ios-provider`.
- Reconnect only real iPhones.
- Result: both real iPhones detected correctly, UI control works.

### Preventive note
- Keep Mac mini USB bus clean from unrelated dongles while running iOS farm.
