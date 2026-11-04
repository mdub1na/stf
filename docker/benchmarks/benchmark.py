#!/usr/bin/env python3
"""Fork-only native, same-host Docker comparisons. Never publish or prune shared state."""

import argparse
import datetime
import gzip
import hashlib
import io
import json
import math
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import tarfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE_VERSION = "22.23.4"
NODE = "node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da"
UBUNTU = "ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11"
VARIANTS = ("baseline", "ubuntu")
PHASES = ("cold", "warm", "source-1", "source-2", "source-3")
LOGGER = "lib/util/logger.ts"
EXPORT = "compression=gzip,compression-level=6,force-compression=true"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def run(command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def execute(command, log, **kwargs):
    started = time.monotonic()
    with log.open("wb") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, **kwargs)
    elapsed = round(time.monotonic() - started, 3)
    if result.returncode:
        raise RuntimeError(f"Command exited {result.returncode}; see {log}")
    return elapsed


def commit(ref):
    if not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise ValueError("Use a full lowercase commit SHA, not a mutable ref")
    if run(["git", "rev-parse", "--verify", ref + "^{commit}"], cwd=ROOT) != ref:
        raise ValueError("Commit identity mismatch")
    return ref


def git_file(ref, path):
    return subprocess.check_output(["git", "show", ref + ":" + path], cwd=ROOT)


def normalized_recipes(baseline, candidate):
    original = baseline.decode()
    effective, count = re.subn(r"(?m)^FROM ubuntu:22\.04[ \t]*$", "FROM " + UBUNTU, original)
    if count != 1:
        raise ValueError("Baseline must have exactly one unpinned Ubuntu 22.04 FROM")
    candidate_text = candidate.decode()
    if re.findall(r"(?m)^ARG UBUNTU_IMAGE=(.+)$", candidate_text) != [UBUNTU]:
        raise ValueError("Candidate must retain the same pinned Ubuntu default")
    bases = re.findall(r"(?m)^FROM (\S+)", candidate_text)
    if not bases or bases[0] != "${UBUNTU_IMAGE}":
        raise ValueError("Candidate external base changed")
    if re.findall(r"(?m)^ARG NODE_VERSION=(.+)$", candidate_text) != [NODE_VERSION]:
        raise ValueError("Candidate Node version differs from the benchmark")
    versions = re.findall(r"https://nodejs\.org/dist/v([^/]+)/", original)
    if not versions or set(versions) != {NODE_VERSION}:
        raise ValueError("Baseline Node version differs from the candidate")
    return effective.encode(), candidate


def context_hash(context):
    records = []
    for file in sorted(context.rglob("*")):
        if file.is_symlink():
            raise ValueError("Unreviewed context symlink")
        if file.is_file():
            relative = file.relative_to(context).as_posix()
            if relative != LOGGER:
                records.append([relative, sha(file.read_bytes())])
    return sha(json.dumps(records, separators=(",", ":")).encode())


