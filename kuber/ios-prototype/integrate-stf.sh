#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "Usage: $0 KUBECONFIG ghcr.io/mdub1na/stf:ios-stf-COMMIT_SHA" >&2
  exit 2
fi

cluster_config=$1
stf_image=$2
if [[ ! -f "$cluster_config" ]] ||
   [[ ! "$stf_image" =~ ^ghcr\.io/mdub1na/stf(:ios-stf-[a-f0-9]{40}|@sha256:[a-f0-9]{64})$ ]]; then
  echo 'Provide an existing kubeconfig and a published integration image tag or digest.' >&2
  exit 2
fi

manifest_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
patch_file=$(mktemp)
trap 'rm -f "$patch_file"' EXIT
sed "s|ghcr.io/mdub1na/stf:SET_STF_IMAGE_TAG|$stf_image|g" \
  "$manifest_dir/stf-integration.yaml" > "$patch_file"

# Enable ownership checks before publishing the phone to STF.
kubectl --kubeconfig "$cluster_config" -n stf set image \
  --request-timeout=15s deployment/stf-websocket "stf-websocket=$stf_image"
kubectl --kubeconfig "$cluster_config" -n stf rollout status deployment/stf-websocket \
  --request-timeout=610s --timeout=600s
# The API enriches the initial device list; keep its catalogue aligned with live updates.
kubectl --kubeconfig "$cluster_config" -n stf set image deployment/stf-api "stf-api=$stf_image" \
  --request-timeout=15s
kubectl --kubeconfig "$cluster_config" -n stf rollout status deployment/stf-api \
  --request-timeout=610s --timeout=600s
kubectl --kubeconfig "$cluster_config" -n stf set image deployment/stf-app "stf-app=$stf_image" \
  --request-timeout=15s
kubectl --kubeconfig "$cluster_config" -n stf rollout status deployment/stf-app \
  --request-timeout=610s --timeout=600s
kubectl --kubeconfig "$cluster_config" --request-timeout=15s \
  apply -f "$manifest_dir/stf-network.yaml"
kubectl --kubeconfig "$cluster_config" -n stf-ios-prototype --request-timeout=15s \
  patch deployment ios-prototype \
  --type=strategic --patch-file "$patch_file"
kubectl --kubeconfig "$cluster_config" -n stf-ios-prototype rollout status \
  deployment/ios-prototype --request-timeout=610s --timeout=600s
