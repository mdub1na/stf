# STF image measurements

This fork-only harness compares the upstream Ubuntu Dockerfile with the multi-stage candidate. Each native architecture job measures both variants serially on one runner. It exports one application commit and resolves one fresh dependency snapshot for both variants and architectures; it never publishes images or changes a device farm.

Start the **Docker image experiments** workflow from the `codex/docker-image-benchmarks` branch with three full commit SHA inputs:

- `source_ref`: the application commit to export.
- `candidate_ref`: the same commit, providing the candidate `Dockerfile`.
- `baseline_ref`: the upstream commit providing the original `Dockerfile`.

Mutable branch names are rejected. For the first updated PR #1070 comparison, the intended source/candidate is `c6f7d4e053521789ad40e4b7cef02dc7684e74e2` and baseline is `7585c9b04d806a75dced9da3ae16520043b6331b`. Use the reviewed current commit if the candidate changes before dispatch.

## Controls and measurements

The snapshot job archives the original baseline recipe and its effective recipe. Its only recipe normalization replaces `FROM ubuntu:22.04` with the candidate's pinned Ubuntu digest. Both variants retain Node 22.23.4. A benchmark-only `package-lock.json` is freshly resolved once with a pinned Node image and included in the common exported context; the repository's lockfile policy is unchanged.

Each native amd64/arm64 job binds a Docker engine identity and architecture before measuring. It uses a separate BuildKit builder per variant, without external caches, npm/apt cache mounts or global pruning. Base prewarming and image loading are recorded separately. Timed builds include gzip OCI export. Compressed layer bytes and uncompressed layer-tar bytes are recorded; neither is exclusive Docker disk usage.

The phases are cold, unchanged warm, then three successive source-only edits. Every phase reconstructs the probe file from a frozen original. In particular, the candidate cold build does not inherit the baseline's third source edit. Results include the original source/lock/context hashes and recipe hash. Summaries reject mismatched host, source, lock, base layer, recipe, source edit or export settings. Cold timings are single observations; report the median and range of the three source rebuilds. No startup, CPU, RAM or measured network-speed benefit is claimed.

Runtime checks run as the image's default user, with no network or device access. They compare numeric runtime identity, direct and nested installed production package versions, and hashes of Android resources. Native JPEG/WebSocket/ZeroMQ modules, graphics conversion, APK handling and amd64 AAB conversion are exercised. The imported runtime's root filesystem must match the measured OCI image.

The original ARM64 Dockerfile lacks Java and adds `pnpm` to its dev manifest. Its missing Java is an explicit, narrowly scoped known skip; the candidate's Java is checked normally. Bundletool 1.2.0 embeds an x86_64 `aapt2`, so native ARM64 AAB conversion remains an explicit skip. Package/resource differences fail the payload comparison and are archived rather than silently treated as equivalent. There is no claim that the ARM64 app directory is byte-identical. The main Docker CI separately validates the candidate and its amd64 Compose deployment.

Only builders carrying this experiment's operation marker and matching recorded container identity may be removed. Their confirmed cleanup is required for a successful summary. Workflow artifacts retain recipes, the fresh lock, environment, results, runtime inventory and logs for 30 days; no image archive is uploaded.

## Local reproduction

Docker Buildx, Python 3.9+, network access and a native Linux engine matching the selected platform are required. Work in this benchmark branch; keep the result directory outside the build context:

```sh
python3 docker/benchmarks/benchmark.py prepare --directory /tmp/stf-benchmark \
  --source-ref SOURCE_SHA --baseline-ref BASELINE_SHA --candidate-ref SOURCE_SHA
python3 docker/benchmarks/benchmark.py host --directory /tmp/stf-benchmark --platform linux/amd64
python3 docker/benchmarks/benchmark.py build --directory /tmp/stf-benchmark --variant baseline --phase cold
```

Follow the workflow for the immutable AAB fixture, runtime probes, remaining phases, guarded cleanup and summary. `prepare` refuses an existing directory. The summary requires all measurements and runtime results; it does not convert an incomplete run into a pass.

## Earlier measurements

The historical comparison used separate native runners and an earlier experimental Ubuntu recipe. It measured compressed layers of 593.2 MB versus 248.6 MB, and source-rebuild medians of 135.213 s versus 56.346 s. Those values are not measurements of the updated PR head and should not be reused as its final results.

[Historical benchmark](https://github.com/mdub1na/stf/actions/runs/40942241633) · [Historical final-runtime checks](https://github.com/mdub1na/stf/actions/runs/40951735294)
