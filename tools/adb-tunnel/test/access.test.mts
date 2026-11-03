import assert from 'node:assert/strict'
import http from 'node:http'
import {test} from 'node:test'
import type {TestContext} from 'node:test'

import {StfAccess} from '../access.mts'
import {HttpError, originUrl} from '../types.mts'

async function fixture(t: TestContext) {
  const state = {
    email: 'developer@example.test', token: 'private-stf-token', status: 200, redirect: false
  , publishAfterMs: 0, pauseProfile: false
  , started: false, address: 'public.example.test:12011', requests: [] as string[]
  , device: {
      serial: 'PHONE-123', platform: 'Android', present: true, ready: true, remoteConnect: true
    , owner: {email: 'developer@example.test', group: 'user-channel'}
    , provider: {name: 'provider-1', channel: 'provider-channel'}, channel: 'device-channel'
    , remoteConnectUrl: 'public.example.test:12011'
    }
  }
  const server = http.createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`)
    if (state.redirect) {
      response.writeHead(302, {Location: 'https://untrusted.example.test'})
      response.end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (request.headers.authorization !== `Bearer ${state.token}` || state.status !== 200) {
      response.writeHead(state.status === 200 ? 401 : state.status)
      response.end(JSON.stringify({success: false, description: state.token}))
      return
    }
    let data: object
    if (request.url === '/api/v1/user') {
      if (state.pauseProfile) return
      data = {user: {email: state.email, privilege: 'admin'}}
    }
    else if (request.url === '/api/v1/user/devices/PHONE-123' && request.method === 'GET') {
      data = {device: state.device}
    }
    else if (request.url === '/api/v1/user/devices/PHONE-123/remoteConnect' && request.method === 'POST') {
      state.started = true
      if (state.publishAfterMs) {
        setTimeout(() => { state.device.remoteConnect = true }, state.publishAfterMs)
      }
      data = {remoteConnectUrl: state.address}
    }
    else {
      response.writeHead(404)
      response.end(JSON.stringify({success: false}))
      return
    }
    response.end(JSON.stringify({success: true, ...data}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const port = (server.address() as import('node:net').AddressInfo).port
  const options = {
    stfUrl: `http://127.0.0.1:${port}`
  , providers: {'provider-1': {host: 'provider.internal', adbPorts: [12011, 12015]}}
  }
  return {state, options, access: new StfAccess(options)}
}

test('maps the owned device to a configured internal provider and revalidates its binding', async t => {
  const {state, access} = await fixture(t)
  const target = await access.open(state.token, 'PHONE-123')
  assert.equal(state.started, true)
  assert.equal(target.host, 'provider.internal')
  assert.equal(target.port, 12011)
  assert.equal(target.serial, 'PHONE-123')
  await access.check(state.token, target)
  state.device.channel = 'replacement-worker'
  await assert.rejects(access.check(state.token, target), /session changed/)
})

test('rejects administrators accessing someone else\'s device, unavailable devices and iOS', async t => {
  const {state, access} = await fixture(t)
  state.device.owner.email = 'someone-else@example.test'
  await assert.rejects(access.open(state.token, 'PHONE-123'), /your own STF account/)
  assert.equal(state.started, false)
  state.device.owner.email = state.email
  state.device.ready = false
  await assert.rejects(access.open(state.token, 'PHONE-123'), /ready Android device/)
  state.device.ready = true
  state.device.platform = 'iOS'
  await assert.rejects(access.open(state.token, 'PHONE-123'), /Android device/)
})

test('never follows an API-supplied hostname or unconfigured remote port', async t => {
  const {state, access} = await fixture(t)
  state.address = 'unexpected.external.test:5037'
  await assert.rejects(access.open(state.token, 'PHONE-123'), /configured provider routes/)
  state.address = 'http://internal:12011/path'
  await assert.rejects(access.open(state.token, 'PHONE-123'), /invalid Remote ADB address/)
  state.address = 'unexpected.external.test:12011'
  state.device.remoteConnectUrl = state.address
  const target = await access.open(state.token, 'PHONE-123')
  assert.equal(target.host, 'provider.internal')
})

test('rejects a provider before starting Remote ADB, and closes on token revocation or stop', async t => {
  const {state, access} = await fixture(t)
  state.device.provider.name = 'unconfigured'
  await assert.rejects(access.open(state.token, 'PHONE-123'), /not configured/)
  assert.equal(state.started, false)
  state.device.provider.name = 'provider-1'
  const target = await access.open(state.token, 'PHONE-123')
  state.device.remoteConnect = false
  await assert.rejects(access.check(state.token, target), /stopped in STF/)
  state.device.remoteConnect = true
  state.status = 401
  await assert.rejects(access.check(state.token, target), error =>
    error instanceof HttpError && error.status === 401 && !error.message.includes(state.token))
})

test('rejects redirects, invalid credentials and invalid serials without leaking upstream text', async t => {
  const {state, access} = await fixture(t)
  await assert.rejects(access.open('wrong-token', 'PHONE-123'), /token was rejected/)
  await assert.rejects(access.open('bad\nheader', 'PHONE-123'), /valid STF access token/)
  state.redirect = true
  await assert.rejects(access.open(state.token, 'PHONE-123'), /unavailable/)
  const previous = state.requests.length
  await assert.rejects(access.open(state.token, '../user'), /valid Android device serial/)
  assert.equal(state.requests.length, previous)
})

test('configuration requires HTTPS away from loopback and excludes the shared ADB server', () => {
  for (const url of ['http://stf.example.test', 'https://user:password@stf.example.test',
    'https://stf.example.test/prefix', 'https://stf.example.test/?token=secret']) {
    assert.throws(() => originUrl(url, 'server'))
  }
  assert.equal(originUrl('https://stf.example.test', 'server').origin, 'https://stf.example.test')
  assert.throws(() => new StfAccess({
    stfUrl: 'https://stf.example.test', providers: {provider: {host: 'internal', adbPorts: [5037]}}
  }), /not 5037/)
})

test('waits briefly for STF to publish a newly started bridge without ignoring ownership checks', async t => {
  const {state, access} = await fixture(t)
  state.device.remoteConnect = false
  state.publishAfterMs = 25
  const target = await access.open(state.token, 'PHONE-123')
  assert.equal(target.port, 12011)
  assert.equal(state.device.remoteConnect, true)
})

test('cancels an authorization deadline before making later STF mutations', async t => {
  const {state, access} = await fixture(t)
  state.pauseProfile = true
  const controller = new AbortController()
  const operation = access.open(state.token, 'PHONE-123', controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(operation, /STF API request failed/)
  assert.equal(state.started, false)
  assert.deepEqual(state.requests, ['GET /api/v1/user'])
})
