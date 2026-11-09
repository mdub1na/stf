# STF Utils and secure Remote ADB gateway

`stf utils` is the farm user's command-line toolbox. Its first command,
`stf utils adb connect`, connects an Android device already occupied by your STF
account to the ordinary local ADB server used by Android Studio. A foreground
client forwards one ADB transport over verified HTTPS/WebSocket. STF's screen
connection remains independent.

This is an opt-in prototype. No public route or workload is enabled by adding
these files. A physical Galaxy A55 has passed the controlled validation below;
public-ingress deployment and Android Studio GUI validation remain pending.

## Requirements

- Node.js 22.18 or newer on the workstation and gateway.
- The same Android SDK `adb` executable used by Android Studio.
- An STF personal access token and an Android device occupied by that account.
- The workstation's **public** ADB key registered in STF. Keep its private key on
  the workstation. The prototype does not register keys or approve devices.
- A gateway in the provider network, behind an HTTPS ingress with a valid
  certificate. The gateway needs outbound HTTPS access to the configured STF API.

Install only the standalone prototype's dependency:

```sh
npm --prefix tools/adb-tunnel ci --omit=optional --ignore-scripts --no-audit --no-fund
```

The client package is named `stf-utils` for Homebrew and supplies the `stf`
executable. Use `stf utils --help` for the user-command namespace; additional farm
commands can be added there. Homebrew release archives, checksums, generated
formulae and local-tap verification are described in the
[packaging guide](packaging/README.md). These release files are prepared here;
there is no published Homebrew tap or release to install yet.

From a development checkout, `node tools/adb-tunnel/stf.mts utils --help` and
`npm run utils -- --help` work without installing the full STF server. The
repository's existing `bin/stf` also dispatches the `utils` namespace while
retaining server commands such as `provider`, `api` and `app`. Homebrew linking
must not overwrite another installed `stf` executable.

## Gateway

A standalone container and an **inactive** Kubernetes pilot overlay are prepared
in this PR. See the [gateway rollout guide](../../kuber/docs/adb-gateway-pilot.md)
for image builds, offline render checks, digest pinning and activation. The
active farm overlay is unchanged; a published, verified image must be pinned
before enabling the new HTTPS route.

Copy `config.example.json` to an operator-controlled file. It contains no
credentials. Its provider names must match STF's `device.provider.name`; hosts
are trusted internal DNS names and `adbPorts` are explicit **device bridge** ports.
The generic ADB server port `5037` is rejected. Other pools require their own port
mapping; do not expose the entire screen/VNC/provider port range.

```sh
node tools/adb-tunnel/server.mts --config /etc/stf-adb/gateway.json \
  --listen 127.0.0.1:8080
```

Run the process next to a reverse proxy, or select `0.0.0.0:8080` inside a private
container network. Publish `/adb-tunnel/` on the configured `publicUrl` to this
listener. The proxy must preserve the path and Authorization header, support
WebSocket Upgrade and permit long-lived connections. It must not redirect these
API paths to an interactive login page. A separate token-authenticated route is
used; existing browser authentication is unchanged.

Use the deployment's HTTPS ingress to terminate TLS. Keep the unencrypted
gateway listener inside the trusted provider network: never publish it directly
to the internet. `/healthz` is the unauthenticated readiness endpoint.
`stfUrl` and `publicUrl` require HTTPS, with HTTP accepted only on explicit
loopback origins for isolated tests. There is no certificate-verification bypass.

The default configuration matches the two provider pools in this repository.
An endpoint's public hostname is **not** used as a dial destination: the gateway
looks up the provider's configured host and verifies the returned bridge port
against its allowlist. Device-to-port assignments can change after restart.

## Workstation

Create a personal access token in STF settings. Store it in a file owned by the
current user with mode `0600` on POSIX; use a user-private ACL on Windows. Supply
the token through that file, not a command argument or a URL. The prototype
checks POSIX owner/mode and rejects symbolic-link token files. It does not yet
integrate with the OS keychain. `STF_ACCESS_TOKEN` is also supported for controlled
environments, but private token files are preferable for interactive use.

