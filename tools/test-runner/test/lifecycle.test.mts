import assert from 'node:assert/strict'
import {readFile, stat, access} from 'node:fs/promises'
import {join} from 'node:path'
import {test} from 'node:test'
import {CoordinatorClient} from '../coordinator.mts'
import {cli, directory, farm, gone, token, until} from './helpers.mts'

function args(url: string, tokenFile: string, command: string[]) {
  return ['utils', 'test', 'run', '--farm-url', url, '--token-file', tokenFile,
    '--runner', 'appium', '--platform', 'Android', '--cleanup-timeout', '3', '--', ...command]
}

test('ordinary repository Appium client uses a credential-free local URL and one lease', async() => {
  const temp = await directory()
  const api = await farm()
  try {
    const artifact = join(temp.path, 'child.json')
    const script = `
      const fs = await import('node:fs/promises');
      const connection = JSON.parse(await fs.readFile(process.env.STF_CONNECTION_FILE, 'utf8'));
      const result = await fetch(process.env.APPIUM_SERVER_URL + '/session', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({capabilities:{alwaysMatch: JSON.parse(process.env.APPIUM_CAPABILITIES_JSON)}})
      });
      await fs.writeFile(process.argv[1], JSON.stringify({connection,
        response: await result.json(), file: process.env.STF_CONNECTION_FILE,
        mode: (await fs.stat(process.env.STF_CONNECTION_FILE)).mode & 511,
        forbidden: Object.keys(process.env).filter(k => ['FARM_TOKEN','FARM_TOKEN_FILE','COORDINATOR_TOKEN',
          'COORDINATOR_TOKEN_FILE','COORDINATOR_URL','STF_TOKEN','STF_ACCESS_TOKEN'].includes(k))
      }));
    `
    const result = await cli(args(api.url, temp.tokenFile,
      [process.execPath, '--input-type=module', '--eval', script, artifact]), {
      FARM_TOKEN: token, COORDINATOR_TOKEN: token, COORDINATOR_URL: 'http://must-not-acquire.invalid',
      STF_TOKEN: token, STF_ACCESS_TOKEN: token, FARM_TOKEN_FILE: temp.tokenFile
    }).finished
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token))
    const evidence = JSON.parse(await readFile(artifact, 'utf8'))
    assert.equal(evidence.connection.version, 1)
    assert.equal(evidence.connection.leaseId, 'lease-1')
    assert.equal(evidence.connection.appium.capabilities['appium:udid'], 'PHONE')
    assert.match(evidence.connection.appium.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(evidence.response.value.sessionId, 'session-1')
    assert.equal(evidence.mode, 0o600)
    assert.deepEqual(evidence.forbidden, [])
    await assert.rejects(access(evidence.file))
    assert.equal(api.events.filter(e => e.path === '/api/v1/requests').length, 1)
    assert.ok(api.events.some(e => e.path.endsWith('/webdriver/session') && e.auth === `Bearer ${token}`))
    assert.ok(api.events.some(e => e.method === 'DELETE' && e.path === '/api/v1/leases/lease-1'))
  }
  finally { await api.close(); await temp.close() }
})

test('preserves failing test exit code after confirmed cleanup', async() => {
  const temp = await directory(); const api = await farm()
  try {
    const result = await cli(args(api.url, temp.tokenFile, [process.execPath, '-e', 'process.exit(7)'])).finished
    assert.equal(result.code, 7, result.stderr)
    assert.match(result.stderr, /cleanup confirmed/)
  }
  finally { await api.close(); await temp.close() }
})

test('queue timeout cancels the request without starting repository code', async() => {
  const temp = await directory(); const api = await farm({queued: true})
  try {
    const input = args(api.url, temp.tokenFile, [process.execPath, '-e', 'console.log("SHOULD_NOT_RUN")'])
    input.splice(input.indexOf('--'), 0, '--queue-timeout', '1')
    const result = await cli(input).finished
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Timed out waiting/)
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/)
    assert.ok(api.events.some(e => e.method === 'DELETE' && e.path === '/api/v1/requests/request-1'))
  }
  finally { await api.close(); await temp.close() }
})

