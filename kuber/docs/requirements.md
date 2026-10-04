# Current Requirements

## Goal

Deploy DeviceHub as a Kubernetes-based mobile device farm on the current Proxmox, k3s, and Mac mini infrastructure.

## Infrastructure

### Proxmox

- host: `192.168.0.110`

### k3s nodes

| Node | IP | CPU | RAM | Disk | Role |
| --- | --- | --- | --- | --- | --- |
| `k3s-control` | `192.168.0.121` | `4` | `6Gi` | `128Gi` | control / GitOps |
| `k3s-worker-1` | `192.168.0.122` | `6` | `16Gi` | `128Gi` | Android execution |
| `k3s-worker-2` | `192.168.0.123` | `4` | `8Gi` | `128Gi` | storage / stateful |

### Apple hardware

| Host | RAM | Disk | Role |
| --- | --- | --- | --- |
| `Mac mini M4` | `16Gi` | `256Gi` | iOS execution |

## Functional scope

- DeviceHub browser-based manual testing already exists and must be deployed, not rewritten.
- DeviceHub must provide:
  - browser access to physical devices
  - Android and iOS UI automation support
  - external ADB access for Android devices

## Device connectivity

- Android devices are physically connected to the Proxmox host.
- Android devices are passed through into one dedicated VM.
- iOS devices stay outside k3s and are handled through the Mac mini.

## Access requirements

- LAN validation remains useful for low-level diagnostics
- public HTTPS access is enabled through `Traefik`, `cert-manager`, and Let's Encrypt
- `phpLDAPadmin` must remain available

## Capacity targets

- `8` Android devices
- `2` iOS devices
- parallel automation is required

## Platform components in scope

- DeviceHub core services
- `MongoDB`
- `OpenLDAP`
- `phpLDAPadmin`
- `Appium Grid`
- `mitmproxy` / `mitmweb`
- observability stack
- `Argo CD`

## Agreed platform stack

- ingress: `Traefik`
- HTTPS certificates: `cert-manager + Let's Encrypt`
- metrics: `Prometheus + Grafana`
- logs: `Loki + Promtail`
- alerting: `Alertmanager`
