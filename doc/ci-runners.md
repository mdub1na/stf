# CI workers beside the device farm

The source repository owns pipelines, test code, application builds, logs and reports. A project-locked GitLab Runner manager creates one temporary Kubernetes pod for each test job. The coordinator assigns physical devices and owns their lifecycle; CI jobs do not call STF, Grid or the shared ADB servers directly.

## Boundaries

- `stf-ci`: one runner manager, its authentication Secret and its configuration. The manager can create and attach to pods only in `stf-ci-jobs`.
- `stf-ci-jobs`: temporary build/helper pods using `stf-ci-job`, which has no Kubernetes Role and no mounted service-account token.
- `stf`: coordinator API and lease-bound Appium/ADB transports. The coordinator retains the STF credentials.
- GitLab: source, pipeline status, masked project farm token, JUnit reports and artifacts.

A worker requests one lease for one device. The example runner concurrency is 3. With coordinator maxParallel set to 2, three independent CI jobs demonstrate two running tests and a queued third request. More workers do not increase the number of physical devices. Shard test suites in CI or the test framework; the coordinator schedules devices, not test cases.

## Deployment

The manifests in `kuber/ci-runners/` are a separate opt-in deployment. They are not included in the STF Argo root. Review their rendered namespace, RBAC, image and endpoint settings before applying them.

```sh
kubectl --kubeconfig /path/to/farm.yaml apply -k kuber/ci-runners
```

Create a project-locked runner through `POST /api/v4/user/runners`, with `runner_type=project_type`, the intended project ID, `tag_list=stf-farm`, `locked=true` and `run_untagged=false`. Store the returned authentication token as `stf-ci/stf-ci-runner-auth`, key `runner-token`. Do not commit that Secret or pass its content on a command line. The legacy runner registration-token workflow is not used.

The init container copies global settings before registration. The runner template is merged into `[[runners]]`; global `concurrent` must not depend on that merge. Verify the resulting config without printing `token` or the full configuration. The manifests pin manager v19.5.0 by digest and use the matching helper version selected by GitLab Runner.

The manager has no access to farm namespaces through RBAC. Jobs cannot overwrite namespace, service account, bearer token or pod labels through CI variables. Privileged containers, service containers and host mounts are disabled. Build/helper pods run as UID/GID1000; the image must support this user. Runner environment sets `HOME=/tmp` so the helper can write Git configuration without a UID1000 passwd entry or root permissions. The example build-image repository is `registry.finservice.tech/gfs/platform/quality/farm-connection-smoke/ci-worker@sha256:<digest>`. Runner admission allows this repository by digest only. GitLab supplies temporary registry credentials from the job token for images in its own project; no permanent registry PAT is passed to jobs. The registry and GitLab addresses must match the explicit TLS egress allowlist in the worker NetworkPolicy.

Job pods have 180 seconds of termination/cleanup grace, allowing the wrapper's default 120-second cleanup wait and process shutdown to finish before Kubernetes forces termination. Lease expiry remains the recovery path after a node loss or forced kill.

## Network isolation

Both namespaces default-deny ingress and egress. Jobs can reach DNS, `gitlab.finservice.tech` over443 and coordinator8080. The manager can additionally reach Kubernetes API. There is no direct job access to STF API, Grid or the provider ADB servers.

The GitLab and Kubernetes IP allowlists in `network-policies.yaml` match the home cluster and must be updated when those endpoints change. The coordinator ingress policy must separately admit namespace `stf-ci-jobs` and pod label `stf-coordinator-access=allowed`.

After deployment, run positive probes for DNS, GitLab443 and coordinator8080, and negative probes for ADB5037, Grid4444, STF API3000 and Kubernetes443. Confirm that `/var/run/secrets/kubernetes.io/serviceaccount/token` is absent. A manifest alone is not evidence that network policies are enforced.

## Worker image

Build `kuber/ci-runners/Dockerfile` after placing the packed standalone `tools/test-runner` package at `kuber/ci-runners/runner-package.tgz` (ignored by Git). The image contains pinned JDK21, Node22.18.0 and Maestro2.11.0 with its published SHA256. It runs as UID1000 with UTF-8 enabled. Maestro analytics and update checks are disabled.

