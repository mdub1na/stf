# Current Requirements

## Goal

Deploy Android STF as a Kubernetes-based device farm on the existing
Proxmox/k3s infrastructure using GitOps from `mdub1na/stf`, `develop`.
Preserve LDAP data, Android ADB/provider pools, Appium Grid and public domains.
The old MongoDB data may be deleted; iOS and Mac mini changes are out of scope.

## Infrastructure

### Proxmox

- host: `192.168.0.110`

### k3s nodes

The table records original capacity planning, not verified current VM sizing.
Use [the live access inventory](./cluster-access.md) for node/version/access
checks before maintenance; do not resize servers based on this table alone.

| Node | IP | CPU | RAM | Disk | Role |
| --- | --- | --- | --- | --- | --- |
| `k3s-control` | `192.168.0.121` | `4` | `6Gi` | `128Gi` | control / GitOps |
| `k3s-worker-1` | `192.168.0.122` | `6` | `16Gi` | `128Gi` | Android execution |
| `k3s-worker-2` | `192.168.0.123` | `4` | `8Gi` | `128Gi` | storage / stateful |

### Future Apple hardware

Historical capacity only. No iOS deployment or Mac mini maintenance is included
in the Android STF rollout.

| Host | RAM | Disk | Role |
| --- | --- | --- | --- |
| `Mac mini M4` | `16Gi` | `256Gi` | iOS execution |

## Functional scope

- STF browser-based manual testing must be deployed, not rewritten.
- The Android platform must provide:
  - browser access to physical devices
  - Android UI automation support through the retained Appium Grid
  - external ADB access for Android devices

## Device connectivity

- Android devices are physically connected to the Proxmox host.
- Android devices are passed through into one dedicated VM.
- iOS device support is a separate future task, not an acceptance gate here.

## Access requirements

- LAN validation remains useful for low-level diagnostics
- public HTTPS access is enabled through `Traefik`, `cert-manager`, and Let's Encrypt
- STF login uses confidential OAuth through `https://gitlab.finservice.tech`
- allow all users of that GitLab with a verified email; do not require a corporate
  email domain or group membership
- retain OAuth state, S256 PKCE and verified-email checks; STF administrator rights
  are assigned explicitly and are not inherited from GitLab roles
- preserve LDAP data and the LDAP GitOps base until real GitLab login and
  administrator access are confirmed
- `phpLDAPadmin` must remain available

## Capacity targets

- `8` Android devices
- parallel automation is required
- retain two ADB/provider pools and eight Appium nodes per pool
- retain system ports `8200-8209` on each ADB server
- connected-device verification requires actual USB devices; empty ADB lists
  leave screen/touch/capture/APK and test execution pending

## Platform components in scope

- Android STF core services
- `RethinkDB` with fresh storage and an initialization hook
- `OpenLDAP`
- `phpLDAPadmin`
- `Appium Grid`
- `mitmproxy` / `mitmweb` reserved for later work
- observability stack reserved for later work
- `Argo CD`

## Deployment and maintenance boundaries

- Workload changes go through Git and Argo CD. Initial source/project changes,
  separate Secret bootstrap and orphaned MongoDB cleanup are migration exceptions.
- Use a public, verified STF image pinned by digest. Do not commit credentials.
- Deploy on the current healthy nodes first, then update only the three
  Kubernetes VMs once SSH/sudo access is provided. Do not update Proxmox or Mac mini.
- Back up k3s, LDAP, RethinkDB and Secrets before maintenance; update/reboot one
  Kubernetes server at a time without deleting persistent data to enable drain.
- Copied Java tests require STF API adaptation; DeviceHub `/api/v1/autotests`
  endpoints are not part of this deployment.

## Agreed platform stack

- ingress: `Traefik`
- HTTPS certificates: `cert-manager + Let's Encrypt`
- metrics: `Prometheus + Grafana`
- logs: `Loki + Promtail`
- alerting: `Alertmanager`