Occupy the phone in STF, then run:

```sh
stf utils adb connect DEVICE_SERIAL \
  --server https://stf.finservice.tech \
  --token-file /private/path/stf-access-token \
  --adb /path/to/Android/sdk/platform-tools/adb
```

The command above assumes that the gateway HTTPS route has been enabled by the
operator. From source, replace `stf` with `node tools/adb-tunnel/stf.mts` and keep
`utils adb connect ...`. The public STF endpoint does not gain this route
automatically. The local port-forward/TLS helper used in the physical test is a
separate development harness, not the Homebrew client.

The CLI requests a session, establishes WSS with certificate/hostname validation,
opens a random `127.0.0.1` port and calls the SDK's ordinary
`adb -H 127.0.0.1 -P 5037 connect 127.0.0.1:PORT`. Pick that device in Android
Studio and leave the CLI running. `Ctrl+C` disconnects only that endpoint and
closes its gateway session; it does not release the phone or stop someone else's
ADB server. A read-only version check refuses an incompatible local server
instead of deliberately restarting it. The local listener assumes a trusted
workstation, like the local ADB server itself.

`--local-port PORT` requests a particular loopback port. Multiple invocations
can connect different phones using separate local ports. `--ca-file CA.pem`
trusts a private/test CA while retaining hostname verification. `--help` lists
the options. There is no background daemon or automatic installation.

## Session and access behavior

1. The gateway calls STF's `/api/v1/user` and
   `/api/v1/user/devices/{serial}` using the caller's token. It requires the exact
   owner email, even for administrators, plus a present/ready Android device.
2. It starts STF Remote ADB and verifies the owner, worker, provider and route
   again before issuing a short-lived connection ticket.
3. The ticket is sent in a WebSocket Authorization header and consumed once,
   before asynchronous authorization. A separate control credential permits
   explicit session deletion. Neither appears in a URL or logs.
4. Before TCP connection and every two seconds while connected, access is
   checked again. A rejected/revoked token, changed owner/worker/route, stopped
   Remote ADB, API failure or check timeout closes the stream. Each check has a
   five-second deadline; polling-based revocation can therefore take roughly
   seven seconds. STF also closes its existing bridge when the owner releases it.
5. Unused tickets expire after 30 seconds. Attached sessions have a separate
   one-hour maximum lifetime. Binary streams and HTTP bodies are bounded, and
   stale WebSockets are closed using heartbeat checks.
6. Stream loss ends the CLI session. It never silently reacquires a phone or
   reconnects a previously issued ticket. Run the command again after selecting
   the device. Closing a browser tab alone is not the access boundary.

The user's STF token is kept only in gateway memory during the session and is
cleared from the session on closure. It is never written to gateway config.
Deleting an ADB public key from STF settings is not an immediate revocation of
keys cached by the old bridge. Stop Remote ADB, release the device or revoke the
STF access token to end this prototype's access.

The old STF owner group is a persistent **user channel**, not a unique lease
generation. This prototype cannot detect every rapid release/reacquire by the
same account between polls while a ticket is unused. Short ticket lifetime and
fresh authorization bound that window; exact generation fencing needs an STF
lease epoch or event integration. Do not describe this as an atomic lease lock.

## ADB compatibility boundary

The gateway validates complete client ADB packets before forwarding them to
the old STF bridge. An allowlist admits device services needed for shell,
APK transfer/install, Logcat, JDWP and ordinary `adb forward`. Shared-server
`host:*`/transport-selection requests are refused instead of being relayed to
the farm's generic smart socket. Malformed/oversized packets close the session.

