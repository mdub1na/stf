import assert from 'node:assert/strict'
import {once} from 'node:events'
import net from 'node:net'
import http from 'node:http'
import {test} from 'node:test'
import {CoordinatorClient, parseLease} from '../coordinator.mts'
import {appiumProxy, maestroProxy} from '../transports.mts'
import {directory, farm, token} from './helpers.mts'

async function echo(port: number, payload: Buffer): Promise<Buffer> {
  const socket = net.connect(port, '127.0.0.1')
  const chunks: Buffer[] = []
  let size = 0
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('echo timeout')) }, 3000)
    socket.once('connect', () => {
      socket.write(payload.subarray(0, 5))
      socket.write(payload.subarray(5))
    })
    socket.on('data', data => {
      const chunk = Buffer.from(data)
      chunks.push(chunk); size += chunk.length
      if (size >= payload.length) {
        clearTimeout(timeout); socket.destroy(); resolve(Buffer.concat(chunks))
      }
    })
    socket.once('error', error => { clearTimeout(timeout); reject(error) })
  })
}

test('Maestro smart socket forwards binary traffic through a separate authenticated WS per TCP client', async() => {
  const temp = await directory(); const api = await farm({runner: 'maestro'})
  const client = await CoordinatorClient.create({url: api.url, tokenFile: temp.tokenFile})
  const proxy = await maestroProxy(client, parseLease(api.lease(), 'maestro'), 0)
  try {
    const port = Number(new URL(proxy.url!).port)
    const first = Buffer.from('0012host:transport:PHONE\x00\xff', 'latin1')
    const second = Buffer.alloc(65536, 0xa3)
    const results = await Promise.all([echo(port, first), echo(port, second)])
    assert.deepEqual(results, [first, second])
    const upgrades = api.events.filter(e => e.method === 'UPGRADE')
    assert.equal(upgrades.length, 2)
    assert.ok(upgrades.every(e => e.path === '/api/v1/leases/lease-1/adb' && e.auth === `Bearer ${token}`))
  }
  finally { await proxy.close(); await api.close(); await temp.close() }
})

test('Maestro refuses an occupied port and leaves the existing listener running', async() => {
  const temp = await directory(); const api = await farm({runner: 'maestro'})
  const guard = net.createServer(socket => socket.end('untouched'))
  guard.listen(0, '127.0.0.1'); await once(guard, 'listening')
  const address = guard.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const client = await CoordinatorClient.create({url: api.url, tokenFile: temp.tokenFile})
    await assert.rejects(maestroProxy(client, parseLease(api.lease(), 'maestro'), address.port), /occupied.*left untouched/)
    assert.equal(guard.listening, true)
    assert.equal(api.events.length, 0)
  }
  finally {
    await new Promise<void>(resolve => guard.close(() => resolve()))
    await api.close(); await temp.close()
  }
})

test('Appium proxy overwrites incoming credentials and rejects escaped routes before forwarding', async() => {
  const temp = await directory(); const api = await farm()
  const client = await CoordinatorClient.create({url: api.url + '/api/v1', tokenFile: temp.tokenFile})
  const proxy = await appiumProxy(client, parseLease(api.lease(), 'appium'))
  try {
    const response = await fetch(proxy.url + '/session/session-1/title', {headers: {Authorization: 'Bearer client-secret'}})
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {value: 'through-proxy'})
    const port = Number(new URL(proxy.url!).port)
    for (const path of ['/status', '/session/a?token=secret', '/session/%252e%252e', '/session/a%2fb']) {
      const status = await new Promise<number>(resolve => {
        http.get({host: '127.0.0.1', port, path}, result => { result.resume(); resolve(result.statusCode!) })
      })
      assert.equal(status, 404)
    }
    assert.equal(api.events.length, 1)
    assert.equal(api.events[0]!.auth, `Bearer ${token}`)
  }
  finally { await proxy.close(); await api.close(); await temp.close() }
})

test('coordinator API refuses redirects rather than forwarding credentials', async() => {
  const temp = await directory()
  let destinationCalls = 0
  const destination = http.createServer((_req, res) => { destinationCalls++; res.end('{}') })
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening')
  const address = destination.address()
  assert.ok(address && typeof address !== 'string')
  const redirect = http.createServer((_req, res) => {
    res.writeHead(307, {Location: `http://127.0.0.1:${address.port}/steal`}).end()
  })
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening')
  const origin = redirect.address()
  assert.ok(origin && typeof origin !== 'string')
  try {
    const client = await CoordinatorClient.create({url: `http://127.0.0.1:${origin.port}`, tokenFile: temp.tokenFile})
    await assert.rejects(client.request('GET', '/status'), /HTTP 307/)
    assert.equal(destinationCalls, 0)
  }
  finally {
    await new Promise<void>(resolve => redirect.close(() => resolve()))
    await new Promise<void>(resolve => destination.close(() => resolve()))
    await temp.close()
  }
})
