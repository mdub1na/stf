#!/usr/bin/env python3
"""Run independent Appium workers; all device allocation goes through the coordinator."""

import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


def nonnegative(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("worker count must be nonnegative")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--android-workers", type=nonnegative, default=1)
    parser.add_argument("--ios-workers", type=nonnegative, default=0)
    parser.add_argument("--run-id", default="local-" + uuid.uuid4().hex)
    parser.add_argument("--android-tests", help="JUnit --tests filter for each Android worker")
    parser.add_argument("--ios-tests", help="JUnit --tests filter for each iOS worker")
    parser.add_argument("--demo", action="store_true", help="Run the observable Settings swipe scenarios")
    parser.add_argument("--dry-run", action="store_true", help="Show worker plan without starting Gradle or contacting the farm")
    args = parser.parse_args()
    if args.android_workers + args.ios_workers == 0:
        parser.error("at least one worker is required")
    if not args.dry_run and not all(os.environ.get(key, "").strip() for key in ("COORDINATOR_URL", "COORDINATOR_TOKEN")):
        parser.error("COORDINATOR_URL and COORDINATOR_TOKEN must be set through the environment")

    project = Path(__file__).resolve().parent
    invocation = uuid.uuid4().hex[:12]
    processes = []
    handles = []
    failed = False

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        for platform, count, test_filter in (
            ("Android", args.android_workers, args.android_tests),
            ("Ios", args.ios_workers, args.ios_tests),
        ):
            for index in range(1, count + 1):
                worker = f"{invocation}-{platform.lower()}-{index}"
                task = f"coordinator{platform}{'Demo' if args.demo else 'Test'}"
                command = [str(project / "gradlew"), "--no-daemon", "--console=plain",
                           "--project-cache-dir", str(project / ".gradle" / "workers" / worker),
                           f"-PappiumWorkerId={worker}", task]
                if test_filter:
                    command += ["--tests", test_filter]
                print(f"{worker}: {task}" + (f" --tests {test_filter}" if test_filter else ""), flush=True)
                if args.dry_run:
                    continue
                directory = project / "build" / "workers" / worker
                directory.mkdir(parents=True, exist_ok=True)
                log = (directory / "worker.log").open("w", encoding="utf-8")
                handles.append(log)
                environment = dict(os.environ, COORDINATOR_RUN_ID=args.run_id,
                                   TEST_ARTIFACTS_DIR=str(directory / "appium-artifacts"))
                process = subprocess.Popen(command, cwd=project, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                processes.append((worker, process, directory))
        while processes:
            pending = []
            for worker, process, directory in processes:
                result = process.poll()
                if result is None:
                    pending.append((worker, process, directory))
                else:
                    failed |= result != 0
                    print(f"{worker}: exit={result}; reports and log: {directory}", flush=True)
            processes = pending
            if processes:
                time.sleep(0.25)
        return 1 if failed else 0
    except KeyboardInterrupt:
        print("Stopping workers; coordinator lease expiry also protects against interrupted cleanup.", file=sys.stderr)
        return 130
    finally:
        for _, process, _ in processes:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for _, process, _ in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        for handle in handles:
            handle.close()


if __name__ == "__main__":
    sys.exit(main())
