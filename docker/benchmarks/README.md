# STF image measurements

This fork-only harness compares the upstream Ubuntu Dockerfile with the multi-stage candidate. Each native architecture job measures both variants serially on one runner. It exports one application commit and resolves one fresh dependency snapshot for both variants and architectures; it never publishes images or changes a device farm.

Start the **Docker image experiments** workflow from the `codex/docker-image-benchmarks` branch with three full commit SHA inputs:

- `source_ref`: the application commit to export.
- `candidate_ref`: the same commit, providing the candidate `Dockerfile`.
- `baseline_ref`: the upstream commit providing the original `Dockerfile`.

Mutable branch names are rejected. Verified [run 41902076195](https://github.com/mdub1na/stf/actions/runs/41902076195) used source/candidate `c6f7d4e053521789ad40e4b7cef02dc7684e74e2`, baseline `7585c9b04d806a75dced9da3ae16520043b6331b` and harness `04d4f89e84085723a88a9cb00bca8d4dae2cdd00`. All measurements and comparisons passed on the first workflow attempt.

## Verified PR #1070 results

Each architecture used its own native runner (4 CPUs, about 16.7 GB RAM); both variants ran sequentially on that runner.

| Native arch | Variant | Compressed MB | Cold s | Warm s | Source median s | Source range s |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| amd64 | baseline | 607.941 | 175.343 | 2.414 | 170.739 | 169.766–173.787 |
| amd64 | ubuntu | 250.898 | 100.408 | 1.397 | 25.460 | 24.976–26.678 |
| arm64 | baseline | 305.582 | 134.019 | 1.440 | 138.301 | 135.747–139.737 |
| arm64 | ubuntu | 241.084 | 85.562 | 1.442 | 24.728 | 24.416–24.833 |

Cold and warm timings are single observations. Source rebuild figures are the median and range of three edits; timed builds include OCI export, with base prewarming and Docker loading outside that time. Production package versions, Android resources and numeric user IDs matched within both pairs. Both experiment builders on each runner were removed.

The exact initial npm lock is retained as [dependencies.lock.json](dependencies.lock.json) for audit (SHA-256 `fef157decf0988062b4285b40df01abbfd7004b998fd946e2424aa1545e17df6`). `prepare` resolves a fresh snapshot by default; this retained file does not change that behavior. The previous snapshot remains available in commit `5fde2a2468696f1edd54918146e42380008bebf0`.

## Controls and measurements

The snapshot job archives the original baseline recipe and its effective recipe. Its only recipe normalization replaces `FROM ubuntu:22.04` with the candidate's pinned Ubuntu digest. Both variants retain Node 22.23.4. A benchmark-only `package-lock.json` is freshly resolved once with a pinned Node image and included by both recipes. The candidate's Dockerfile-specific ignore rules, when present, follow the renamed recipe and receive the same lockfile inclusion.

Each native amd64/arm64 job binds a Docker engine identity and architecture before measuring. It uses a separate BuildKit builder per variant, without external caches, npm/apt cache mounts or global pruning. Base prewarming and image loading are recorded separately. Timed builds include gzip OCI export. Compressed layer bytes and uncompressed layer-tar bytes are recorded; neither is exclusive Docker disk usage.

The phases are cold, unchanged warm, then three successive source-only edits. Every phase reconstructs the probe file from a frozen original. In particular, the candidate cold build does not inherit the baseline's third source edit. Results include the original source/lock/context hashes and recipe hash. Summaries reject mismatched host, source, lock, base layer, recipe, source edit or export settings. Cold timings are single observations; report the median and range of the three source rebuilds. No startup, CPU, RAM or measured network-speed benefit is claimed.

The benchmark keeps the security refresh argument at its Dockerfile default throughout all phases. Publish CI sets a fresh value per run attempt to rebuild the OS layer.

Runtime checks run as the image's default user, with no network or device access. They compare numeric runtime identity, direct and nested installed production package versions, and hashes of Android resources. Native JPEG/WebSocket/ZeroMQ modules, graphics conversion, APK handling and amd64 AAB conversion are exercised. The imported runtime's root filesystem must match the measured OCI image. The candidate inventory records a missing npm executable as `null`.

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