def prepare(directory, source_ref, baseline_ref, candidate_ref):
    refs = {"source": commit(source_ref), "baseline": commit(baseline_ref), "candidate": commit(candidate_ref)}
    if refs["source"] != refs["candidate"]:
        raise ValueError("Export the same source commit as the candidate recipe")
    recipes = {"baseline": git_file(refs["baseline"], "Dockerfile"), "ubuntu": git_file(refs["candidate"], "Dockerfile")}
    effective_baseline, candidate = normalized_recipes(recipes["baseline"], recipes["ubuntu"])
    directory.mkdir(parents=True, exist_ok=False)
    context = directory / "context"
    context.mkdir()
    archive = subprocess.check_output(["git", "archive", refs["source"]], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source.getmembers():
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or member.issym() or member.islnk():
                raise ValueError("Unsafe tracked source archive member")
        source.extractall(context)
    recipe_dir = directory / "recipes"
    recipe_dir.mkdir()
    (recipe_dir / "baseline.original.Dockerfile").write_bytes(recipes["baseline"])
    (recipe_dir / "baseline.Dockerfile").write_bytes(effective_baseline)
    (recipe_dir / "ubuntu.Dockerfile").write_bytes(candidate)
    original_logger = (context / LOGGER).read_bytes()
    (directory / "logger.original").write_bytes(original_logger)
    # A controlled, experiment-only lock is shared by both variants/architectures.
    (context / "package-lock.json").unlink(missing_ok=True)
    with (context / ".dockerignore").open("a") as output:
        output.write("\n# Include the shared benchmark-only dependency snapshot.\n!package-lock.json\n")
    resolution = execute([
        "docker", "run", "--rm", "--platform", "linux/amd64", "--mount",
        f"type=bind,src={context},dst=/work", "-w", "/work", NODE,
        "npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
    ], directory / "dependency-resolution.log")
    manifest = read_json(context / "package.json")
    locked = read_json(context / "package-lock.json")["packages"][""]
    for field in ("dependencies", "devDependencies", "engines"):
        if manifest.get(field) != locked.get(field):
            raise ValueError("Fresh dependency snapshot differs from " + field)
    metadata = {
        "schemaVersion": 2, "experimentId": str(uuid.uuid4()), "refs": refs,
        "sourceArchiveSha256": sha(archive), "sourceTree": run(["git", "rev-parse", refs["source"] + "^{tree}"], cwd=ROOT),
        "lockSha256": sha((context / "package-lock.json").read_bytes()),
        "loggerOriginalSha256": sha(original_logger), "frozenContextSha256": context_hash(context),
        "nodeImage": NODE, "nodeVersion": NODE_VERSION, "ubuntuImage": UBUNTU,
        "dependencyResolutionSeconds": resolution,
        "harnessCommit": run(["git", "rev-parse", "HEAD"], cwd=ROOT),
        "smokeSha256": sha((ROOT / "docker/benchmarks/smoke.mjs").read_bytes()),
        "recipeSha256": {"baseline": sha(effective_baseline), "ubuntu": sha(candidate)},
        "baselineOriginalSha256": sha(recipes["baseline"]),
        "baselineNormalization": "Exactly one FROM ubuntu:22.04 replaced with the candidate's pinned Ubuntu digest",
        "contextNormalization": "One fresh experiment-only package-lock.json; appended .dockerignore inclusion",
        "exportOptions": EXPORT,
        "timingNotes": "Native serial pairs; separate variant builders; no external cache/cache mounts; base prewarm and Docker import separate; OCI export included.",
    }
    write_json(directory / "environment.json", metadata)
    print(json.dumps({"prepared": True, "refs": refs, "lockSha256": metadata["lockSha256"]}), flush=True)


def docker_host():
    raw = json.loads(run(["docker", "info", "--format", "{{json .}}"], timeout=30))
    keys = ("ID", "Architecture", "OSType", "OperatingSystem", "NCPU", "MemTotal", "ServerVersion", "Name")
    return {key: raw.get(key) for key in keys}


def host(directory, platform):
    if platform not in ("linux/amd64", "linux/arm64"):
        raise ValueError("Unsupported platform")
    metadata = read_json(directory / "environment.json")
    if metadata.get("measurementHost"):
        raise ValueError("Host binding already exists")
    current = docker_host()
    native = {"x86_64": "linux/amd64", "amd64": "linux/amd64", "aarch64": "linux/arm64", "arm64": "linux/arm64"}.get(current["Architecture"])
    if current["OSType"] != "linux" or native != platform or not current["ID"]:
        raise ValueError("Timings require a matching native Linux Docker engine")
    binding = {"identity": str(uuid.uuid4()), "docker": current, "platform": platform,
               "runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
               "job": os.environ.get("GITHUB_JOB"), "runner": os.environ.get("RUNNER_NAME")}
    metadata["platform"] = platform
    metadata["measurementHost"] = binding
    write_json(directory / "environment.json", metadata)
    write_json(directory / "measurement-host.json", binding)
    print(json.dumps({"native": True, "platform": platform, "hostIdentity": binding["identity"]}), flush=True)


def verify_inputs(directory):
    metadata = read_json(directory / "environment.json")
    if metadata["schemaVersion"] != 2 or str(uuid.UUID(metadata["experimentId"])) != metadata["experimentId"]:
        raise ValueError("Invalid experiment metadata")
    if not metadata.get("measurementHost"):
        raise ValueError("Bind the native measurement host first")
    current = docker_host()
    previous = metadata["measurementHost"]["docker"]
    if any(current[key] != previous[key] for key in ("ID", "Architecture", "OSType", "ServerVersion", "NCPU", "MemTotal")):
        raise ValueError("Measurement Docker host changed")
    if sha((directory / "context/package-lock.json").read_bytes()) != metadata["lockSha256"]:
        raise ValueError("Shared dependency snapshot changed")
    if context_hash(directory / "context") != metadata["frozenContextSha256"]:
        raise ValueError("Application context changed outside the planned source edit")
    if sha((directory / "logger.original").read_bytes()) != metadata["loggerOriginalSha256"]:
        raise ValueError("Original source edit fixture changed")
    for variant in VARIANTS:
        if sha((directory / "recipes" / (variant + ".Dockerfile")).read_bytes()) != metadata["recipeSha256"][variant]:
            raise ValueError("Frozen recipe changed")
    return metadata


def inspect_builder(name):
    result = subprocess.run(["docker", "buildx", "inspect", name], capture_output=True, text=True, timeout=30, env={**os.environ, "LC_ALL": "C"})
    if result.returncode == 0:
        header, separator, nodes = result.stdout.partition("\nNodes:\n")
        names = re.findall(r"(?m)^Name:[ \t]+(\S+)[ \t]*$", header)
        drivers = re.findall(r"(?m)^Driver:[ \t]+(\S+)[ \t]*$", header)
        node_names = re.findall(r"(?m)^Name:[ \t]+(\S+)[ \t]*$", nodes)
        if not separator or len(names) != 1 or len(drivers) != 1 or not node_names:
            raise ValueError("Unrecognized buildx inspect output; refuse builder mutation")
        return {"Name": names[0], "Driver": drivers[0], "Nodes": [{"Name": node} for node in node_names]}
    if "no builder" in result.stderr.lower() and "found" in result.stderr.lower():
        return None
    raise RuntimeError("Cannot establish builder presence: " + result.stderr.strip())


def inspect_container(name):
    result = subprocess.run(["docker", "container", "inspect", name], capture_output=True, text=True, timeout=30)
    if result.returncode == 0:
        return json.loads(result.stdout)[0]
    if "no such" in result.stderr.lower():
        return None
    raise RuntimeError("Cannot establish builder container presence: " + result.stderr.strip())


def builder_guard(name, operation, expected_id=None):
    info = inspect_builder(name)
    if not info or info["Name"] != name or info["Driver"] != "docker-container" or len(info["Nodes"]) != 1:
        raise ValueError("Builder identity changed")
    node = info["Nodes"][0]["Name"]
    container_name = "buildx_buildkit_" + node
    container = inspect_container(container_name)
    if not container:
        raise ValueError("Builder container missing")
    if "STF_BENCHMARK_ID=" + operation not in container["Config"]["Env"]:
        raise ValueError("Builder operation marker changed")
    if expected_id and container["Id"] != expected_id:
        raise ValueError("Builder container UID changed")
    return {"name": name, "operation": operation, "node": node, "containerName": container_name, "containerId": container["Id"]}


def image_size(archive, platform):
    with tarfile.open(archive) as source:
        def blob(digest):
            data = source.extractfile("blobs/" + digest.replace(":", "/")).read()
            if sha(data) != digest.split(":", 1)[1]:
                raise ValueError("OCI metadata digest mismatch")
            return json.loads(data)
        manifest = json.load(source.extractfile("index.json"))
        while "manifests" in manifest:
            if len(manifest["manifests"]) != 1:
                raise ValueError("Expected exactly one platform, without attestations")
            manifest = blob(manifest["manifests"][0]["digest"])
        config = blob(manifest["config"]["digest"])
        if config["os"] + "/" + config["architecture"] != platform:
            raise ValueError("OCI platform differs from the native measurement")
        unpacked = 0
        for layer in manifest["layers"]:
            member = source.getmember("blobs/" + layer["digest"].replace(":", "/"))
            if member.size != layer["size"] or "gzip" not in layer["mediaType"]:
                raise ValueError("Expected measured gzip layer bytes")
            with gzip.GzipFile(fileobj=source.extractfile(member)) as stream:
                while chunk := stream.read(1024 * 1024):
                    unpacked += len(chunk)
        return {"compressedLayerBytes": sum(layer["size"] for layer in manifest["layers"]),
                "uncompressedLayerTarBytes": unpacked, "layers": len(manifest["layers"]),
                "baseLayerDigest": manifest["layers"][0]["digest"], "rootfsDiffIds": config["rootfs"]["diff_ids"]}


def build(directory, variant, phase):
    metadata = verify_inputs(directory)
    if variant not in VARIANTS or phase not in PHASES:
        raise ValueError("Unknown variant or phase")
    prefix = directory / (variant + "-" + phase)
    if prefix.with_suffix(".result.json").exists():
        raise ValueError("Do not overwrite a measurement")
    index = PHASES.index(phase)
    if index and not (directory / (variant + "-" + PHASES[index - 1] + ".result.json")).exists():
        raise ValueError("Measure phases in order")
    platform = metadata["platform"]
    arch = platform.split("/")[1]
    name = "stf-bench-" + metadata["experimentId"].replace("-", "")[:12] + "-" + arch + "-" + variant
    ownership_path = directory / ("builder-" + variant + ".json")
    if phase == "cold":
        if inspect_builder(name):
            raise ValueError("Builder already exists; do not touch another run")
        write_json(ownership_path, {"name": name, "operation": metadata["experimentId"], "planned": True})
        builder_seconds = execute(["docker", "buildx", "create", "--name", name, "--driver", "docker-container",
            "--driver-opt", "env.STF_BENCHMARK_ID=" + metadata["experimentId"], "--bootstrap"], prefix.with_suffix(".builder.log"))
        ownership = builder_guard(name, metadata["experimentId"])
        write_json(ownership_path, ownership)
        prewarm = execute(["docker", "buildx", "build", "--builder", name, "--platform", platform,
            "--file", "-", "--output", "type=cacheonly", "--progress", "plain", str(directory / "context")],
            prefix.with_suffix(".prewarm.log"), input=("FROM " + UBUNTU + "\nRUN true\n").encode())
    else:
        ownership = read_json(ownership_path)
        builder_guard(name, metadata["experimentId"], ownership["containerId"])
        builder_seconds = prewarm = None
    original = (directory / "logger.original").read_bytes()
    source_bytes = original + ("\n// Docker benchmark source change " + phase + ".\n").encode() if phase.startswith("source-") else original
    (directory / "context" / LOGGER).write_bytes(source_bytes)
    recipe = directory / "recipes" / (variant + ".Dockerfile")
    image = "stf-docker-bench:" + metadata["experimentId"][:8] + "-" + variant + "-" + arch
    command = ["docker", "buildx", "build", "--builder", name, "--platform", platform,
        "--file", str(recipe), "--tag", image, "--provenance=false", "--sbom=false", "--progress", "plain",
        "--metadata-file", str(prefix.with_suffix(".metadata.json"))]
    if variant == "ubuntu":
        command += ["--build-arg", "UBUNTU_IMAGE=" + UBUNTU, "--build-arg", "NODE_VERSION=" + NODE_VERSION]
    archive = prefix.with_suffix(".oci.tar")
    elapsed = execute(command + ["--output", f"type=oci,dest={archive},{EXPORT}", str(directory / "context")], prefix.with_suffix(".build.log"))
    result = {"variant": variant, "phase": phase, "platform": platform, "image": image,
        "experimentId": metadata["experimentId"], "measurementHost": metadata["measurementHost"], "refs": metadata["refs"],
        "frozenContextSha256": metadata["frozenContextSha256"], "sourceEditSha256": sha(source_bytes),
        "lockSha256": metadata["lockSha256"], "dockerfileSha256": metadata["recipeSha256"][variant],
        "ubuntuImage": UBUNTU, "exportOptions": EXPORT, "buildSeconds": elapsed,
        "builderSetupSeconds": builder_seconds, "basePrewarmSeconds": prewarm, "loadSeconds": None,
        "cachedLogEntries": prefix.with_suffix(".build.log").read_text().count(" CACHED"), **image_size(archive, platform)}
    prefix.with_suffix(".result.json").write_text(json.dumps(result, indent=2) + "\n")
    if phase == "cold":
        load_command = command.copy()
        load_command[load_command.index("--metadata-file") + 1] = str(prefix.with_suffix(".load.metadata.json"))
        result["loadSeconds"] = execute(load_command + ["--load", str(directory / "context")], prefix.with_suffix(".load.log"))
        loaded = json.loads(run(["docker", "image", "inspect", image]))[0]
        if loaded["RootFS"]["Layers"] != result["rootfsDiffIds"] or loaded["Architecture"] != arch:
            raise ValueError("Loaded runtime differs from the measured OCI root filesystem")
        result["loadedImageId"] = loaded["Id"]
        write_json(prefix.with_suffix(".result.json"), result)
    print(json.dumps(result), flush=True)


def validate_results(directory):
    metadata = read_json(directory / "environment.json")
    host_binding = metadata["measurementHost"]
    records = {}
    for variant in VARIANTS:
        records[variant] = []
        for phase in PHASES:
            result = read_json(directory / (variant + "-" + phase + ".result.json"))
            expected = {"variant": variant, "phase": phase, "platform": metadata["platform"],
                "experimentId": metadata["experimentId"], "measurementHost": host_binding, "refs": metadata["refs"],
                "lockSha256": metadata["lockSha256"], "frozenContextSha256": metadata["frozenContextSha256"],
                "dockerfileSha256": metadata["recipeSha256"][variant], "ubuntuImage": UBUNTU, "exportOptions": EXPORT}
            if any(result.get(key) != value for key, value in expected.items()):
                raise ValueError("Results differ in host, app, lock, recipe or build settings")
            if not isinstance(result["buildSeconds"], (int, float)) or not math.isfinite(result["buildSeconds"]) or result["buildSeconds"] <= 0:
                raise ValueError("Invalid build duration")
            records[variant].append(result)
        ownership = read_json(directory / ("builder-" + variant + ".json"))
        if not ownership.get("removed") or ownership.get("operation") != metadata["experimentId"] or not ownership.get("containerId"):
            raise ValueError("Owned builder cleanup was not confirmed")
        smoke = read_json(directory / ("runtime-" + variant + ".json"))
        expected_arch = "x64" if metadata["platform"] == "linux/amd64" else "arm64"
        if smoke.get("arch") != expected_arch or smoke.get("checkerSha256") != metadata["smokeSha256"]:
            raise ValueError("Runtime architecture or checker changed")
        if smoke["status"] != "passed" or smoke["node"] != "v" + NODE_VERSION:
            raise ValueError("Runtime checks did not pass with the expected Node version")
        checks = {check["name"]: check for check in smoke["checks"]}
        expected_checks = {"nonroot", "production-dependencies", "installed-production-packages", "cli", "jpeg-roundtrip", "websocket-native-addons", "static-assets", "graphicsmagick-transform", "android-all-abi-resources", "apk-manifest", "java-keytool-bundletool", "runtime-inventory", "stf-aab-to-apk", "zeromq-message"}
        if len(checks) != len(smoke["checks"]) or set(checks) != expected_checks:
            raise ValueError("Runtime check coverage changed")
        allowed = {"stf-aab-to-apk"} if metadata["platform"] == "linux/arm64" else set()
        if variant == "baseline" and metadata["platform"] == "linux/arm64":
            allowed.add("java-keytool-bundletool")
        if any(check["status"] != "passed" and not (check["status"] == "skipped" and check["name"] in allowed) for check in smoke["checks"]):
            raise ValueError("Unexpected runtime check failure or skip")
        required = ("nonroot", "production-dependencies", "installed-production-packages", "android-all-abi-resources", "zeromq-message")
        if any(checks.get(key, {}).get("status") != "passed" for key in required):
            raise ValueError("Missing runtime payload comparison")
    if any(a["sourceEditSha256"] != b["sourceEditSha256"] or a["baseLayerDigest"] != b["baseLayerDigest"]
           for a, b in zip(records["baseline"], records["ubuntu"])):
        raise ValueError("Source edit or actual Ubuntu base layer differs")
    payloads = {}
    for variant in VARIANTS:
        checks = {check["name"]: check for check in read_json(directory / ("runtime-" + variant + ".json"))["checks"]}
        payloads[variant] = {key: checks[key]["details"] for key in required[:-1]}
    if payloads["baseline"] != payloads["ubuntu"]:
        write_json(directory / "payload-mismatch.json", payloads)
        raise ValueError("Production packages, Android resources or numeric identity differ; see payload-mismatch.json")
    return metadata, records


def summarize(directory):
    try:
        metadata, records = validate_results(directory)
        rows = []
        for variant in VARIANTS:
            source = [result["buildSeconds"] for result in records[variant][2:]]
            rows.append({"variant": variant, "compressedMB": round(records[variant][0]["compressedLayerBytes"] / 1e6, 3),
                "coldSeconds": records[variant][0]["buildSeconds"], "warmSeconds": records[variant][1]["buildSeconds"],
                "sourceMedianSeconds": statistics.median(source), "sourceRangeSeconds": [min(source), max(source)]})
        result = {"status": "passed", "platform": metadata["platform"], "experimentId": metadata["experimentId"],
            "refs": metadata["refs"], "measurementHost": metadata["measurementHost"], "lockSha256": metadata["lockSha256"],
            "frozenContextSha256": metadata["frozenContextSha256"], "recipeSha256": metadata["recipeSha256"], "rows": rows,
            "limitations": ["Cold build: one observation per variant; base prewarm and Docker load excluded.",
                "Native ARM64 baseline lacks Java and modifies its dev manifest with pnpm; no byte-identical ARM app claim.",
                "This measures compressed OCI layers/build-export times, not startup, CPU, RAM or network transfer speed."]}
    except Exception as error:
        write_json(directory / "summary.json", {"status": "failed", "error": str(error)})
        raise
    write_json(directory / "summary.json", result)
    print(json.dumps(result, indent=2), flush=True)


def compare(directory):
    summaries = [read_json(directory / ("same-host-" + arch) / "summary.json") for arch in ("amd64", "arm64")]
    if any(item["status"] != "passed" for item in summaries):
        raise ValueError("Both native pairs must pass")
    for key in ("experimentId", "refs", "lockSha256", "frozenContextSha256", "recipeSha256"):
        if summaries[0][key] != summaries[1][key]:
            raise ValueError("Cross-architecture source, lock or recipe mismatch: " + key)
    for arch, item in zip(("amd64", "arm64"), summaries):
        if item["platform"] != "linux/" + arch:
            raise ValueError("Wrong native architecture summary")
    result = {"status": "passed", "pairs": summaries}
    write_json(directory / "comparison.json", result)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write("| Native arch | Variant | Compressed MB | Cold s | Warm s | Source median s | Source range s |\n| --- | --- | ---: | ---: | ---: | ---: | --- |\n")
            for item in summaries:
                for row in item["rows"]:
                    output.write("| " + item["platform"] + " | {variant} | {compressedMB} | {coldSeconds} | {warmSeconds} | {sourceMedianSeconds} | {sourceRangeSeconds} |\n".format(**row))
    print(json.dumps(result, indent=2), flush=True)


def cleanup(directory):
    if not (directory / "environment.json").exists():
        print("No benchmark ownership metadata; nothing to clean")
        return
    metadata = read_json(directory / "environment.json")
    if not metadata.get("measurementHost"):
        print("No measurement builders were created")
        return
    current = docker_host()
    if current["ID"] != metadata["measurementHost"]["docker"]["ID"]:
        raise ValueError("Docker host changed; cleanup refused")
    for variant in VARIANTS:
        file = directory / ("builder-" + variant + ".json")
        if not file.exists():
            continue
        record = read_json(file)
        expected_name = "stf-bench-" + metadata["experimentId"].replace("-", "")[:12] + "-" + metadata["platform"].split("/")[1] + "-" + variant
        if record["name"] != expected_name or record["operation"] != metadata["experimentId"]:
            raise ValueError("Unowned builder cleanup refused")
        if record.get("removed"):
            continue
        if not inspect_builder(expected_name):
            if inspect_container(record.get("containerName", "buildx_buildkit_" + expected_name + "0")):
                raise ValueError("Builder metadata missing but container still exists")
            record["removed"] = True
        else:
            builder_guard(expected_name, record["operation"], record.get("containerId"))
            subprocess.run(["docker", "buildx", "rm", expected_name], check=True)
            if inspect_builder(expected_name) or inspect_container(record.get("containerName", "buildx_buildkit_" + expected_name + "0")):
                raise ValueError("Owned builder/container removal not confirmed")
            record["removed"] = True
        write_json(file, record)
    print("Only this experiment's guarded builders were removed", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "host", "build", "summarize", "compare", "cleanup"))
    parser.add_argument("--directory", type=pathlib.Path, required=True)
    parser.add_argument("--source-ref")
    parser.add_argument("--baseline-ref")
    parser.add_argument("--candidate-ref")
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"))
    parser.add_argument("--variant", choices=VARIANTS)
    parser.add_argument("--phase", choices=PHASES)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.action == "prepare":
        prepare(directory, args.source_ref or "", args.baseline_ref or "", args.candidate_ref or "")
    elif args.action == "host":
        host(directory, args.platform)
    elif args.action == "build":
        build(directory, args.variant, args.phase)
    elif args.action == "summarize":
        summarize(directory)
    elif args.action == "compare":
        compare(directory)
    else:
        cleanup(directory)


if __name__ == "__main__":
    main()