Set the demo project's `FARM_RUNNER_IMAGE` CI variable to the immutable built image digest. Kubernetes pulls images through the node; the GitLab Runner passes the short-lived integrated-registry credentials in its per-job pull Secret. A separate read_registry-only project deploy token is used by the coordinator deployment through `stf/stf-farm-registry-pull`, with no write_registry or repository access. Rotate that read-only deploy token and Secret before the configured expiration. GitLab Runner creates no idle worker pods; each build pod exists for a single job and is deleted afterward. ResourceQuota and LimitRange cap worker resource use. The initial resource allocation is for native smoke tests, not application compilation.

## External repository contract

The reusable external-repository template is `kuber/ci-runners/demo/`. Test source and application-specific pipelines belong in the independent test repository.

Configure `FARM_TOKEN_FILE` as a masked file CI variable containing that project's coordinator token. `FARM_URL` is `http://stf-coordinator.stf.svc.cluster.local:8080` inside this cluster. Other repositories receive separate project identities/tokens. Publish their worker image in their own project registry, or explicitly allow only that project's job tokens to pull a centrally hosted image. Never disable the image project's job-token allowlist for broad cross-project access.

Each new repository also needs its project-locked runner, a distinct coordinator project identity/token digest and a parallelism quota. Keep the same pod/network isolation and exact worker-image allowlist. The prototype loads coordinator project policies at startup; drain existing leases before restarting it to change those policies. The test repository receives neither the coordinator operator token nor a registry push credential.

```sh
stf utils test run --runner appium --platform Android --run-id "$CI_PIPELINE_ID-$CI_JOB_ID" -- node tests/appium-settings.mjs
stf utils test run --runner maestro --platform Android --run-id "$CI_PIPELINE_ID-$CI_JOB_ID" -- bash tests/maestro-settings.sh
```

The wrapper obtains and renews the lease, prepares a local transport, writes `STF_CONNECTION_FILE` and invokes the repository's command. The test owns assertions and reports. The wrapper and coordinator own cleanup, including cancellation and expired heartbeats. Do not combine this wrapper with another client that independently allocates a device.

`STF_CONNECTION_FILE` is versioned JSON containing `version`, `runner`, `leaseId`, `device`, and an engine-specific connection. Appium receives a local URL and capabilities. Maestro receives a local ADB server with only its leased serial. Tests must not replace this with the shared farm ADB endpoint. Physical iOS remains Appium-only; Maestro iOS needs a separate macOS simulator pool.

Physical iOS currently attaches to an existing WDA on Linux. Keep `autoLaunch:false`, omit `bundleId`/`app` in session capabilities, then activate an already installed app after connecting. Application installation/upgrade and testing the team's business application are separate from the native Settings connection smoke.

The demo uses Node's standard `fetch` API for W3C Appium commands, so it has no dependency on STF source or an Appium-language SDK. Teams may instead use Kotlin/JUnit, Python, WebdriverIO or another client. Compile tests and resolve dependencies on a regular CI runner, then pass ready artifacts or a prepared image to the farm stage; farm jobs have no general Internet egress. Maestro scenarios remain ordinary YAML. Artifacts are uploaded to GitLab, and STF provides the read-only live device screen.

## Verification and shutdown

The `stf utils test run` examples use the standalone client from
[`tools/test-runner`](../tools/test-runner/README.md), not the server's `stf`
executable. From the STF checkout, check the client and render the worker
resources without contacting a farm:

```sh
(cd tools/test-runner && npm ci --ignore-scripts --no-audit --no-fund && npm test)
kubectl kustomize kuber/ci-runners
```

These checks exercise local protocol fixtures and manifest syntax. For a real
worker, repeat the positive/negative network and RBAC probes above, then run a
short native Settings task using its project token. Validate Appium and Maestro
separately; installed-app activation does not verify iOS application installation
or upgrade.

On a successful run, verify GitLab test results/artifacts, every terminal job state, and held leases within the configured global and project limits. Submit more workers than the available capacity to observe queueing, then confirm released/free devices after cleanup. Verify the absence of job pods and unexpected native automation processes. A smoke pass does not demonstrate multi-hour stability.

To stop accepting jobs, pause the project-locked runner through GitLab API, wait for running jobs and leases to finish, then scale the manager to zero. Do not delete a job namespace while phones still have active automation. Removing this opt-in prototype should remove its own runner/project credentials and namespaces only; do not change existing application runners.

Official references: [Kubernetes executor](https://docs.gitlab.com/runner/executors/kubernetes/), [runner creation API](https://docs.gitlab.com/api/users/#create-a-runner-linked-to-a-user), [JUnit reports](https://docs.gitlab.com/ci/testing/unit_test_reports/).