test('cancellation while allocation response is in flight obtains its ID and cancels it', async() => {
  const temp = await directory(); const api = await farm({allocationDelay: 500})
  try {
    const running = cli(args(api.url, temp.tokenFile, [process.execPath, '-e', 'console.log("SHOULD_NOT_RUN")']))
    await until(() => api.events.some(e => e.path === '/api/v1/requests'))
    running.child.kill('SIGTERM')
    const result = await running.finished
    assert.equal(result.code, 143)
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/)
    assert.ok(api.events.some(e => e.method === 'DELETE' && e.path === '/api/v1/requests/request-1'))
    assert.ok(api.events.some(e => e.method === 'DELETE' && e.path === '/api/v1/leases/lease-1'))
  }
  finally { await api.close(); await temp.close() }
})

test('heartbeat failure kills the child process and its descendants before releasing', async() => {
  const temp = await directory(); const api = await farm({badRenewal: true})
  try {
    const pidFile = join(temp.path, 'descendant')
    const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`
    const result = await cli(args(api.url, temp.tokenFile, [process.execPath, '-e', script, pidFile])).finished
    assert.equal(result.code, 1)
    assert.match(result.stderr, /heartbeat failed/)
    const pid = Number(await readFile(pidFile, 'utf8'))
    await until(() => gone(pid))
    assert.ok(api.events.some(e => e.path.endsWith('/renew')))
    assert.ok(api.events.some(e => e.method === 'DELETE' && e.path === '/api/v1/leases/lease-1'))
  }
  finally { await api.close(); await temp.close() }
})

test('SIGTERM stops a running test and confirms cleanup before wrapper exits', async() => {
  const temp = await directory(); const api = await farm()
  try {
    const running = cli(args(api.url, temp.tokenFile, [process.execPath, '-e', 'console.log("READY");setInterval(()=>{},1000)']))
    await until(() => running.stdout().includes('READY'))
    running.child.kill('SIGTERM')
    const result = await running.finished
    assert.equal(result.code, 143, result.stderr)
    assert.match(result.stderr, /cleanup confirmed/)
  }
  finally { await api.close(); await temp.close() }
})

test('quarantined cleanup fails an otherwise successful test', async() => {
  const temp = await directory(); const api = await farm({quarantine: true})
  try {
    const result = await cli(args(api.url, temp.tokenFile, [process.execPath, '-e', 'process.exit(0)'])).finished
    assert.equal(result.code, 1)
    assert.match(result.stderr, /quarantined/)
    assert.doesNotMatch(result.stderr, /cleanup confirmed/)
  }
  finally { await api.close(); await temp.close() }
})

test('refuses a connection path belonging to another lease and cancels allocation', async() => {
  const temp = await directory(); const api = await farm({wrongPath: true})
  try {
    const result = await cli(args(api.url, temp.tokenFile, [process.execPath, '-e', 'process.exit(0)'])).finished
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Unexpected coordinator connection path/)
    assert.ok(api.events.some(e => e.method === 'DELETE' && e.path === '/api/v1/requests/request-1'))
  }
  finally { await api.close(); await temp.close() }
})

test('allocation retries reuse one idempotency key after an ambiguous upstream failure', async() => {
  const temp = await directory(); const api = await farm({failFirstAllocation: true})
  try {
    const client = await CoordinatorClient.create({url: api.url, tokenFile: temp.tokenFile})
    const lease = await client.acquire({runner: 'appium', platform: 'Android', runId: 'retry-test',
      queueTimeoutSeconds: 3, maxDurationSeconds: 120})
    await client.release(lease, 3)
    const attempts = api.events.filter(e => e.path === '/api/v1/requests')
    assert.equal(attempts.length, 2)
    assert.ok(attempts[0]!.key)
    assert.equal(attempts[0]!.key, attempts[1]!.key)
  }
  finally { await api.close(); await temp.close() }
})

test('a run cancelled before acquisition does not create an orphan request', async() => {
  const temp = await directory(); const api = await farm()
  try {
    const client = await CoordinatorClient.create({url: api.url, tokenFile: temp.tokenFile})
    await assert.rejects(client.acquire({runner: 'appium', platform: 'Android', runId: 'cancelled',
      queueTimeoutSeconds: 3, maxDurationSeconds: 120}, AbortSignal.abort()), /cancelled/)
    assert.equal(api.events.length, 0)
  }
  finally { await api.close(); await temp.close() }
})
