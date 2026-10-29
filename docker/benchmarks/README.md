# STF image experiments

This directory compares the existing STF image with two multi-stage builds. It is an experiment in the fork, intended to measure image size, rebuild time and functional compatibility before proposing a production Dockerfile change.

With Docker Buildx, Python 3.9+ and network access available, start from the repository root:

```sh
bench_dir="/tmp/stf-docker-bench-$(date +%s)"
python3 docker/benchmarks/benchmark.py prepare --directory "$bench_dir" --ref HEAD
python3 docker/benchmarks/benchmark.py build --directory "$bench_dir" --variant baseline --phase cold
```

`prepare` creates a new directory and refuses to overwrite an existing one. It exports tracked source, includes an experiment-only dependency snapshot and pins the baseline Ubuntu digest. It does not change the root manifest or the repository's lockfile policy. The snapshot must match the selected source's dependencies and engines.

## Variants

| Variant | Base and runtime | Purpose |
| --- | --- | --- |
| `baseline` | Current Dockerfile, Ubuntu 22.04, Node 22.23.4, Java 8 JDK on amd64 | Reference implementation |
| `ubuntu` | Ubuntu 22.04, Node 22.23.4, Java 8 headless JRE | Separate build tools from runtime and cache dependency installation |
| `node-slim` | Official Node 22.23.4 on Debian Bookworm slim, Java 17 headless JRE | Compare a maintained Node base with the same application payload |

The Ubuntu candidate retains the baseline's OS upgrade policy. The slim variant also upgrades installed packages, but Debian package versions and Java 17 differ from the Ubuntu variants. Its results are not attributable solely to the base distribution. Both candidates preserve `stf` UID/GID 998 on amd64 and 999 on arm64. Existing mounted state still needs checking before a farm rollout.

All variants retain production npm dependencies, Android payloads for every phone ABI, GraphicsMagick and bundletool 1.2.0. They use the existing `npm install`/`npm pack` lifecycle: changing to `npm ci` requires addressing the project's `prepare` script separately.

## Measurements

Run builds serially on the same machine and architecture:

```sh
python3 docker/benchmarks/benchmark.py build --directory "$bench_dir" --variant baseline --phase warm --skip-load
for phase in source-1 source-2 source-3; do
  python3 docker/benchmarks/benchmark.py build --directory "$bench_dir" --variant baseline --phase "$phase" --skip-load
done
```

Repeat with `ubuntu` and `node-slim`, beginning with `cold`. A source rebuild adds a harmless comment to the exported `lib/util/logger.ts`, leaving the checkout and package manifests unchanged. Each variant's recipe is frozen at its first cold build and its SHA-256 is recorded. The application context remains frozen apart from the intentional source changes.

- Each variant gets a dedicated BuildKit builder. No shared caches or images are pruned.
- Base-image prewarming is recorded separately. Cold build time includes installation, compilation and compressed OCI export; Docker image import is recorded separately.
- No persistent apt/npm cache mounts or external layer caches are used. `warm` reuses the variant's instruction cache.
- Results distinguish compressed OCI layer bytes from uncompressed layer tar bytes. These are not exclusive node disk usage.
- Cold builds are individual observations. Use the median and range of the three source rebuilds; native and emulated timings must be reported separately.

The fork-only `Docker image experiments` workflow measures all three variants on native amd64 runners and the slim variant on a native arm64 runner. It shares the same dependency snapshot and uploads recipes, timings and runtime results. It never publishes an image or changes a cluster.

## Runtime checks

Mount `smoke.mjs` read-only into the final image and run it as the image's default user. The checks exercise CLI dependency validation, native JPEG/WebSocket modules, ZeroMQ messaging, GraphicsMagick, packaged assets, Android ABI resources, APK parsing and Java/bundletool. They emit JSON and fail on a broken check.

For real AAB conversion, download the official fixture from this immutable [bundletool source commit](https://raw.githubusercontent.com/google/bundletool/24df0e8b56580cef68ba904b3a80e881f4fc641a/src/test/resources/com/android/tools/build/bundletool/testdata/bundle/install-time-permanent-modules.aab). Verify SHA-256 `83d7d10b6036da2f94ad34483a5c3d5a32891b08e4fd1a658165c55258bdaff2`, mount its directory at `/tmp/fixtures`, then pass:

```sh
node /tmp/smoke.mjs --aab /tmp/fixtures/install-time-permanent-modules.aab --require-aab
```

Without a fixture, conversion is explicitly reported as skipped. With `--require-aab`, a missing fixture fails. Keep native messaging after subprocess checks when running under CPU emulation.

To test the final image across the core services:

```sh
python3 docker/benchmarks/compose-check.py \
  --image stf-docker-bench:ubuntu-amd64-cold \
  --directory "$bench_dir/compose-ubuntu" --port 17100
```

This starts an isolated Compose project with a fresh database and loopback-only HTTP access. It excludes ADB and the Android provider and requires no USB or privileged containers. Checks cover login, authenticated API requests, static assets, APK upload/metadata/download and PNG resizing through STF. Project containers, volumes and networks are removed afterward. These checks do not establish physical-device compatibility or existing-volume migration safety. Memory statistics are one observation, not a controlled RAM benchmark.

After collecting every phase, remove only the named `stf-bench-*` builders created by this experiment with `docker buildx rm NAME`. Keep result JSON and recipes outside the build context. Experimental images may be removed by their exact `stf-docker-bench:*` tags when no longer needed.