`adb reverse` is deliberately rejected: the old bridge would target the farm
host rather than the developer's workstation. Rejection currently closes the
whole tunnel. This prototype also does not add ADB TLS/STLS, `abb` services,
modern feature advertisement or incremental installation to that bridge.
Shell-based install/debug fallbacks passed the physical checks below. Current
Android Studio GUI behavior and representative WAN transfer speed still require
validation.

For full `adb reverse` and native feature negotiation, a later backend can
tunnel the phone's actual `adbd` transport. This prototype does not enable TCP
debugging on phones, restart `adbd`, install agents or change their networking.

## Verification

```sh
node --test tools/adb-tunnel/test/*.test.mts
```

Tests use temporary loopback servers and freshly generated certificates
(`openssl` required), without connecting to the workstation's real ADB server
or any phone. The full integration test exercises CLI binary transport through
verified HTTPS/WSS, the gateway, a simulated STF API and ADB backend, then revokes
ownership and verifies disconnection. Other tests cover certificate rejection,
ticket races/replay, owner/admin checks, route restrictions, packet filtering,
timeouts, buffering and cleanup. Test certificates/keys are generated in the OS
temporary directory and removed after use.

The standalone strict type check from a development checkout is:

```sh
node_modules/.bin/tsc -p tools/adb-tunnel/tsconfig.json --noEmit
```

### Physical-device validation — 19 October 2026

The actual CLI and Android SDK ADB 37.0.0 connected a temporarily reserved Samsung
Galaxy A55 (SM-A556E, Android 16) through the prototype gateway. The existing local
ADB server was used without restarting it. The gateway called the real STF HTTPS
API with the authorized test account's token and rechecked ownership throughout.

The controlled route was SDK ADB → CLI loopback listener → verified WSS to a local
TLS frontend → gateway → one Kubernetes port-forward to the provider's assigned
device bridge → phone. A temporary CA was explicitly trusted; certificate and
hostname verification stayed enabled. The provider allowlist admitted only that
device bridge port. This run did **not** deploy a public gateway or exercise an
external ingress for the ADB stream. STF API and screen WSS used the real public
HTTPS/WSS endpoints.

| Check | Observed result |
| --- | --- |
| Native SDK connection and shell | Device online; model/version and shell marker returned |
| APK installation and launch | Own debuggable APK installed successfully and its Activity launched |
| Simultaneous STF screen | Existing screen WSS stayed open during ADB work; JPEG frames visibly showed the installed app |
| File transfer | 1 MiB pushed and pulled; SHA-256 matched; device test file removed |
| Logcat | Own tagged marker retrieved without clearing the device log |
| JDWP and local forward | Real JDWP handshake through an allocated local TCP forward |
| Breakpoint | JDI attached to the app, hit `MainActivity.onCreate` line 16 on the main thread, then resumed execution and detached |
| Release while connected | STF returned owner `null` and Remote ADB disabled; active CLI exited on stream closure and its SDK endpoint disappeared |
| Cleanup | APK absence verified, phone free/present/ready, temporary public-key registration removed, own forwards/listeners stopped |

The second screen observation ran from 14:17:09 to 14:22:42 UTC and received 700
JPEG frames, including app frames during the development checks. It was stopped
explicitly after release. This confirms simultaneous use of STF's actual screen
transport; the STF browser UI and Android Studio GUI were not opened. The JDI
breakpoint proves the debugger transport, rather than an IDE-specific workflow.

The SDK private key stayed on the workstation. Only its public key was registered
for this test and that temporary registration was removed afterward. The existing
STF token was used without revoking or replacing it. Test APK, device file, local
forwards, TLS frontend and Kubernetes port-forward were cleaned up; the preexisting
ADB server remained running with no connected devices, as before the test.

Before deployment acceptance, validate the published HTTPS ingress, run/install
and a breakpoint from Android Studio, representative large APK/WAN performance,
and revocation of a dedicated disposable STF token while connected. Isolated
tests cover token rejection, but live token revocation was not exercised here.
