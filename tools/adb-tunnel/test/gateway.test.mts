import assert from 'node:assert/strict'
import {once} from 'node:events'
import net from 'node:net'
import {test, type TestContext} from 'node:test'
import {WebSocket} from 'ws'
import {createGateway} from '../gateway.mts'
import {HttpError, type Access, type Target} from '../types.mts'

interface IssuedSession {
  id: string
  serial: string
  websocketUrl: string
  ticket: string
  controlToken: string
  expiresAt: string
  sessionExpiresAt: string
}

function adbPacket(command: string, data = '', arg0 = 0, arg1 = 0) {
  const payload = Buffer.from(data)
  const header = Buffer.alloc(24)
  const code = Buffer.from(command).readUInt32LE()
  header.writeUInt32LE(code, 0)
  header.writeUInt32LE(arg0, 4)
  header.writeUInt32LE(arg1, 8)
  header.writeUInt32LE(payload.length, 12)
  header.writeUInt32LE(payload.reduce((sum, value) => sum + value, 0), 16)
  header.writeUInt32LE((~code) >>> 0, 20)
  return Buffer.concat([header, payload])
}

async function fixture(t: TestContext, overrides: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const targetSockets = new Set<net.Socket>()
  const received: Buffer[] = []
  let connections = 0
  const echo = net.createServer(socket => {
    connections++
    targetSockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => targetSockets.delete(socket))
    socket.on('data', chunk => received.push(Buffer.from(chunk)))
    socket.pipe(socket)
  })
  echo.listen(0, '127.0.0.1')
  await once(echo, 'listening')
  const target: Target = {
    serial: 'phone-1', email: 'developer@example.test', host: '127.0.0.1',
    port: (echo.address() as net.AddressInfo).port, provider: 'test-provider', binding: 'lease-1'
  }
  let valid = true
  let checks = 0
  const access: Access = {
    async open(token, serial) {
      if (token !== 'stf-user-token') throw new HttpError(401, 'Invalid STF token')
      if (serial !== target.serial) throw new HttpError(403, 'Device is not owned by you')
      return {...target}
    },
    async check(token, binding) {
      checks++
      if (!valid || token !== 'stf-user-token' || binding.binding !== target.binding) {
        throw new HttpError(403, 'Device lease has ended')
      }
    }
  }
  const gateway = createGateway({access, publicUrl: 'http://127.0.0.1', pollMs: 20, ...overrides})
  gateway.server.listen(0, '127.0.0.1')
  await once(gateway.server, 'listening')
  const base = `http://127.0.0.1:${(gateway.server.address() as net.AddressInfo).port}`
  t.after(async () => {
    await gateway.close()
    for (const socket of targetSockets) socket.destroy()
    await new Promise<void>((resolve, reject) => echo.close(error => error ? reject(error) : resolve()))
  })
  return {
    access, target, base, gateway,
    get connections() { return connections },
    get checks() { return checks },
    get received() { return Buffer.concat(received) },
    disconnectTarget() { for (const socket of targetSockets) socket.destroy() },
    revoke() { valid = false },
    async request(body: unknown = {serial: target.serial}, token = 'stf-user-token', headers: Record<string, string> = {}) {
      return fetch(`${base}/adb-tunnel/v1/sessions`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers},
        body: JSON.stringify(body)
      })
    },
    async issue() {
      const response = await this.request()
      assert.equal(response.status, 201)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return await response.json() as IssuedSession
    },
    connect(session: IssuedSession, credential = session.ticket, origin?: string) {
      const path = new URL(session.websocketUrl).pathname
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, {
        headers: {Authorization: `Bearer ${credential}`}, origin, handshakeTimeout: 1500
      })
      ws.on('error', () => {})
      return once(ws, 'open').then(() => ws)
    },
    async remove(session: IssuedSession, credential = session.controlToken) {
      return fetch(`${base}/adb-tunnel/v1/sessions/${session.id}`, {
        method: 'DELETE', headers: {Authorization: `Bearer ${credential}`}
      })
    }
  }
}

test('native HTTP/WS flow forwards binary ADB through the server-resolved target', async t => {
  const f = await fixture(t)
  const health = await fetch(`${f.base}/healthz`)
  assert.equal(health.status, 200)
  const session = await f.issue()
  assert.notEqual(session.ticket, session.controlToken)
  assert.ok(!session.websocketUrl.includes(session.ticket))
  assert.ok(!session.websocketUrl.includes('stf-user-token'))
  const ws = await f.connect(session)
  const payload = adbPacket('CNXN', 'host::\0', 0x01000001, 1024 * 1024)
  const message = once(ws, 'message')
  ws.send(payload)
  const [response, binary] = await message
  assert.deepEqual(response, payload)
  assert.equal(binary, true)
  assert.equal(f.connections, 1)
  const closed = once(ws, 'close')
  assert.equal((await f.remove(session)).status, 200)
  await closed
})

