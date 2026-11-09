#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
maestro --host 127.0.0.1 --device "$MAESTRO_DEVICE_ID" test \
  --format junit --output artifacts/junit.xml \
  --test-output-dir artifacts/maestro flows/settings.yaml
