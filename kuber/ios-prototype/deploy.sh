#!/usr/bin/env bash
set -euo pipefail

kube_config=${1:?Usage: deploy.sh KUBECONFIG IMAGE UDID WDA_BUNDLE_ID TOKEN_FILE}
image=${2:?Provide the published prototype image}
udid=${3:?Provide the explicitly selected iPhone UDID}
bundle_id=${4:?Provide the installed WDA runner bundle ID}
token_file=${5:?Provide a private token file}
[[ $image =~ ^ghcr\.io/mdub1na/stf(:ios-prototype-[a-f0-9]{40}|@sha256:[a-f0-9]{64})$ ]]
[[ $udid =~ ^[a-zA-Z0-9-]{8,80}$ ]]
[[ $bundle_id =~ ^[a-zA-Z0-9_.-]+$ ]]
test -f "$token_file"
test "$(wc -c < "$token_file")" -ge 32
manifest=$(cd -- "$(dirname -- "$0")" && pwd)/deployment.yaml
namespace=stf-ios-prototype
k() { kubectl --kubeconfig "$kube_config" "$@"; }

k create namespace "$namespace" --dry-run=client -o yaml | k apply -f -
k -n "$namespace" create configmap ios-device \
  --from-literal="udid=$udid" --from-literal="wda-bundle-id=$bundle_id" \
  --dry-run=client -o yaml | k apply -f -
k -n "$namespace" create secret generic ios-api-token --from-file="token=$token_file" \
  --dry-run=client -o yaml | k apply -f -
sed "s|ghcr.io/mdub1na/stf:SET_IMAGE_TAG|$image|g" "$manifest" | k apply -f -
printf 'Prototype deployed; inspect tunnel/prototype logs and /device readiness.\n'
