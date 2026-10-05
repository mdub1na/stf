#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import process from 'node:process';

if (!process.env.KUBECONFIG || process.stdin.isTTY) {
  throw new Error('Set KUBECONFIG and pass OAuth credentials as JSON through stdin.');
}

function kubectl(args, input) {
  return execFileSync('kubectl', ['--request-timeout=30s', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 45000
  });
}

try {
  const config = JSON.parse(kubectl(['config', 'view', '--minify', '-o', 'json']));
  if (config.clusters?.[0]?.cluster?.server !== 'https://192.168.0.121:6443') {
    throw new Error('Unexpected target cluster.');
  }

  let input = '';
  let credentials = null;
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) {
      throw new Error('Credential input is too large.');
    }
    try {
      credentials = JSON.parse(input);
      break;
    } catch {
      // A pipe or file can deliver the JSON document across multiple chunks.
      credentials = null;
    }
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('Invalid OAuth credential document.');
  }
  for (const key of ['clientId', 'clientSecret']) {
    if (typeof credentials[key] !== 'string' || !credentials[key].trim()) {
      throw new Error('Incomplete OAuth credentials.');
    }
  }

  const data = {
    STF_AUTH_OAUTH2_OAUTH_CLIENT_ID: Buffer.from(credentials.clientId.trim()).toString('base64'),
    STF_AUTH_OAUTH2_OAUTH_CLIENT_SECRET: Buffer.from(credentials.clientSecret.trim()).toString('base64')
  };
  // Values travel through stdin, never through shell arguments or log output.
  kubectl(['apply', '-f', '-'], JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {namespace: 'devicehub', name: 'stf-gitlab-oauth'},
    type: 'Opaque',
    data
  }));
  console.log('Created or updated devicehub/stf-gitlab-oauth. No workloads were switched.');
} catch {
  console.error('GitLab Secret bootstrap failed. Check credentials, cluster and permissions.');
  process.exitCode = 1;
}
