#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${1:-argocd}"

cat <<'PATCH' | kubectl -n "${NAMESPACE}" patch deployment argocd-repo-server --type=strategic --patch-file=/dev/stdin
spec:
  template:
    spec:
      initContainers:
        - name: copyutil
          command:
            - sh
            - -c
          args:
            - |
              /bin/cp --update=none /usr/local/bin/argocd /var/run/argocd/argocd || true
              rm -f /var/run/argocd/argocd-cmp-server
              /bin/ln -s /var/run/argocd/argocd /var/run/argocd/argocd-cmp-server
PATCH

kubectl -n "${NAMESPACE}" rollout status deployment/argocd-repo-server --timeout=180s
kubectl -n "${NAMESPACE}" get endpoints argocd-repo-server -o wide
