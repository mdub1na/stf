import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import path from 'node:path'
import {afterEach, describe, it} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'

import {runJson, ManagedProcess} from '../process.mts'
import {IosRuntime} from '../runtime.mts'
import type {RuntimeOptions, RuntimeDependencies} from '../runtime.mts'
import {createServer} from '../server.mts'
import {WdaClient} from '../wda.mts'

const token = 'test-token-that-is-long-enough-for-prototype'
const cleanups: Array<() => Promise<unknown>> = []
const options: RuntimeOptions = {
  udid: '00000000-0000000000000001', bundleId: 'test.wda.xctrunner'
, xctest: 'WebDriverAgentRunner.xctest', goIos: 'ios', iproxy: 'iproxy'
, wdaPort: 18100, mjpegPort: 19100, tunnelPort: 28100, retryMs: 30, startupMs: 500
}

afterEach(async() => {
  for (const close of cleanups.splice(0).reverse()) {
    await close()
  }
})

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for state')
    await delay(10)
  }
}

async function fixture() {
  const calls: Array<{method: string, path: string, body: any}> = []
  let failure = false
  const image = Buffer.from('89504e470d0a1a0a', 'hex')
  const origin = await listen(http.createServer(async(req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const input = Buffer.concat(chunks).toString()
    calls.push({method: req.method!, path: req.url!, body: input ? JSON.parse(input) : null})
    res.setHeader('Content-Type', 'application/json')
    if (failure) {
      res.writeHead(500)
      res.end(JSON.stringify({value: {error: 'invalid session id', message: 'Session is gone'}}))
    }
    else if (req.url === '/session' && req.method === 'POST') {
      res.end(JSON.stringify({value: {sessionId: 'owned-session'}}))
    }
    else if (req.url?.endsWith('/window/size')) {
      res.end(JSON.stringify({value: {width: 391, height: 845}}))
    }
    else if (req.url?.endsWith('/screenshot')) {
      res.end(JSON.stringify({value: image.toString('base64')}))
    }
    else {
      res.end(JSON.stringify({value: {ready: true}}))
    }
  }))
  const wda = new WdaClient(origin, 500)
  await wda.open()
  const runtime = new IosRuntime(options, {wda, log: () => null})
  runtime.state = 'ready'
  const api = await listen(createServer(runtime, token))
  const request = (route: string, value?: unknown, headers: Record<string, string> = {}) =>
    fetch(api + route, {
      method: typeof value === 'undefined' ? 'GET' : 'POST'
    , headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers}
    , ...(typeof value === 'undefined' ? {} : {body: JSON.stringify(value)})
    })
  return {runtime, calls, wda, api, request, image, fail: () => {
    failure = true
  }}
}

