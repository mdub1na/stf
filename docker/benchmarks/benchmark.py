#!/usr/bin/env python3
"""Isolated, local-only Docker image comparisons. Never prune shared caches."""

import argparse
import hashlib
import io
import json
import pathlib
import shutil
import subprocess
import tarfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE = "node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da"
UBUNTU = "ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11"
VARIANTS = {
    "baseline": ("Dockerfile", UBUNTU),
    "ubuntu": ("docker/benchmarks/Dockerfile.ubuntu", UBUNTU),
    "node-slim": ("docker/benchmarks/Dockerfile.node-slim", NODE),
}


def execute(command, log, **kwargs):
    started = time.monotonic()
    with log.open("wb") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, **kwargs)
    elapsed = round(time.monotonic() - started, 3)
    if result.returncode:
        print(log.read_text(errors="replace")[-6000:], flush=True)
        raise RuntimeError(f"Command exited {result.returncode}; see {log}")
    return elapsed


def prepare(directory, ref, platform):
    directory.mkdir(parents=True, exist_ok=False)
    context = directory / "context"
    context.mkdir()
    archive = subprocess.check_output(["git", "archive", ref], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        # git archive contains our own tracked source; reject paths/symlinks
        # before extraction, including on the system Python shipped with macOS.
        for member in source.getmembers():
            if pathlib.PurePosixPath(member.name).is_absolute() or ".." in pathlib.PurePosixPath(member.name).parts:
                raise ValueError("Unsafe archive path")
            if member.issym() or member.islnk():
                raise ValueError("Source archive symlinks need explicit review")
        source.extractall(context)
    shutil.copytree(ROOT / "docker/benchmarks", context / "docker/benchmarks", dirs_exist_ok=True)
    dockerfile = context / "Dockerfile"
    dockerfile.write_text(dockerfile.read_text().replace("FROM ubuntu:22.04", "FROM " + UBUNTU, 1))
    with (context / ".dockerignore").open("a") as output:
        output.write("\n# Freeze one dependency resolution for every experimental variant.\n!package-lock.json\n")
    snapshot = ROOT / "docker/benchmarks/dependencies.lock.json"
    if snapshot.exists():
        manifest = json.loads((context / "package.json").read_text())
        locked = json.loads(snapshot.read_text())["packages"][""]
        for field in ("dependencies", "devDependencies", "engines"):
            if manifest.get(field) != locked.get(field):
                raise ValueError("Dependency snapshot does not match source " + field)
        shutil.copyfile(snapshot, context / "package-lock.json")
        elapsed = None
        (directory / "dependency-resolution.log").write_text("Using the experiment-only dependency snapshot.\n")
    else:
        elapsed = execute([
            "docker", "run", "--rm", "--platform", platform,
            "--mount", f"type=bind,src={context},dst=/work", "-w", "/work", NODE,
            "npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
        ], directory / "dependency-resolution.log")
    metadata = {
        "sourceCommit": subprocess.check_output(["git", "rev-parse", ref], cwd=ROOT, text=True).strip(),
        "platform": platform,
        "lockSha256": hashlib.sha256((context / "package-lock.json").read_bytes()).hexdigest(),
        "nodeImage": NODE, "ubuntuImage": UBUNTU,
        "dependencyResolutionSeconds": elapsed,
        "baselineChanges": ["Pin Ubuntu base digest", "Include shared experiment-only package-lock.json"],
        "timingNotes": "Serial builds; base prewarm recorded separately; no npm/apt cache mounts; export included, image loading excluded.",
    }
    (directory / "environment.json").write_text(json.dumps(metadata, indent=2) + "\n")
    execute(["docker", "version"], directory / "docker-version.txt")
    execute(["docker", "info", "--format", "{{.Architecture}} {{.NCPU}} {{.MemTotal}} {{.OperatingSystem}}"], directory / "docker-resources.txt")
    print(json.dumps(metadata), flush=True)


def image_size(archive):
    with tarfile.open(archive) as source:
        def blob(digest):
            return json.load(source.extractfile("blobs/" + digest.replace(":", "/")))
        index = json.load(source.extractfile("index.json"))
        manifest = blob(index["manifests"][0]["digest"])
        if "manifests" in manifest:
            manifest = blob(manifest["manifests"][0]["digest"])
        compressed = sum(layer["size"] for layer in manifest["layers"])
        # Count the uncompressed layer stream, including overwritten/deleted files.
        unpacked = 0
        for layer in manifest["layers"]:
            import gzip
            member = source.extractfile("blobs/" + layer["digest"].replace(":", "/"))
            stream = gzip.GzipFile(fileobj=member) if "gzip" in layer["mediaType"] else member
            while chunk := stream.read(1024 * 1024):
                unpacked += len(chunk)
        return {"compressedLayerBytes": compressed, "uncompressedLayerTarBytes": unpacked,
                "layers": len(manifest["layers"])}


def build(directory, variant, phase, load=True):
    environment = json.loads((directory / "environment.json").read_text())
    platform = environment["platform"]
    arch = platform.split("/")[-1]
    context = directory / "context"
    # Freeze context files after prepare: changing the benchmark harness itself
    # must not invalidate the baseline COPY during an unchanged rebuild.
    builder = "stf-bench-" + directory.name.lower().replace("_", "-")[-25:] + "-" + variant
    dockerfile, base = VARIANTS[variant]
    dockerfile_path = context / dockerfile if variant == "baseline" else ROOT / dockerfile
    recipe = directory / "recipes" / (variant + ".Dockerfile")
    if phase == "cold":
        recipe.parent.mkdir(exist_ok=True)
        shutil.copyfile(dockerfile_path, recipe)
    if not recipe.exists():
        raise ValueError("Run a cold build before measuring cached builds")
    recipe_sha = hashlib.sha256(recipe.read_bytes()).hexdigest()
    source_file = context / "lib/util/logger.ts"
    original = subprocess.check_output(["git", "show", environment["sourceCommit"] + ":lib/util/logger.ts"], cwd=ROOT)
    if phase.startswith("source-"):
        source_file.write_bytes(original + ("\n// Docker benchmark source change " + phase + ".\n").encode())
    else:
        source_file.write_bytes(original)
    prefix = directory / (variant + "-" + phase)
    image = "stf-docker-bench:" + variant + "-" + arch + "-" + phase
    if phase == "cold":
        execute(["docker", "buildx", "create", "--name", builder, "--driver", "docker-container", "--bootstrap"],
                prefix.with_suffix(".builder.log"))
        prewarm = f"# syntax=docker/dockerfile:1\nFROM {base}\nRUN true\n".encode()
        prewarm_time = execute(["docker", "buildx", "build", "--builder", builder, "--platform", platform,
                               "--file", "-", "--output", "type=cacheonly", "--progress", "plain", str(context)],
                              prefix.with_suffix(".prewarm.log"), input=prewarm)
    else:
        prewarm_time = None
    archive = prefix.with_suffix(".oci.tar")
    elapsed = execute([
        "docker", "buildx", "build", "--builder", builder, "--platform", platform,
        "--file", str(recipe), "--tag", image,
        "--provenance=false", "--sbom=false", "--progress", "plain",
        "--metadata-file", str(prefix.with_suffix(".metadata.json")),
        "--output", f"type=oci,dest={archive}", str(context),
    ], prefix.with_suffix(".build.log"))
    result = {"variant": variant, "phase": phase, "platform": platform, "image": image,
              "dockerfileSha256": recipe_sha,
              "buildSeconds": elapsed, "basePrewarmSeconds": prewarm_time,
              **image_size(archive)}
    result["cachedLogEntries"] = prefix.with_suffix(".build.log").read_text().count(" CACHED")
    result["loadSeconds"] = None
    result["loadMethod"] = "cached-buildx-docker-export" if load else None
    # Save measurements even if the separate runtime import fails. Classic
    # Docker stores cannot load an OCI-layout archive directly, unlike the
    # containerd store in Docker Desktop; use the portable Docker exporter.
    prefix.with_suffix(".result.json").write_text(json.dumps(result, indent=2) + "\n")
    if load:
        result["loadSeconds"] = execute([
            "docker", "buildx", "build", "--builder", builder, "--platform", platform,
            "--file", str(recipe), "--tag", image, "--provenance=false", "--sbom=false",
            "--progress", "plain", "--load", str(context),
        ], prefix.with_suffix(".load.log"))
        prefix.with_suffix(".result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "build"])
    parser.add_argument("--directory", type=pathlib.Path, required=True)
    parser.add_argument("--ref", default="origin/master")
    parser.add_argument("--platform", default="linux/amd64")
    parser.add_argument("--variant", choices=VARIANTS)
    parser.add_argument("--phase", choices=["cold", "warm", "source-1", "source-2", "source-3"], default="cold")
    parser.add_argument("--skip-load", action="store_true", help="Measure export without importing the image into Docker")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.directory.resolve(), args.ref, args.platform)
    else:
        if not args.variant:
            parser.error("build requires --variant")
        build(args.directory.resolve(), args.variant, args.phase, load=not args.skip_load)


if __name__ == "__main__":
    main()
