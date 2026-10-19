import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'
import WebSocket, {WebSocketServer} from 'ws'
import {connectTunnel} from '../client.mts'
import type {ConnectTunnelOptions, TunnelConnection} from '../client.mts'

const accessToken = 'test-access-secret-unique'
const streamTicket = 'test-stream-secret-unique'
const controlToken = 'test-control-secret-unique'
let directory: string

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stf-tunnel-client-'))
  for (const name of ['valid', 'mismatch']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=STF tunnel test',
      '-addext', `subjectAltName=${name === 'valid' ? 'IP:127.0.0.1' : 'DNS:wrong.invalid'}`,
      '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.pem`)],
    {stdio: 'ignore'})
  }
})

after(async () => {
  await rm(directory, {recursive: true, force: true})
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Test condition timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function fixture(options: {
  tls?: 'valid' | 'mismatch'
  redirect?: boolean
  streamUrl?: (origin: string) => string
  onStream?: (stream: WebSocket) => void
  ticketMs?: number
  sessionMs?: number
} = {}) {
  const calls: Array<{method: string, url: string, authorization: string}> = []
  const sockets: net.Socket[] = []
  const streams = new WebSocketServer({noServer: true})
  const adbCalls: string[][] = []
  const received: Buffer[] = []
  const localReceived: Buffer[] = []
  let origin = ''
  let streamReady = false
  let local: net.Socket | undefined
  const handler: http.RequestListener = (request, response) => {
    calls.push({method: request.method!, url: request.url!,
      authorization: request.headers.authorization ?? ''})
    if (request.method === 'DELETE') {
      response.writeHead(204).end()
      return
    }
    if (options.redirect) {
      response.writeHead(307, {Location: `https://unexpected.invalid/?token=${accessToken}`}).end()
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), {serial: 'PHONE'})
      const websocketUrl = options.streamUrl ? options.streamUrl(origin) :
        `${origin.replace(/^http/, 'ws')}/adb-tunnel/v1/sessions/session1/stream`
      response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({
        id: 'session1', serial: 'PHONE', websocketUrl, ticket: streamTicket,
        controlToken, expiresAt: new Date(Date.now() + (options.ticketMs ?? 60000)).toISOString(),
        sessionExpiresAt: new Date(Date.now() + (options.sessionMs ?? 3600000)).toISOString()
      }))
    })
  }
  const server = options.tls ? https.createServer({
    key: await readFile(join(directory, `${options.tls}.key`)),
    cert: await readFile(join(directory, `${options.tls}.pem`))
  }, handler) : http.createServer(handler)
  server.on('connection', socket => sockets.push(socket))
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/adb-tunnel/v1/sessions/session1/stream')
    assert.equal(request.headers.authorization, `Bearer ${streamTicket}`)
    streams.handleUpgrade(request, socket, head, stream => {
      streams.emit('connection', stream)
    })
  })
  streams.on('connection', stream => {
    streamReady = true
    stream.on('message', (data, binary) => {
      assert.equal(binary, true)
      received.push(Buffer.from(data as Buffer))
      stream.send(data, {binary: true})
    })
    options.onStream?.(stream)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `${options.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as net.AddressInfo).port}`
  const runAdb = async (args: string[]) => {
    adbCalls.push(args)
    assert.deepEqual(args.slice(0, 4), ['-H', '127.0.0.1', '-P', '5037'])
    if (args[4] === 'connect') {
      assert.equal(streamReady, true, 'WebSocket must be ready before SDK adb connect')
      local = net.createConnection({host: '127.0.0.1', port: Number(args[5]!.split(':')[1])})
      sockets.push(local)
      local.on('data', (chunk: Buffer) => localReceived.push(chunk))
      local.on('error', () => {})
      await once(local, 'connect')
    }
  }
  const clientOptions: ConnectTunnelOptions = {
    server: origin, serial: 'PHONE', token: accessToken, runAdb, connectTimeoutMs: 3000
  }
  return {
    calls, adbCalls, received, localReceived, streams, clientOptions,
    get local() { return local! },
    async close(tunnel?: TunnelConnection) {
      await tunnel?.close()
      for (const stream of streams.clients) {
        stream.terminate()
      }
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(resolve => streams.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

describe('STF ADB tunnel client', () => {
  it('opens the verified stream before binding and cancels an unfinished bind promptly', async t => {
    const server = await fixture()
    const controller = new AbortController()
    const listen = net.Server.prototype.listen
    let bound = false
    t.mock.method(net.Server.prototype, 'listen', function(this: net.Server, ...args: unknown[]) {
      assert.equal(server.streams.clients.size, 1, 'stream must be ready before exposing localhost')
      bound = true
      const result = Reflect.apply(listen, this, args)
      controller.abort()
      return result
    })
    try {
      const started = Date.now()
      await assert.rejects(connectTunnel({...server.clientOptions, signal: controller.signal}),
        /Connection cancelled/)
      assert.equal(bound, true)
      assert.ok(Date.now() - started < 1500, 'abort must not wait for the bind timeout')
      assert.equal(server.adbCalls.length, 0)
      assert.equal(server.calls.at(-1)?.method, 'DELETE')
    }
    finally {
      t.mock.restoreAll()
      await server.close()
    }
  })

  it('settles an interrupted connect before issuing its independent cleanup disconnect', async () => {
    const server = await fixture()
    const controller = new AbortController()
    const original = server.clientOptions.runAdb!
    let connectSettled = false
    try {
      await assert.rejects(connectTunnel({...server.clientOptions, signal: controller.signal,
        runAdb: async args => {
          if (args[4] === 'connect') {
            await original(args)
            controller.abort()
            await new Promise(resolve => setTimeout(resolve, 40))
            connectSettled = true
            throw new Error('The SDK connect child was cancelled')
          }
          assert.equal(connectSettled, true, 'cleanup must not race an outstanding connect')
          await original(args)
        }}), /cancelled|could not connect/)
      assert.deepEqual(server.adbCalls.map(args => args[4]), ['connect', 'disconnect'])
      assert.equal(server.calls.at(-1)?.method, 'DELETE')
    }
    finally {
      await server.close()
    }
  })

  it('keeps an attached stream after ticket expiry and closes at the session deadline', async () => {
    const server = await fixture({ticketMs: 80, sessionMs: 220})
    let tunnel: TunnelConnection | undefined
    try {
      tunnel = await connectTunnel(server.clientOptions)
      let ended = false
      void tunnel.closed.then(() => { ended = true }, () => { ended = true })
      const expiry = assert.rejects(tunnel.closed, /session expired/)
      await new Promise(resolve => setTimeout(resolve, 110))
      assert.equal(ended, false, 'one-use ticket expiry must not end an attached ADB session')
      await expiry
    }
    finally {
      await server.close(tunnel)
    }
  })

  it('transfers binary data through one loopback connection and cleans up only its session', async () => {
    const server = await fixture()
    let tunnel: TunnelConnection | undefined
    try {
      tunnel = await connectTunnel(server.clientOptions)
      assert.match(tunnel.endpoint, /^127\.0\.0\.1:\d+$/)
      assert.equal(tunnel.serial, 'PHONE')
      const packet = Buffer.from([0, 255, 0, 128, 0, 1, 13, 10])
      server.local.write(packet)
      await waitUntil(() => server.localReceived.length > 0)
      assert.deepEqual(Buffer.concat(server.received), packet)
      assert.deepEqual(Buffer.concat(server.localReceived), packet)
      const extra = net.createConnection({host: '127.0.0.1',
        port: Number(tunnel.endpoint.split(':')[1])})
      await assert.rejects(once(extra, 'connect'))
      extra.destroy()
      await tunnel.close()
      await tunnel.closed
      assert.deepEqual(server.adbCalls.map(args => args.slice(4)), [
        ['connect', tunnel.endpoint], ['disconnect', tunnel.endpoint]
      ])
      assert.deepEqual(server.calls, [
        {method: 'POST', url: '/adb-tunnel/v1/sessions', authorization: `Bearer ${accessToken}`},
        {method: 'DELETE', url: '/adb-tunnel/v1/sessions/session1',
          authorization: `Bearer ${controlToken}`}
      ])
    }
    finally {
      await server.close(tunnel)
    }
  })

  it('buffers the gateway greeting until SDK adb opens its local connection', async () => {
    const greeting = Buffer.from([67, 78, 88, 78, 0, 255])
    const server = await fixture({onStream: stream => stream.send(greeting, {binary: true})})
    let tunnel: TunnelConnection | undefined
    try {
      tunnel = await connectTunnel(server.clientOptions)
      await waitUntil(() => server.localReceived.length > 0)
      assert.deepEqual(Buffer.concat(server.localReceived), greeting)
    }
    finally {
      await server.close(tunnel)
    }
  })

  it('fails closed on lease/stream loss and does not reacquire a device automatically', async () => {
    const server = await fixture()
    let tunnel: TunnelConnection | undefined
    try {
      tunnel = await connectTunnel(server.clientOptions)
      for (const stream of server.streams.clients) {
        stream.close(1008, `${accessToken} ${streamTicket} ${controlToken}`)
      }
      await assert.rejects(tunnel.closed, error => {
        assert.match((error as Error).message, /closed/)
        assert.doesNotMatch((error as Error).message,
          new RegExp(`${accessToken}|${streamTicket}|${controlToken}`))
        return true
      })
      assert.equal(server.calls.filter(call => call.method === 'POST').length, 1)
      assert.equal(server.adbCalls.filter(args => args[4] === 'disconnect').length, 1)
    }
    finally {
      await server.close(tunnel)
    }
  })

  it('accepts a custom CA while preserving TLS verification for API and WebSocket', async () => {
    const server = await fixture({tls: 'valid'})
    let tunnel: TunnelConnection | undefined
    try {
      tunnel = await connectTunnel({...server.clientOptions, caFile: join(directory, 'valid.pem')})
      server.local.write(Buffer.from('tls roundtrip'))
      await waitUntil(() => server.localReceived.length > 0)
      assert.equal(Buffer.concat(server.localReceived).toString(), 'tls roundtrip')
    }
    finally {
      await server.close(tunnel)
    }
  })

  it('rejects an untrusted TLS certificate before sending a token', async () => {
    const server = await fixture({tls: 'valid'})
    try {
      await assert.rejects(connectTunnel(server.clientOptions), /verified connection/)
      assert.equal(server.calls.length, 0)
      assert.equal(server.adbCalls.length, 0)
    }
    finally {
      await server.close()
    }
  })

  it('rejects a hostname mismatch even when the certificate is trusted', async () => {
    const server = await fixture({tls: 'mismatch'})
    try {
      await assert.rejects(connectTunnel({...server.clientOptions,
        caFile: join(directory, 'mismatch.pem')}), /verified connection/)
      assert.equal(server.calls.length, 0)
      assert.equal(server.adbCalls.length, 0)
    }
    finally {
      await server.close()
    }
  })

  it('rejects HTTP redirects without following or exposing a token-bearing location', async () => {
    const server = await fixture({redirect: true})
    try {
      await assert.rejects(connectTunnel(server.clientOptions), error => {
        assert.match((error as Error).message, /HTTP 307/)
        assert.doesNotMatch((error as Error).message, new RegExp(accessToken))
        return true
      })
      assert.equal(server.calls.length, 1)
      assert.equal(server.adbCalls.length, 0)
    }
    finally {
      await server.close()
    }
  })

  it('rejects a cross-origin or token-bearing WebSocket URL before SDK adb', async () => {
    for (const streamUrl of [
      () => 'wss://unexpected.invalid/adb-tunnel/v1/sessions/session1/stream',
      (origin: string) => `${origin.replace(/^http/, 'ws')}` +
        `/adb-tunnel/v1/sessions/session1/stream?ticket=${streamTicket}`
    ]) {
      const server = await fixture({streamUrl})
      try {
        await assert.rejects(connectTunnel(server.clientOptions), error => {
          assert.match((error as Error).message, /unexpected stream address/)
          assert.doesNotMatch((error as Error).message, new RegExp(streamTicket))
          return true
        })
        assert.equal(server.adbCalls.length, 0)
      }
      finally {
        await server.close()
      }
    }
  })

  it('requires a private POSIX token file and reads it without passing it to adb', async () => {
    const server = await fixture()
    const tokenFile = join(directory, 'access-token')
    let tunnel: TunnelConnection | undefined
    try {
      await writeFile(tokenFile, `${accessToken}\n`, {mode: 0o600})
      const options = {...server.clientOptions, tokenFile}
      delete options.token
      if (process.platform !== 'win32') {
        await chmod(tokenFile, 0o644)
        await assert.rejects(connectTunnel(options), /permissions 0600/)
        assert.equal(server.calls.length, 0)
        await chmod(tokenFile, 0o600)
      }
      tunnel = await connectTunnel(options)
      assert.doesNotMatch(JSON.stringify(server.adbCalls), new RegExp(accessToken))
    }
    finally {
      await server.close(tunnel)
    }
  })

  it('rejects insecure remote origins and URL credentials, paths, queries, and fragments', async () => {
    for (const server of [
      'http://stf.finservice.tech', 'https://user:password@stf.finservice.tech',
      'https://stf.finservice.tech/path', 'https://stf.finservice.tech?token=secret',
      'https://stf.finservice.tech#secret'
    ]) {
      await assert.rejects(connectTunnel({server, serial: 'PHONE', token: accessToken,
        runAdb: async () => { throw new Error('Must not invoke adb') }}), /HTTPS origin/)
    }
  })

  it('cleans up an SDK connection failure without exposing subprocess output', async () => {
    const server = await fixture()
    try {
      await assert.rejects(connectTunnel({...server.clientOptions, runAdb: async args => {
        server.adbCalls.push(args)
        if (args[4] === 'connect') {
          throw new Error(`Synthetic SDK failure: ${accessToken} ${streamTicket}`)
        }
      }}), error => {
        assert.match((error as Error).message, /SDK adb could not connect/)
        assert.doesNotMatch((error as Error).message, new RegExp(`${accessToken}|${streamTicket}`))
        return true
      })
      assert.equal(server.calls.at(-1)?.method, 'DELETE')
      assert.equal(server.adbCalls.at(-1)?.[4], 'disconnect')
    }
    finally {
      await server.close()
    }
  })
})
