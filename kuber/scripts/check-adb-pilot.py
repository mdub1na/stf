#!/usr/bin/env python3
"""Render both overlays offline and reject changes to existing STF resources."""
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[2]


def render(path):
    return subprocess.check_output(['kubectl', 'kustomize', str(root / path)], text=True)


def documents(bundle):
    return {document.strip() for document in re.split(r'^---\s*$', bundle, flags=re.MULTILINE) if document.strip()}


base = documents(render('kuber/gitops/stf-gitlab'))
pilot = documents(render('kuber/gitops/stf-adb-pilot'))
assert base <= pilot, 'Pilot must preserve every existing STF resource byte for byte'
added = pilot - base
assert len(added) == 4, f'Expected only gateway Deployment, Service, Ingress and ConfigMap, got {len(added)}'
for kind in ['Deployment', 'Service', 'Ingress', 'ConfigMap']:
    assert sum(f'kind: {kind}\n' in document for document in added) == 1, f'Expected exactly one new {kind}'
assert all('name: stf-adb-gateway' in document for document in added), 'Only gateway resources may be added'

deployment = next(document for document in added if 'kind: Deployment\n' in document)
for setting in ['replicas: 1', 'type: Recreate', 'automountServiceAccountToken: false',
                'runAsNonRoot: true', 'readOnlyRootFilesystem: true', 'allowPrivilegeEscalation: false',
                'type: RuntimeDefault', 'path: /healthz', '- ALL']:
    assert setting in deployment, f'Missing deployment safety setting: {setting}'
assert 'secretRef:' not in deployment and 'hostPath:' not in deployment, 'Gateway needs no shared secrets or host mounts'
ingress = next(document for document in added if 'kind: Ingress\n' in document)
assert 'router.entrypoints: websecure\n' in ingress, 'Pilot ingress must use HTTPS only'
assert 'path: /adb-tunnel/' in ingress and 'secretName: stf-finservice-tech-tls' in ingress
assert 'middleware' not in ingress.lower(), 'Preserve the token-authenticated path without browser-auth middleware'
service = next(document for document in added if 'kind: Service\n' in document)
assert 'type: ClusterIP' in service and 'nodePort:' not in service, 'Do not publish raw device ports'

expected = json.loads((root / 'tools/adb-tunnel/config.example.json').read_text())
actual = json.loads((root / 'kuber/gitops/stf-adb-pilot/gateway.json').read_text())
assert actual == expected, 'Pilot provider routing must match the reviewed gateway allowlist'
assert all(5037 not in provider['adbPorts'] for provider in actual['providers'].values())

application = (root / 'kuber/gitops/root/stf-app.yaml').read_text()
overlay = (root / 'kuber/gitops/stf-adb-pilot/kustomization.yaml').read_text()
if 'path: kuber/gitops/stf-adb-pilot' in application:
    assert re.search(r'^\s+digest: sha256:[a-f0-9]{64}\s*$', overlay, re.MULTILINE), 'Activation requires an immutable published image digest'
    assert 'unpublished-do-not-apply' not in overlay, 'Unpublished image cannot be activated'
else:
    assert 'path: kuber/gitops/stf-gitlab' in application, 'Unexpected active STF source'
print('Pilot renders offline; existing STF resources unchanged; only four isolated gateway objects added.')
