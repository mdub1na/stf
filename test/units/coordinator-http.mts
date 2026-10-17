import assert from 'node:assert/strict'
import http from 'node:http'
import {once} from 'node:events'
import {Coordinator} from '../../lib/units/coordinator/engine.js'
import {HttpFarmBackend} from '../../lib/units/coordinator/backend.js'
import {createCoordinatorApp} from '../../lib/units/coordinator/http.js'
import type {StateStore} from '../../lib/units/coordinator/state.js'
import type {CoordinatorOptions, CoordinatorState, FarmDevice, GridStatus} from
  '../../lib/units/coordinator/types.js'

const apiToken = 'coordinator-test-token-'.repeat(2)
const stfToken = 'stf-private-test-token-'.repeat(2)
const bearer = 'Bearer ' + apiToken
const basic = 'Basic ' + Buffer.from('coordinator:' + apiToken).toString('base64')
const owner = 'coordinator@example.test'
interface UpstreamCall {
  method: string
  route: string
  body: any
  headers: http.IncomingHttpHeaders
}

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + (server.address() as {port: number}).port
}

async function jsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
}

class MemoryStore implements StateStore {
  state: CoordinatorState = {version: 1, requests: [], leases: []}
  fail = false
  async load() {
 return structuredClone(this.state)
}
  async save(state: CoordinatorState) {
    if (this.fail) {
      throw new Error('private filesystem error ' + stfToken)
    }
    this.state = structuredClone(state)
  }
}

