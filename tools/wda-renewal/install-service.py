#!/usr/bin/env python3
"""Install the reviewed renewal code as a per-user macOS LaunchAgent."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys

from worker import require
from service import absolute_path, error_code, private_directory, private_file, read_private, validate_config, operation_lock


LABEL = 'tech.finservice.stf.wda-renewal'
FILES = ['service.py', 'worker.py', 'install-helper.py', 'sign.py']


def immutable_file(path, content):
    if path.exists() or path.is_symlink():
        require(private_file(path).read_bytes() == content, 'immutable_release_mismatch')
        return
    with path.open('xb') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def frozen_configuration(config, root):
    contents = {key: private_file(config[key]).read_bytes()
                for key in ('signerConfigPath', 'workerConfigPath')}
    encoded = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
    digest = hashlib.sha256(encoded + b'\0' + contents['signerConfigPath'] +
                            b'\0' + contents['workerConfigPath']).hexdigest()
    snapshot = private_directory(root / ('config-' + digest[:16]))
    frozen = dict(config)
    for key, filename in (('signerConfigPath', 'signer.json'), ('workerConfigPath', 'worker.json')):
        immutable_file(snapshot / filename, contents[key])
        frozen[key] = str(snapshot / filename)
    path = snapshot / 'service.json'
    immutable_file(path, (json.dumps(frozen, sort_keys=True, indent=2) + '\n').encode())
    validate_config(read_private(path))
    return path


def refuse_pending(config):
    state_directory = absolute_path(config['stateDirectory'])
    state_path = state_directory / 'service-state.json'
    if state_path.exists() or state_path.is_symlink():
        state = read_private(state_path)
        require(isinstance(state, dict) and isinstance(state.get('pending'), dict), 'service_state_invalid')
        require(not state['pending'] and not state.get('accepted'), 'pending_renewal_operation')


def installed_config(definition, root):
    arguments = definition.get('ProgramArguments')
    require(definition.get('Label') == LABEL and isinstance(arguments, list) and len(arguments) == 6 and
            arguments[:2] == ['/usr/bin/caffeinate', '-s'] and arguments[4] == '--config',
            'unexpected_service')
    code = absolute_path(arguments[3])
    config = absolute_path(arguments[5])
    require(code.name == 'service.py' and code.parent.parent == root and
            code.parent.name.startswith('code-') and config.parent.parent == root and
            config.parent.name.startswith('config-') and config.name == 'service.json', 'unexpected_service')
    private_file(code)
    return validate_config(read_private(config))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--install-root', required=True)
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    config = validate_config(read_private(args.config))
    root = private_directory(args.install_root)
    agent_dir = absolute_path(str(Path.home() / 'Library/LaunchAgents'))
    plist_path = agent_dir / (LABEL + '.plist')
    domain = 'gui/' + str(os.getuid())
    if args.uninstall:
        definition = plistlib.loads(private_file(plist_path).read_bytes())
        installed = installed_config(definition, root)
        with operation_lock(installed['stateDirectory']):
            refuse_pending(installed)
            subprocess.run(['launchctl', 'bootout', domain, str(plist_path)], check=True,
                           capture_output=True, timeout=150)
            plist_path.unlink()
        print(json.dumps({'status': 'uninstalled', 'codeAndPrivateStateRetained': True}))
        return 0
    # An existing service is never stopped implicitly as part of installation.
    if plist_path.exists() or plist_path.is_symlink():
        definition = plistlib.loads(private_file(plist_path).read_bytes())
        refuse_pending(installed_config(definition, root))
        require(False, 'service_already_installed')
    with operation_lock(config['stateDirectory']):
        refuse_pending(config)
        return install(config, root, agent_dir, plist_path, domain)


def install(config, root, agent_dir, plist_path, domain):
    source = Path(__file__).parent
    digest = hashlib.sha256()
    contents = {}
    for filename in FILES:
        contents[filename] = (source / filename).read_bytes()
        digest.update(filename.encode() + b'\0' + contents[filename])
    release = private_directory(root / ('code-' + digest.hexdigest()[:16]))
    for filename, content in contents.items():
        immutable_file(release / filename, content)
    config_path = frozen_configuration(config, root)
    logs = private_directory(root / 'logs')
    for filename in ('service.out.log', 'service.err.log'):
        path = logs / filename
        if path.exists() or path.is_symlink():
            private_file(path, maximum=None)
        else:
            with path.open('xb') as output:
                os.fchmod(output.fileno(), 0o600)
    definition = {
        'Label': LABEL,
        # -s prevents system sleep only on AC; it neither wakes nor lights the display.
        'ProgramArguments': ['/usr/bin/caffeinate', '-s', sys.executable,
                             str(release / 'service.py'), '--config', str(config_path)],
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 300,
        'ExitTimeOut': 120, 'ProcessType': 'Background',
        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
                                 'PYTHONUNBUFFERED': '1'},
        'StandardOutPath': str(logs / 'service.out.log'),
        'StandardErrorPath': str(logs / 'service.err.log'),
    }
    agent_dir.mkdir(parents=True, exist_ok=True)
    require(agent_dir.is_dir() and agent_dir.stat().st_uid == os.getuid(), 'invalid_launchagent_directory')
    with plist_path.open('xb') as output:
        os.fchmod(output.fileno(), 0o600)
        plistlib.dump(definition, output)
        output.flush()
        os.fsync(output.fileno())
    try:
        subprocess.run(['launchctl', 'bootstrap', domain, str(plist_path)],
                       capture_output=True, check=True, timeout=30)
    except Exception:
        plist_path.unlink()
        raise
    print(json.dumps({'status': 'installed', 'label': LABEL,
                      'codeSha256': digest.hexdigest(), 'checkIntervalSeconds':
                      config.get('checkIntervalSeconds', 3600)}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'blocked', 'reason': error_code(error)}))
        sys.exit(1)
