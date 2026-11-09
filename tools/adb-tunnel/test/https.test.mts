import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {StfAccess} from '../access.mts'
import {connectTunnel} from '../client.mts'
import {createGateway} from '../gateway.mts'

function packet(command: string, arg0: number, arg1: number, value = ''): Buffer {
  const body = Buffer.from(value)
  const data = Buffer.alloc(24 + body.length)
  data.write(command, 0, 'ascii')
  data.writeUInt32LE(arg0, 4)
  data.writeUInt32LE(arg1, 8)
  data.writeUInt32LE(body.length, 12)
  data.writeUInt32LE((data.readUInt32LE(0) ^ 0xffffffff) >>> 0, 20)
  body.copy(data, 24)
  return data
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as net.AddressInfo).port
}

test('CLI → verified HTTPS/WSS → gateway → STF API authorization → ADB, then revoke',
  {timeout: 15000}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stf-adb-https-'))
    t.after(() => rm(directory, {recursive: true, force: true}))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=STF isolated prototype', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], {stdio: 'ignore'})

    const token = 'isolated-stf-user-credential'
    const state = {owned: true, started: false, apiChecks: 0}
    const backendPackets: string[] = []
    const peers = new Set<net.Socket>()
    const backend = net.createServer(socket => {
      peers.add(socket)
      socket.once('close', () => peers.delete(socket))
      socket.on('error', () => {})
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 24) {
          const length = buffer.readUInt32LE(12)
          if (buffer.length < 24 + length) return
          const frame = buffer.subarray(0, 24 + length)
          buffer = buffer.subarray(24 + length)
          const command = frame.toString('ascii', 0, 4)
          backendPackets.push(command)
          if (command === 'CNXN') {
            socket.write(packet('CNXN', 0x01000000, 65535, 'device::ro.product.model=Fixture;\0'))
          }
          else if (command === 'OPEN') {
            assert.equal(frame.subarray(24).toString(), 'shell:echo verified-tunnel\0')
            socket.write(packet('OKAY', 1, frame.readUInt32LE(4)))
            socket.write(packet('WRTE', 1, frame.readUInt32LE(4), 'verified-tunnel\n'))
          }
        }
      })
    })
    const backendPort = await listen(backend)
    t.after(async () => {
      for (const socket of peers) socket.destroy()
      await new Promise<void>(resolve => backend.close(() => resolve()))
    })

    const api = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      state.apiChecks++
      response.setHeader('Content-Type', 'application/json')
      if (!state.owned) {
        response.writeHead(403).end(JSON.stringify({success: false}))
        return
      }
      const device = {
        serial: 'ANDROID-FIXTURE', platform: 'Android', present: true, ready: true
      , owner: {email: 'developer@example.test', group: 'user-group'}
      , channel: 'device-worker', provider: {name: 'fixture-provider', channel: 'provider-worker'}
      , remoteConnect: state.started, remoteConnectUrl: `stf.example.test:${backendPort}`
      }
      const data = request.url === '/api/v1/user' ? {user: {email: device.owner.email}} :
        request.method === 'POST' ? (state.started = true, {remoteConnectUrl: device.remoteConnectUrl}) : {device}
      response.end(JSON.stringify({success: true, ...data}))
    })
    const apiPort = await listen(api)
    t.after(() => new Promise<void>(resolve => {
      api.close(() => resolve())
      api.closeAllConnections()
    }))

    let gateway: ReturnType<typeof createGateway> | undefined
    const frontend = https.createServer({
      key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem'))
    }, (request, response) => gateway!.server.emit('request', request, response))
    frontend.on('upgrade', (request, socket, head) => gateway!.server.emit('upgrade', request, socket, head))
    frontend.on('connection', socket => {
      peers.add(socket)
      socket.once('close', () => peers.delete(socket))
    })
    const port = await listen(frontend)
    const server = `https://127.0.0.1:${port}`
    gateway = createGateway({
      access: new StfAccess({stfUrl: `http://127.0.0.1:${apiPort}`,
        providers: {'fixture-provider': {host: '127.0.0.1', adbPorts: [backendPort]}}})
    , publicUrl: server, pollMs: 25
    })
    t.after(async () => {
      await gateway!.close()
      frontend.closeAllConnections()
      await new Promise<void>(resolve => frontend.close(() => resolve()))
    })

    let local: net.Socket | undefined
    const received: Buffer[] = []
    const calls: string[][] = []
    const tunnel = await connectTunnel({
      server, serial: 'ANDROID-FIXTURE', token, caFile: join(directory, 'cert.pem')
    , runAdb: async args => {
        calls.push(args)
        if (args[4] === 'connect') {
          local = net.createConnection({host: '127.0.0.1', port: Number(args[5]!.split(':')[1])})
          peers.add(local)
          local.on('error', () => {})
          local.on('data', (data: Buffer) => received.push(data))
          await once(local, 'connect')
          local.write(packet('CNXN', 0x01000000, 65535, 'host::features=\0'))
        }
      }
    })
    t.after(() => tunnel.close())
    const lost = assert.rejects(tunnel.closed, /ended|closed|lost|disconnected|interrupted/i)
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'ADB fixture timed out')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    await waitFor(() => Buffer.concat(received).includes(Buffer.from('device::')))
    local!.write(packet('OPEN', 1, 0, 'shell:echo verified-tunnel\0'))
    await waitFor(() => Buffer.concat(received).includes(Buffer.from('verified-tunnel\n')))
    assert.deepEqual(backendPackets, ['CNXN', 'OPEN'])
    assert.equal(state.started, true)
    assert.ok(state.apiChecks >= 7)
    state.owned = false
    await lost
    assert.ok(calls.some(args => args[4] === 'disconnect' && args[5] === tunnel.endpoint))
  })