describe('coordinator HTTP and real upstream adapters', function() {
  const servers: http.Server[] = []
  afterEach(function() {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      server.close()
    }
  })

  async function fixture(start = true) {
    let time = Date.parse('2026-10-18T00:00:00Z')
    const store = new MemoryStore()
    const devices: FarmDevice[] = ['phone-a', 'phone-b'].map(serial => ({
      serial, model: 'Test phone', version: '15', platform: 'Android', provider: 'android-pool'
      , present: true, ready: true, owner: null, usage: null, automationLeaseId: null
    }))
    const grid: GridStatus = {ready: true, nodes: devices.map((_, index) => ({
      id: 'node-' + index, availability: 'UP', slots: [{session: null, stereotype: {
        platformName: 'Android', 'appium:remoteAdbHost': 'adb.test'
      }}]
    }))}
    const stfCalls: UpstreamCall[] = []
    const gridCalls: typeof stfCalls = []
    let nextSession = 0
    let inventoryFails = false
    const reply = (res: http.ServerResponse, value: unknown, status = 200) => {
      res.writeHead(status, {'Content-Type': 'application/json'})
      res.end(JSON.stringify(value))
    }
    const stf = http.createServer(async(req, res) => {
      const route = req.url!
      const body = await jsonBody(req)
      stfCalls.push({method: req.method!, route, body, headers: req.headers})
      if (req.headers.authorization !== 'Bearer ' + stfToken) {
        return reply(res, {success: false}, 401)
      }
      if (route === '/api/v1/user') {
        return reply(res, {success: true, user: {email: owner}})
      }
      if (route === '/api/v1/devices') {
        return reply(res, inventoryFails ? {error: 'private upstream failure ' + stfToken} :
          {success: true, devices: devices.map(device => ({...device
            , provider: {name: device.provider}}))}, inventoryFails ? 502 : 200)
      }
      if (route === '/api/v1/user/devices' && req.method === 'POST') {
        const device = devices.find(item => item.serial === body.serial)!
        device.owner = {email: owner}
        device.usage = 'automation'
        device.automationLeaseId = body.leaseId
        return reply(res, {success: true})
      }
      const operation =
        /^\/api\/v1\/user\/devices\/([^/]+)\/automation\/(renew|release)$/.exec(route)
      if (operation) {
        const device = devices.find(item => item.serial === decodeURIComponent(operation[1]!))!
        if (!device.owner || device.automationLeaseId !== body.leaseId) {
          return reply(res, {success: false}, 409)
        }
        if (operation[2] === 'release') {
          device.owner = null
          device.usage = null
          device.automationLeaseId = null
        }
        return reply(res, {success: true})
      }
      return reply(res, {success: false}, 404)
    })
    const appium = http.createServer(async(req, res) => {
      const route = req.url!
      const body = await jsonBody(req)
      gridCalls.push({method: req.method!, route, body, headers: req.headers})
      if (route === '/status') {
        return reply(res, {value: grid})
      }
      if (route === '/session' && req.method === 'POST') {
        const slot = grid.nodes.flatMap(node => node.slots).find(item => !item.session)!
        const sessionId = 'session-' + (++nextSession)
        slot.session = {sessionId, capabilities: body.capabilities.alwaysMatch}
        return reply(res, {value: {sessionId, capabilities: slot.session.capabilities}})
      }
      const session = /^\/session\/([^/]+)(\/.*)?$/.exec(route)
      const slot = grid.nodes.flatMap(node => node.slots)
        .find(item => item.session?.sessionId === session?.[1])
      if (!slot) {
        return reply(res, {value: {error: 'invalid session id', message: 'Unknown session'}}, 404)
      }
      if (req.method === 'DELETE' && !session![2]) {
        slot.session = null
        return reply(res, {value: null})
      }
      return reply(res, {value: session![2] === '/source' ? '<App/>' : null})
    })
    servers.push(stf, appium)
    const stfUrl = await listen(stf)
    const gridUrl = await listen(appium)
    const options: CoordinatorOptions = {
      host: '127.0.0.1', port: 8080, publicUrl: 'http://127.0.0.1:8080'
      , stfApiUrl: stfUrl, appiumGridUrl: gridUrl, stfTokenFile: '/unused/stf'
      , apiTokenFile: '/unused/api', stateFile: '/unused/state', adbPoolsFile: '/unused/pools'
      , leaseTtlSeconds: 180, heartbeatIntervalSeconds: 30, pollIntervalSeconds: 1
      , maxDurationSeconds: 21600, maxParallel: 2, upstreamTimeoutSeconds: 1
    }
    const backend = new HttpFarmBackend(stfUrl, gridUrl, stfToken, 1000)
    const engine = new Coordinator(options, [{provider: 'android-pool', host: 'adb.test'
      , port: 5037, systemPorts: [8200, 8201]}], backend, store, () => time)
    if (start) {
      await engine.start()
    }
    const app = http.createServer(createCoordinatorApp(engine, apiToken))
    servers.push(app)
    const url = await listen(app)
    options.publicUrl = url
    const call = async(route: string, method = 'GET', body?: unknown,
      auth: string | null = bearer, headers: Record<string, string> = {}) => {
      const response = await fetch(url + route, {method, redirect: 'error'
        , headers: {'Content-Type': 'application/json', ...(auth ? {Authorization: auth} : {})
          , ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})})
      return {status: response.status, headers: response.headers
      , body: await response.json() as any}
    }
    const allocate = async(key = 'run-a') => {
      const response = await call('/api/v1/requests', 'POST', {runId: key, platform: 'Android'},
        bearer, {'Idempotency-Key': key})
      assert.equal(response.status, 202)
      await engine.tick()
      const request = await call('/api/v1/requests/' + response.body.request.id)
      assert.equal(request.body.request.state, 'allocated')
      const lease = await call('/api/v1/leases/' + request.body.request.leaseId)
      return lease.body.lease
    }
    return {engine, backend, store, devices, grid, stfCalls, gridCalls, url, call, allocate
      , advance(milliseconds: number) {
 time += milliseconds
}
      , failInventory() {
 inventoryFails = true
}}
  }

  it('exposes readiness before recovery and refuses allocation before startup', async function() {
    const f = await fixture(false)
    assert.deepEqual((await f.call('/healthz', 'GET', undefined, null)).body, {healthy: true})
    assert.equal((await f.call('/readyz', 'GET', undefined, null)).status, 503)
    const response = await f.call('/api/v1/requests', 'POST', {runId: 'early', platform: 'Android'},
      bearer, {'Idempotency-Key': 'early'})
    assert.equal(response.status, 503)
    assert.equal(f.stfCalls.length, 0)
    await f.engine.start()
    assert.equal((await f.call('/readyz', 'GET', undefined, null)).status, 200)
  })

  it('accepts Bearer and Basic authentication and rejects wrong tokens', async function() {
    const f = await fixture()
    for (const token of [bearer, basic]) {
      const result = await f.call('/api/v1/status', 'GET', undefined, token)
      assert.equal(result.status, 200)
      assert.equal(result.headers.get('cache-control'), 'no-store')
    }
    for (const token of [null, 'Bearer wrong', 'Basic ' +
      Buffer.from('other:' + apiToken).toString('base64')]) {
      const result = await f.call('/api/v1/status', 'GET', undefined, token)
      assert.equal(result.status, 401)
      assert.match(result.headers.get('www-authenticate')!, /Basic/)
      assert.doesNotMatch(JSON.stringify(result.body), new RegExp(apiToken))
    }
  })

  it('validates allocation input and enforces HTTP idempotency before dispatch', async function() {
    const f = await fixture()
    const body = {runId: 'run-a', platform: 'Android'}
    assert.equal((await f.call('/api/v1/requests', 'POST', body)).status, 400)
    for (const invalid of [[], {...body, extra: true}, {...body, platform: 'Windows'}
      , {...body, runId: ''}, {...body, queueTimeoutSeconds: 0}
      , {...body, maxDurationSeconds: 21601}]) {
      assert.equal((await f.call('/api/v1/requests', 'POST', invalid, bearer,
        {'Idempotency-Key': 'invalid'})).status, 400)
    }
    const first = await f.call('/api/v1/requests', 'POST', body, bearer,
      {'Idempotency-Key': 'same'})
    const again = await f.call('/api/v1/requests', 'POST', body, bearer,
      {'Idempotency-Key': 'same'})
    assert.equal(first.body.request.id, again.body.request.id)
    assert.equal((await f.call('/api/v1/requests', 'POST', {...body, runId: 'other'}, bearer,
      {'Idempotency-Key': 'same'})).status, 409)
    assert.equal(f.stfCalls.filter(item => item.method === 'POST').length, 0)
  })

  it('runs W3C sessions, heartbeat and fenced cleanup over HTTP', async function() {
    const f = await fixture()
    const lease = await f.allocate()
    const gateway = '/api/v1/leases/' + lease.id + '/webdriver'
    const created = await f.call(gateway + '/session', 'POST', {capabilities: {
      alwaysMatch: {'appium:appPackage': 'test.package'}, firstMatch: [{}]
    }}, basic, {Cookie: 'private-cookie=secret', 'Idempotency-Key': 'private-idempotency'})
    assert.equal(created.status, 200)
    const session = created.body.value.sessionId
    assert.equal((await f.call(gateway + '/session/' + session + '/source')).body.value, '<App/>')
    const posted = f.gridCalls.find(item => item.route === '/session')!.body
    assert.equal(posted.capabilities.alwaysMatch['appium:udid'], lease.device.serial)
    assert.equal(posted.capabilities.alwaysMatch['appium:systemPort'], 8200)
    assert.equal(posted.capabilities.alwaysMatch['stf:leaseId'], lease.id)
    f.advance(60000)
    const renewed = await f.call('/api/v1/leases/' + lease.id + '/renew', 'POST', {})
    assert.equal(renewed.status, 200)
    assert.ok(Date.parse(renewed.body.lease.expiresAt) > Date.parse(lease.expiresAt))
    assert.equal((await f.call(gateway + '/session/' + session, 'DELETE')).status, 200)
    assert.equal((await f.call('/api/v1/leases/' + lease.id, 'DELETE')).status, 202)
    await f.engine.tick()
    assert.equal((await f.call('/api/v1/leases/' + lease.id)).body.lease.state, 'released')
    assert.equal(f.devices[0]!.owner, null)
    assert.ok(f.stfCalls.some(item => item.route.endsWith('/automation/release') &&
      item.body.leaseId === lease.id))
    for (const call of f.gridCalls) {
      assert.equal(call.headers.authorization, undefined)
      assert.equal(call.headers.cookie, undefined)
      assert.equal(call.headers['idempotency-key'], undefined)
      assert.doesNotMatch(JSON.stringify(call), new RegExp(apiToken + '|' + stfToken))
    }
    assert.ok(f.stfCalls.every(call => call.headers.authorization === 'Bearer ' + stfToken))
  })

  it('rejects nested and firstMatch connection overrides before contacting Grid', async function() {
    const f = await fixture()
    const lease = await f.allocate()
    const route = '/api/v1/leases/' + lease.id + '/webdriver/session'
    for (const supplied of [
      {alwaysMatch: {'appium:options': {udid: 'foreign'}}}
      , {firstMatch: [{'appium:systemPort': 8999}]}
      , {alwaysMatch: {'appium:udid': 'foreign'}, firstMatch: [{}]}
    ]) {
      const response = await f.call(route, 'POST', {capabilities: supplied})
      assert.ok([400, 409].includes(response.status))
      assert.equal(response.body.value.stacktrace, '')
    }
    assert.equal(f.gridCalls.filter(call => call.route === '/session').length, 0)
  })

  it('rejects malformed W3C arrays rather than silently rewriting them', async function() {
    const f = await fixture()
    const lease = await f.allocate()
    const route = '/api/v1/leases/' + lease.id + '/webdriver/session'
    for (const capabilities of [[], {alwaysMatch: []}, {firstMatch: []}, {firstMatch: [[]]}]) {
      const result = await f.call(route, 'POST', {capabilities})
      assert.equal(result.status, 400, 'Invalid capabilities: ' + JSON.stringify(capabilities))
    }
    assert.equal(f.gridCalls.filter(call => call.route === '/session').length, 0)
  })

  it('prevents a lease from sending commands to another lease session', async function() {
    const f = await fixture()
    const first = await f.allocate('first')
    const second = await f.allocate('second')
    const firstPath = '/api/v1/leases/' + first.id + '/webdriver/session'
    const secondPath = '/api/v1/leases/' + second.id + '/webdriver/session'
    const body = {capabilities: {alwaysMatch: {}, firstMatch: [{}]}}
    const own = await f.call(firstPath, 'POST', body)
    const foreign = await f.call(secondPath, 'POST', body)
    assert.notEqual(own.body.value.sessionId, foreign.body.value.sessionId)
    const count = f.gridCalls.length
    const result = await f.call(firstPath + '/' + foreign.body.value.sessionId + '/source')
    assert.equal(result.status, 404)
    assert.equal(result.body.value.error, 'invalid session id')
    assert.equal(f.gridCalls.length, count)
  })

  it('rejects encoded traversal and queries before forwarding', async function() {
    const f = await fixture()
    const lease = await f.allocate()
    const prefix = '/api/v1/leases/' + lease.id + '/webdriver'
    const before = f.gridCalls.length
    for (const route of ['/session/%2e%2e/status', '/session/a%2fb/source'
      , '/session/a%5cb/source', '/session/a%00/source', '/session/%E0%A4%A/source'
      , '/session/a/source?forwarded=true']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(f.url + '/', {method: 'GET', path: prefix + route
          , headers: {Authorization: bearer}}, res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode!))
        })
        req.on('error', reject)
        req.end()
      })
      assert.ok(status >= 400 && status < 500, route + ' returned ' + status)
    }
    assert.equal(f.gridCalls.length, before)
  })

  it('GET polling never renews worker ownership', async function() {
    const f = await fixture()
    const lease = await f.allocate()
    const renews = f.stfCalls.filter(call => call.route.endsWith('/automation/renew')).length
    f.advance(60000)
    for (const route of ['/api/v1/status', '/api/v1/leases', '/api/v1/leases/' + lease.id
      , '/api/v1/requests/' + lease.requestId]) {
      assert.equal((await f.call(route)).status, 200)
    }
    const current = (await f.call('/api/v1/leases/' + lease.id)).body.lease
    assert.equal(current.expiresAt, lease.expiresAt)
    assert.equal(f.stfCalls.filter(call => call.route.endsWith('/automation/renew')).length, renews)
    assert.equal((await f.call('/api/v1/leases/' + lease.id + '/renew')).status, 404)
  })

  it('redacts storage and upstream errors from HTTP responses and status', async function() {
    const f = await fixture()
    f.failInventory()
    await f.call('/api/v1/requests', 'POST', {runId: 'queued', platform: 'Android'}, bearer,
      {'Idempotency-Key': 'queued'})
    await f.engine.tick()
    const status = await f.call('/api/v1/status')
    assert.equal(status.body.lastError, 'Farm inventory is temporarily unavailable')
    f.store.fail = true
    const failed = await f.call('/api/v1/requests', 'POST', {runId: 'fail', platform: 'Android'},
      bearer, {'Idempotency-Key': 'fail'})
    assert.equal(failed.status, 503)
    assert.doesNotMatch(JSON.stringify([status.body, failed.body]),
      new RegExp(stfToken + '|' + apiToken + '|private filesystem|stack'))
  })
})
