# STF Deployment Runbook

The user confirmed deployment on the current healthy nodes first and deferred
server maintenance until SSH access is provided; see
[the rollout plan](./stf-rollout-plan.md). Do not switch Argo CD to a revision
whose image has not built successfully and cannot be pulled by nodes.

## Image

GitHub Actions builds the root Dockerfile on pushes to `develop` and publishes
`ghcr.io/mdub1na/stf:<full-commit-sha>`. The base deployment image is centralized in
the `devicehub` and `rethinkdb` kustomizations and pinned by registry digest.
The GitLab overlay separately pins the auth image described below.
GitOps-only changes do not trigger a new application image build.

Verified build on 2026-10-04:

- Source commit: `1b0390e4efce43c5635175e6d03a4290880f6390`.
- Successful [workflow run](https://github.com/mdub1na/stf/actions/runs/37221865853)
  for Linux amd64 and arm64, followed by multiarch publication.
- Pinned image:
  `ghcr.io/mdub1na/stf@sha256:9da0a528f91c5ced4594ee1706392042808819276675311827e516b4971c4e81`.
- Anonymous registry manifest access returned HTTP 200; no visibility setting
  was changed. The user confirmed a public package. Kubernetes runtime pull
  remains a live deployment check.

A private GHCR package requires node pull credentials in both namespaces;
publishing alone does not imply anonymous access. Recheck access before rollout
if package visibility changes.

## Public address

The farm's canonical address is <https://stf.finservice.tech> since 2026-10-05.
Its DNS A-record targets `46.191.173.144`. Argo CD, LDAP administration and Appium
Grid keep their existing domains. Cluster-internal service names are unchanged.

`gitops/devicehub/stf-certificate.yaml` declares Certificate and TLS Secret
`stf-finservice-tech-tls` using the existing `letsencrypt-http` Issuer. The farm
ingress has no ingress-shim issuer annotation because Certificate ownership is
explicitly managed by GitOps. For another domain change, issue the new
Certificate first, wait for Ready, then change ingress and all app/auth,
WebSocket/storage and provider public URLs. Restart ConfigMap consumers through
their pod-template annotations; a ConfigMap update alone does not reload env.

New-domain TLS, login page/assets, auth redirect/database query, API 401,
WebSocket and temp storage round-trip were verified. Old generated Certificate
and TLS Secret were removed after validation; session and LDAP Secrets were not
rotated. Existing users need a new login because cookies are hostname-scoped.

The laptop resolver still returned the former `136.115.23.98` address during
verification, while authoritative/public/cluster DNS returned the correct IP.
If a client still sees the previous destination, wait for its DNS cache to
expire. A targeted check preserves hostname and full certificate validation:

```sh
curl --resolve stf.finservice.tech:443:46.191.173.144 \
  --head https://stf.finservice.tech/
```

Do not disable TLS verification to work around a cached DNS answer.

## Secret bootstrap

The `devicehub` slice retains historical resource names and runs STF, not
DeviceHub. Its base image is replaced by Kustomize; apply the slice with Argo CD,
not individual base Deployment files.

Before the first source change, run:

```sh
export KUBECONFIG='/Users/mdub1na/Desktop/devicehub home cluster/k3s-lab.yaml'
node kuber/scripts/bootstrap-stf-secrets.mjs
```

The script checks the target API and current LDAP administrator bind, copies
the existing LDAP password to Secrets, creates a random STF session secret,
and preserves already-existing Secrets. It neither resets LDAP nor prints
credential values. Run it before removing credentials from the live ConfigMap.
Secrets are bootstrap state outside Git; their values must be kept outside the
repository for disaster recovery.

Required Secrets:

| Namespace | Secret | Required key |
| --- | --- | --- |
| openldap | openldap-credentials | LDAP_ADMIN_PASSWORD |
| devicehub | devicehub-ldap-bind | LDAP_BIND_CREDENTIALS |
| devicehub | devicehub-session | SECRET |

## GitLab login

GitLab provider: <https://gitlab.finservice.tech>. The approved access policy is
all users of this GitLab whose userinfo contains a verified email; there is no
email-domain or group restriction. GitLab roles do not grant STF administrator
rights. Existing STF users are matched by email and keep their existing display
names and privileges. A different email creates a separate STF account.

Register a confidential OAuth application in GitLab with redirect URI
`https://stf.finservice.tech/auth/oauth/callback` and scopes `openid profile email`.
Do not grant repository, `api` or `read_api` access. The configured endpoints are
`/oauth/authorize`, `/oauth/token` and `/oauth/userinfo` on this GitLab only.
They were discovered over verified HTTPS on 2026-10-05, including a check from
the running STF auth container.

The `auth-oauth2` unit requires state protection, enables S256 PKCE by default,
and requires `email_verified: true` by default. Its signed, HttpOnly, SameSite=Lax
state cookie is separate from the STF session cookie, scoped to `/auth/oauth`,
and Secure for an HTTPS callback. State expires after ten minutes on the server.
Missing/invalid state and missing/unverified email fail closed. Provider or
database errors never issue a login JWT or expose provider response details.

The OAuth image was built from source commit
`9adc78cd3d94a4de5d3df005eeae9afa6366ba71` by successful
[workflow run](https://github.com/mdub1na/stf/actions/runs/37283650695).
Its public amd64/arm64 digest is
`sha256:d94f67077c4d8a9a6d357ea0c58bdb2395233d56c605288846c323e7d4dace76`.
The overlay pins this image for auth only; app uses the unchanged base image
with its new configuration. Providers, ADB, storage, WebSocket, RethinkDB and
Appium images and pod templates are unchanged by this cutover.

GitLab must return both `email` and `email_verified` from userinfo. Depending on
GitLab settings, users may need to select a public email in their profile.
See [GitLab's claim documentation](https://docs.gitlab.com/integration/openid_connect_provider/).
Do not disable email verification to work around an absent claim.

Store credentials outside Git as a JSON object with `clientId` and `clientSecret`.
Pass it through stdin, not shell arguments or environment literals:

```sh
export KUBECONFIG='/Users/mdub1na/Desktop/devicehub home cluster/k3s-lab.yaml'
node kuber/scripts/bootstrap-stf-gitlab-secret.mjs < "$HOME/.config/stf/gitlab-oauth.json"
```

The script checks the target API, creates/updates Secret
`devicehub/stf-gitlab-oauth`, and prints no credential values. Required keys are
`STF_AUTH_OAUTH2_OAUTH_CLIENT_ID` and `STF_AUTH_OAUTH2_OAUTH_CLIENT_SECRET`.
The existing `devicehub-session` Secret is retained; no session key is rotated.

The root child Application selects `kuber/gitops/stf-gitlab`, which extends the
LDAP base and changes only app/auth configuration, the auth image and its
Secret reference. It does not create a second farm or change
ADB/Appium/Ingress/storage. Before selecting it in the
existing `devicehub` Argo CD Application:

1. Build/publish the image containing the OAuth fixes, pin its digest, and verify
   node pull access. The pre-fix image cannot safely use this configuration.
2. Bootstrap the OAuth Secret and verify GitLab HTTPS access from the auth pod.
3. Render the overlay, inspect the differences, and change the existing child
   Application's GitOps source path to `kuber/gitops/stf-gitlab`.
4. Synchronize the existing Application. Check its auth redirect, secure state
   cookies, PKCE parameters and rejected unsolicited callbacks.
5. Confirm a real GitLab login and STF administrator access. Administrator
   promotion/mapping must be explicit if the GitLab email differs from LDAP.

For rollback, return that Application's source path to `kuber/gitops/devicehub`
in `kuber/gitops/root/devicehub-app.yaml`, commit/push the change, then synchronize
the root and existing child. A live-only Application edit would be reverted by
root self-heal. LDAP data, its bind Secret and the LDAP base are retained
until GitLab login and administrative access are confirmed. Existing STF browser
sessions remain valid until their normal expiry; switching the login provider
does not revoke old sessions or API tokens. Later GitLab account revocation does
not immediately revoke an already-issued STF session either.

Verified GitLab deployment on 2026-10-05:

- GitOps revision `82100e403dd5ff7e0ed65128bcf64a032e9c0da3`; source path
  `kuber/gitops/stf-gitlab`. All ten Applications became Synced/Healthy.
- 237 unit tests passed, including 39 OAuth profile/strategy/HTTP-flow checks;
  strict TypeScript and scoped ESLint checks passed. The new image successfully
  pulled and ran its OAuth CLI on `k3s-worker-2` before cutover; that temporary
  verification pod was deleted.
- OAuth Secret was created without printing values or changing the session key.
  GitLab accepted client authentication with a deliberately invalid code,
  returning `invalid_grant` without issuing an access token.
- HTTPS redirect to this GitLab uses the expected callback, three minimal scopes,
  unpredictable state and S256 PKCE. State cookies are Secure/HttpOnly/SameSite=Lax.
  An unsolicited callback returned 400; `/auth/contact` returned 200; the
  unauthenticated STF API returned 401.
- Only app/auth pods changed; the other 15 `devicehub` pods kept their identities.
  Appium Grid remained ready with 16 UP nodes and zero sessions.
- Router DNS `192.168.10.1` still cached the former STF IP during verification;
  its remaining TTL was 462 seconds at 13:42 local time. Public DNS returned
  `46.191.173.144`. Targeted public checks retained full HTTPS verification.

Pending: the user's first successful GitLab login and explicit promotion of the
approved email to STF administrator. Do not remove the original administrator,
LDAP deployment, PVC or bind Secret before both checks are complete. The account
is created by the normal STF login flow; promotion must modify only that user's
`privilege` to `admin`, not grant administrator access to every GitLab user.

## Source cutover

1. Verify the pushed `develop` commit, successful image build and node pull
   access. Render every local Kustomize slice and inspect Argo CD differences.
2. Temporarily suspend reconciliation on the existing root and affected child
   Applications, including `argocd-config`, so old sources cannot revert the
   source/project changes. Do not create a second root managing the same objects.
3. Bootstrap the updated AppProject and source of the existing `devicehub-root`.
   Switch the existing child Applications to this repository. Do not reinstall
   the Argo CD installation in either `argocd` or `default`.
4. Synchronize `rethinkdb` and wait for the StatefulSet and successful migration
   hook. The application is initially manual-sync. A successful hook is removed;
   verify Argo CD's operation result, not a permanently present Job.
5. Synchronize OpenLDAP with the existing PVC and new Secret reference, then STF
   core/providers/ingress. The `devicehub` Application remains manual-sync.
6. Validate before restoring the intended automatic synchronization policies.

RethinkDB has no public ingress or NodePort. A NetworkPolicy permits driver-port
access only from the `devicehub` and `rethinkdb` namespaces. It uses a new PVC;
neither the MongoDB PVC nor old application data is reused.

## Validation and cleanup

Check LDAP login, devices from both ADB pools, screen streaming and touch,
capture/release, APK install, standard authenticated API, public TLS, and the
16 Grid nodes. Disconnected devices leave device-specific checks pending;
an empty device list alone does not show that STF's provider is broken.

Old MongoDB may be deleted without a backup. Deleting its Argo Application
without a resources finalizer does not remove its workloads. Perform the old
Application's cascading cleanup explicitly after STF validation, including its
PVC and namespace. Do not delete LDAP or STF storage PVCs. Remove the old iOS
bridge Services/Endpoints/NodePorts through the application synchronization.

The copied Java tests still depend on DeviceHub's `/api/v1/autotests` API. They
are historical code pending a separate STF client adaptation, not validation
of this rollout. iOS support and Mac mini changes are explicitly out of scope.

## Verified rollout on 2026-10-04

Deployment revision: `59aaafab05d759017e5017db659e0321bc3879a3` on `develop`.
The image was pulled successfully by all three Kubernetes nodes. The RethinkDB
hook succeeded and created `accessTokens`, `devices`, `groups`, `logs`, `users`
and `vncauth`. All 14 STF components became Ready without restarts.

All ten Applications are Synced/Healthy with the STF repository source. Root
and infrastructure automatic prune/self-heal are restored; STF and RethinkDB
remain manual-sync. OpenLDAP and temp storage PVC identities are unchanged.

Verified: public TLS; login page and JS/logo assets; normal LDAP login confirmed
by the user; `/auth/contact` database query; unauthenticated API returns 401;
Engine.IO WebSocket handshake; temp file upload (201) and identical readback
(200); both provider-to-ADB connections; Grid ready with 16 UP nodes and no
sessions. Socket.IO is configured for WebSocket only; polling is not a valid
health probe.

The old MongoDB Application had no resources finalizer, so root pruning removed
only its Application. After STF validation, its orphaned `mongodb` namespace
was deleted explicitly, including workloads/PVC/PV. This was one-time migration
cleanup, not a workload deployment outside GitOps. iOS bridge resources are gone.

Still pending: connected-device screen/touch, capture/release and APK checks;
new authenticated REST API token verification; adaptation of Java tests; SSH
access and the separate server maintenance stage. Neither ADB server currently
lists a device. No OS/k3s updates, Proxmox changes or Mac mini changes were made.