test('requires STF authorization and rejects foreign browser origins', async t => {
  const f = await fixture(t)
  assert.equal((await f.request(undefined, 'invalid')).status, 401)
  assert.equal((await f.request({serial: 'other-phone'})).status, 403)
  assert.equal((await f.request(undefined, 'stf-user-token', {Origin: 'https://foreign.example'})).status, 403)
  const session = await f.issue()
  await assert.rejects(f.connect(session, session.ticket, 'https://foreign.example'), /403/)
  assert.equal(f.connections, 0)
  const ws = await f.connect(session)
  ws.terminate()
})

test('tickets and control credentials have distinct permissions', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  assert.equal((await f.remove(session, session.ticket)).status, 404)
  await assert.rejects(f.connect(session, session.controlToken), /401/)
  const ws = await f.connect(session)
  await assert.rejects(f.connect(session), /401/)
  assert.equal(ws.readyState, WebSocket.OPEN)
  ws.terminate()
})

test('claims one-use tickets before asynchronous authorization and preserves the winning stream', async t => {
  const f = await fixture(t)
  let release!: () => void
  let entered!: () => void
  const checkEntered = new Promise<void>(resolve => { entered = resolve })
  f.access.check = async () => {
    entered()
    await new Promise<void>(resolve => { release = resolve })
  }
  const session = await f.issue()
  const first = f.connect(session)
  await checkEntered
  await assert.rejects(f.connect(session), /401/)
  release()
  const winner = await first
  assert.equal(f.connections, 1)
  assert.equal(winner.readyState, WebSocket.OPEN)
  winner.terminate()
})

test('rechecks ownership before opening TCP and consumes a rejected ticket', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  f.revoke()
  await assert.rejects(f.connect(session), /403/)
  assert.equal(f.connections, 0)
  await assert.rejects(f.connect(session), /401/)
})

test('revokes an active stream when the STF lease or token becomes invalid', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  const ws = await f.connect(session)
  const closed = once(ws, 'close')
  f.revoke()
  await closed
  assert.ok(f.checks >= 2)
  await assert.rejects(f.connect(session), /401/)
})

test('connection tickets expire and pending sessions release capacity', async t => {
  const f = await fixture(t, {ticketTtlMs: 40, maxSessions: 1})
  const session = await f.issue()
  assert.equal((await f.request()).status, 503)
  await new Promise(resolve => setTimeout(resolve, 70))
  await assert.rejects(f.connect(session), /401/)
  assert.equal((await f.request()).status, 201)
})

test('enforces hard session lifetime and refuses reconnecting a dead session', async t => {
  const f = await fixture(t, {sessionTtlMs: 100})
  const session = await f.issue()
  const ws = await f.connect(session)
  await once(ws, 'close')
  await assert.rejects(f.connect(session), /401/)
})

test('fails closed when an active authorization check hangs', {timeout: 8000}, async t => {
  const f = await fixture(t)
  const session = await f.issue()
  const ws = await f.connect(session)
  f.access.check = () => new Promise(() => {})
  await once(ws, 'close')
  assert.equal((await f.remove(session)).status, 404)
})

test('bounds request bodies and accepts only binary stream messages', async t => {
  const f = await fixture(t)
  assert.equal((await f.request({serial: 'phone-1', extra: 'x'.repeat(9000)})).status, 413)
  const session = await f.issue()
  const ws = await f.connect(session)
  const closed = once(ws, 'close')
  ws.send('not an ADB packet')
  await closed
})

test('TCP disconnect ends the session without allowing reuse of the ticket', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  const ws = await f.connect(session)
  const closed = once(ws, 'close')
  f.disconnectTarget()
  await closed
  await assert.rejects(f.connect(session), /401/)
})

test('DELETE cancels a claimed ticket while its authorization check is still pending', async t => {
  const f = await fixture(t)
  let release!: () => void
  let entered!: () => void
  const checkEntered = new Promise<void>(resolve => { entered = resolve })
  f.access.check = async () => {
    entered()
    await new Promise<void>(resolve => { release = resolve })
  }
  const session = await f.issue()
  const refused = assert.rejects(f.connect(session))
  await checkEntered
  assert.equal((await f.remove(session)).status, 200)
  await refused
  release()
  assert.equal(f.connections, 0)
})

test('blocks a forbidden ADB service before any of its bytes reach the farm', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  const ws = await f.connect(session)
  const closed = once(ws, 'close')
  ws.send(adbPacket('OPEN', 'host:devices\0', 1))
  await closed
  assert.equal(f.received.length, 0)
})

test('bounds individual WebSocket messages', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  const ws = await f.connect(session)
  const closed = once(ws, 'close')
  ws.send(Buffer.alloc(2 * 1024 * 1024))
  await closed
  assert.equal(f.received.length, 0)
})

test('gateway shutdown closes active clients', async t => {
  const f = await fixture(t)
  const session = await f.issue()
  const ws = await f.connect(session)
  const closed = once(ws, 'close')
  await f.gateway.close()
  await closed
})