describe('iOS prototype HTTP and WDA integration', () => {
  it('requires authentication and rejects cross-origin control', async() => {
    const f = await fixture()
    assert.equal((await fetch(f.api + '/device')).status, 401)
    assert.equal((await f.request('/home', {}, {Origin: 'https://example.com'})).status, 403)
    assert.equal(f.calls.length, 1)
    assert.equal((await f.request('/health')).status, 200)
  })

  it('reports not-ready without issuing device commands', async() => {
    const f = await fixture()
    f.runtime.state = 'waiting'
    assert.equal((await f.request('/tap', {x: 0.5, y: 0.5})).status, 503)
    assert.equal((await f.request('/device')).status, 200)
    assert.equal(f.calls.length, 1)
  })

  it('converts normalized coordinates to WDA points and preserves swipe duration', async() => {
    const f = await fixture()
    const response = await f.request('/swipe', {
      from: {x: 0.5, y: 1}, to: {x: 0, y: 0}, durationMs: 750
    })
    assert.equal(response.status, 200)
    const action = f.calls.find(call => call.path.endsWith('/actions'))!
    assert.equal(action.path, '/session/owned-session/actions')
    assert.deepEqual(action.body.actions[0].actions, [
      {type: 'pointerMove', duration: 0, origin: 'viewport', x: 195, y: 844}
    , {type: 'pointerDown', button: 0}
    , {type: 'pointerMove', duration: 750, origin: 'viewport', x: 0, y: 0}
    , {type: 'pointerUp', button: 0}
    ])
  })

  it('rejects malformed commands before sending anything to WDA', async() => {
    const f = await fixture()
    for (const input of [{x: -1, y: 0}, {x: '0.5', y: 0}, {x: 0, y: 2}]) {
      assert.equal((await f.request('/tap', input)).status, 400)
    }
    assert.equal((await f.request('/swipe', {from: {}, to: {x: 0, y: 0}})).status, 400)
    assert.equal((await f.request('/text', {text: 'x'.repeat(4097)})).status, 400)
    assert.equal((await f.request('/text', {text: 'x'.repeat(17000)})).status, 400)
    assert.equal((await f.request('/text', null)).status, 400)
    assert.equal(f.calls.length, 1)
  })

  it('sends text literally and returns screenshot bytes without JSON wrapping', async() => {
    const f = await fixture()
    const text = 'Привет "iPhone"; $(touch /tmp/unexpected)'
    assert.equal((await f.request('/text', {text})).status, 200)
    assert.deepEqual(f.calls.at(-1)!.body, {value: [text]})
    const response = await f.request('/screenshot')
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.image)
  })

  it('reports WDA failure and serializes commands across clients', async() => {
    const f = await fixture()
    const events: string[] = []
    await Promise.all([
      f.runtime.execute(async() => {
        events.push('start')
        await delay(20)
        events.push('end')
      })
    , f.runtime.execute(async() => {
        events.push('next')
      })
    ])
    assert.deepEqual(events, ['start', 'end', 'next'])
    f.fail()
    const response = await f.request('/home', {})
    assert.equal(response.status, 502)
    assert.equal((await response.json() as {error: string}).error, 'Session is gone')
  })

  it('drops commands queued before the runtime reconnects', async() => {
    const f = await fixture()
    let executed = false
    const pending = f.runtime.execute(async() => {
      executed = true
    })
    f.runtime.generation += 1
    await assert.rejects(pending, /not ready/)
    assert.equal(executed, false)
  })

  it('proxies MJPEG and closes the upstream when the viewer disconnects', async() => {
    const f = await fixture()
    let closed = false
    const upstream = await listen(http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=frame'})
      res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\nframe-bytes\r\n')
      res.once('close', () => {
        closed = true
      })
    }))
    f.runtime.options.mjpegPort = Number(new URL(upstream).port)
    const response = await f.request('/screen')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /multipart/)
    const reader = response.body!.getReader()
    const chunk = await reader.read()
    assert.match(Buffer.from(chunk.value!).toString(), /frame-bytes/)
    await reader.cancel()
    await until(() => closed)
  })
})

