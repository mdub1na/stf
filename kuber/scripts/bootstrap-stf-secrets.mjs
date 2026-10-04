#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import process from 'node:process';

if (!process.env.KUBECONFIG) {
  throw new Error('Set KUBECONFIG explicitly before bootstrapping cluster secrets.');
}

function kubectl(args, input) {
  return execFileSync('kubectl', ['--request-timeout=30s', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 45000
  });
}

function readResource(namespace, kind, name) {
  const output = kubectl([
    '-n', namespace, 'get', kind, name, '--ignore-not-found', '-o', 'json'
  ]);
  return output.trim() ? JSON.parse(output) : null;
}

function ensureSecret(namespace, name, key, value) {
  const existing = readResource(namespace, 'secret', name);
  if (existing) {
    if (!existing.data?.[key]) {
      throw new Error(`Existing secret ${namespace}/${name} lacks ${key}.`);
    }
    console.log(`Preserved ${namespace}/${name}.`);
    return;
  }
  kubectl(['apply', '-f', '-'], JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {namespace, name},
    type: 'Opaque',
    data: {[key]: Buffer.from(value).toString('base64')}
  }));
  console.log(`Created ${namespace}/${name}.`);
}

try {
  const config = JSON.parse(kubectl(['config', 'view', '--minify', '-o', 'json']));
  if (config.clusters?.[0]?.cluster?.server !== 'https://192.168.0.121:6443') {
    throw new Error('Refusing to bootstrap secrets into a different cluster.');
  }

  const env = readResource('devicehub', 'configmap', 'devicehub-env')?.data;
  const existingBind = readResource('devicehub', 'secret', 'devicehub-ldap-bind');
  const bindPassword = existingBind?.data?.LDAP_BIND_CREDENTIALS
    ? Buffer.from(existingBind.data.LDAP_BIND_CREDENTIALS, 'base64').toString()
    : env?.LDAP_BIND_CREDENTIALS;

  if (!bindPassword || !env?.LDAP_BIND_DN) {
    throw new Error('No existing LDAP bind credential is available.');
  }
  if (env.LDAP_BIND_DN.toLowerCase() !== 'cn=admin,dc=ldap,dc=putmyhexon,dc=ru') {
    throw new Error('LDAP bind user is not the expected administrator.');
  }

  // Send the password through stdin, not command arguments or a local file.
  kubectl([
    '-n', 'openldap', 'exec', '-i', 'openldap-0', '--', 'ldapwhoami',
    '-x', '-H', 'ldap://127.0.0.1:389', '-D', env.LDAP_BIND_DN, '-y', '/dev/stdin'
  ], bindPassword);

  ensureSecret('openldap', 'openldap-credentials', 'LDAP_ADMIN_PASSWORD', bindPassword);
  ensureSecret('devicehub', 'devicehub-ldap-bind', 'LDAP_BIND_CREDENTIALS', bindPassword);
  ensureSecret('devicehub', 'devicehub-session', 'SECRET', randomBytes(48).toString('hex'));
} catch {
  console.error('Secret bootstrap failed. Check the target cluster, LDAP bind and access permissions.');
  process.exitCode = 1;
}