describe('iOS prototype lifecycle', () => {
  function dependencies(f: Awaited<ReturnType<typeof fixture>>) {
    const spawned: Array<{
      binary: string, args: string[], stopped: boolean, failure: Error | null
    }> = []
    const commands: string[][] = []
    let connected = true
    const deps: RuntimeDependencies = {
      wda: f.wda
    , log: () => null
    , run: async() => ''
    , json: async(_binary, args) => {
        commands.push(args)
        if (args[0] === 'list') {
          return {deviceList: connected ? [options.udid] : []}
        }
        if (args.includes('ls')) {
          return [{udid: options.udid}]
        }
        return {ProductVersion: '18.0'}
      }
    , start: (binary, args) => {
        const child = {binary, args, stopped: false, failure: null as Error | null
        , stop: async() => {
            child.stopped = true
          }}
        spawned.push(child)
        return child
      }
    }
    return {deps, spawned, commands, disconnect: () => {
      connected = false
    }}
  }

  it('selects one UDID, uses loopback forwards and cleans up only its own processes', async() => {
    const f = await fixture()
    const d = dependencies(f)
    const runtime = new IosRuntime({...options}, d.deps)
    cleanups.push(() => runtime.stop())
    runtime.start()
    await until(() => runtime.state === 'ready')
    assert.deepEqual(d.spawned[0]!.args, [
      '-u', options.udid, '-l', '-s', '127.0.0.1', '18100:8100', '19100:9100'
    ])
    assert.ok(d.commands.filter(args => args[0] !== 'list')
      .every(args => args.includes('--udid=' + options.udid)))
    await runtime.stop()
    assert.equal(runtime.state, 'stopped')
    assert.ok(d.spawned.every(child => child.stopped))
    assert.ok(f.calls.some(call => call.method === 'DELETE' &&
      call.path === '/session/owned-session'))
  })

  it('retries a missing phone without starting WDA on another connected device', async() => {
    const f = await fixture()
    const d = dependencies(f)
    d.disconnect()
    const runtime = new IosRuntime({...options}, d.deps)
    cleanups.push(() => runtime.stop())
    runtime.start()
    await until(() => runtime.lastError?.includes('not connected') === true)
    assert.equal(d.spawned.length, 0)
    assert.equal(runtime.state, 'waiting')
  })

  it('restarts after a child dies and never presents the failed session as ready', async() => {
    const f = await fixture()
    const d = dependencies(f)
    const runtime = new IosRuntime({...options}, d.deps)
    cleanups.push(() => runtime.stop())
    runtime.start()
    await until(() => runtime.state === 'ready')
    const generation = runtime.generation
    d.spawned[1]!.failure = new Error('USB disconnected')
    await until(() => runtime.generation > generation)
    await until(() => runtime.state === 'ready')
    assert.ok(d.spawned.slice(0, 2).every(child => child.stopped))
    assert.equal(d.spawned.length, 4)
  })

  it('does not start a runner when the selected device has no tunnel', async() => {
    const f = await fixture()
    const d = dependencies(f)
    const json = d.deps.json
    d.deps.json = (binary, args) => args.includes('ls') ?
      Promise.resolve([]) : json(binary, args)
    const runtime = new IosRuntime({...options}, d.deps)
    cleanups.push(() => runtime.stop())
    runtime.start()
    await until(() => runtime.lastError?.includes('No go-ios tunnel') === true)
    assert.equal(d.spawned.length, 0)
  })

  it('stops a failed forward without launching WDA on an occupied port', async() => {
    const f = await fixture()
    const d = dependencies(f)
    const start = d.deps.start
    d.deps.start = (binary, args) => {
      const child = start(binary, args)
      child.failure = new Error('address already in use')
      return child
    }
    const runtime = new IosRuntime({...options}, d.deps)
    cleanups.push(() => runtime.stop())
    runtime.start()
    await until(() => runtime.lastError?.includes('address already in use') === true)
    await runtime.stop()
    assert.ok(d.spawned.length >= 1)
    assert.ok(d.spawned.every(child => child.binary === 'iproxy' && child.stopped))
  })

  it('cancels developer-image preparation on shutdown', async() => {
    const f = await fixture()
    const d = dependencies(f)
    let preparing = false
    d.deps.run = (_binary, _args, _timeout, signal) => new Promise((_resolve, reject) => {
      preparing = true
      signal!.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
    })
    const runtime = new IosRuntime({...options}, d.deps)
    cleanups.push(() => runtime.stop())
    runtime.start()
    await until(() => preparing)
    await runtime.stop()
    assert.equal(runtime.state, 'stopped')
    assert.equal(d.spawned.length, 0)
  })
})

describe('iOS prototype executable boundary', () => {
  it('passes arguments literally, rejects invalid JSON and bounds command execution', async() => {
    const literal = 'some-path; $(touch /tmp/never-execute)'
    const result = await runJson(process.execPath, [
      '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', literal
    ])
    assert.deepEqual(result, [literal])
    await assert.rejects(runJson(process.execPath, ['-e', 'process.stdout.write("invalid")']),
      /did not return JSON/)
    await assert.rejects(runJson(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 30))
  })

  it('reaps a long-running child on shutdown', async() => {
    const child = new ManagedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await child.stop()
    assert.ok(child.failure)
  })

  it('shows help without installed STF dependencies or Apple tooling', async() => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [path.resolve(import.meta.dirname, '../main.mts'), '--help'],
        (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    assert.match(output, /127.0.0.1/)
    assert.match(output, /--udid/)
  })

  it('reports missing tools with a failing doctor exit code', async() => {
    const result = await new Promise<{code: number, output: string}>(resolve => {
      execFile(process.execPath, [path.resolve(import.meta.dirname, '../main.mts')
        , '--doctor', '--go-ios', '/nonexistent/ios', '--iproxy', '/nonexistent/iproxy'],
      (error, stdout) => resolve({code: Number(error?.code || 0), output: stdout}))
    })
    assert.equal(result.code, 1)
    const report = JSON.parse(result.output)
    assert.equal(report.passed, false)
    assert.equal(report.checks.find((c: {name: string}) => c.name === 'go-ios').passed, false)
  })
})
