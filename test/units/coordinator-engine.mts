import assert from 'node:assert/strict'
import {Coordinator} from '../../lib/units/coordinator/engine.js'
import {BackendError} from '../../lib/units/coordinator/backend.js'
import {CoordinatorError} from '../../lib/units/coordinator/config.js'
import type {StateStore} from '../../lib/units/coordinator/state.js'
import type {
  AdbPool, AllocationInput, CoordinatorOptions, CoordinatorState, FarmBackend
, FarmDevice, GridStatus, UpstreamResponse
} from '../../lib/units/coordinator/types.js'

const owner = 'coordinator@example.test'
const initialTime = Date.parse('2026-10-18T10:00:00Z')
const pools: AdbPool[] = [{
  provider: 'provider-one', host: 'adb-one', port: 5037, systemPorts: [8200, 8201]
}]
const options: CoordinatorOptions = {
  host: '127.0.0.1', port: 8080, publicUrl: 'http://127.0.0.1:8080'
, stfApiUrl: 'http://stf.test/api/v1', stfTokenFile: '/private/stf-token'
, apiTokenFile: '/private/api-token', appiumGridUrl: 'http://grid.test'
, stateFile: '/private/coordinator.json', adbPoolsFile: '/private/pools.json'
, leaseTtlSeconds: 10, heartbeatIntervalSeconds: 2, pollIntervalSeconds: 1
, maxDurationSeconds: 60, maxParallel: 10, upstreamTimeoutSeconds: 1
}

const input = (overrides: Partial<AllocationInput> = {}): AllocationInput => ({
  runId: 'settings-demo', platform: 'Android', queueTimeoutSeconds: 60
, maxDurationSeconds: 60, ...overrides
})
const phone = (serial: string, overrides: Partial<FarmDevice> = {}): FarmDevice => ({
  serial, platform: 'Android', model: 'Example phone', version: '15'
, provider: 'provider-one', present: true, ready: true, owner: null
, usage: null, automationLeaseId: null, ...overrides
})
const response = (status: number, value: unknown): UpstreamResponse => ({
  status, contentType: 'application/json', body: Buffer.from(JSON.stringify({value}))
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return {promise, resolve}
}
async function rejectCode(operation: Promise<unknown>, code: string, status: number) {
  await assert.rejects(operation, error => error instanceof CoordinatorError &&
    error.code === code && error.status === status)
}

class MemoryStore implements StateStore {
  state: CoordinatorState = {version: 1, requests: [], leases: []}
  failWrites = false
  saves = 0

  async load() {
    return structuredClone(this.state)
  }

  async save(state: CoordinatorState) {
    if (this.failWrites) {
      throw new Error('Simulated persistent storage failure')
    }
    this.saves++
    this.state = structuredClone(state)
  }
}

class FakeFarm implements FarmBackend {
  inventory = [phone('ANDROID-A'), phone('ANDROID-B'), phone('ANDROID-C')]
  slots: GridStatus = {ready: true, nodes: [0, 1].map(number => ({
    id: 'android-node-' + number, availability: 'UP'
  , slots: [{stereotype: {platformName: 'Android', 'appium:remoteAdbHost': 'adb-one'}
      , session: null}]
  }))}
  events: string[] = []
  webdriverCalls: {method: string, route: string, body?: unknown}[] = []
  captures: {serial: string, leaseId: string, timeout: number}[] = []
  inventoryError = false
  captureError: Error | null = null
  captureBarrier: ReturnType<typeof deferred> | null = null
  captureEntered: ReturnType<typeof deferred> | null = null
  commandBarrier: ReturnType<typeof deferred> | null = null
  commandEntered: ReturnType<typeof deferred> | null = null
  createError = false
  createErrorAfterSession = false
  malformedCreate = false
  createStatus = 200
  deleteStatus = 200
  retainDeletedSession = false
  sessionCounter = 0

  async identity() {
    return {email: owner}
  }

  async devices() {
    if (this.inventoryError) {
      throw new Error('Inventory unavailable')
    }
    return structuredClone(this.inventory)
  }

  async grid() {
    return structuredClone(this.slots)
  }

  async capture(serial: string, leaseId: string, timeout: number) {
    this.events.push('capture:' + serial)
    this.captureEntered?.resolve()
    if (this.captureBarrier) {
      await this.captureBarrier.promise
    }
    if (this.captureError) {
      throw this.captureError
    }
    const device = this.inventory.find(item => item.serial === serial)!
    if (device.owner) {
      throw new BackendError(409, 'capture')
    }
    device.owner = {email: owner}
    device.usage = 'automation'
    device.automationLeaseId = leaseId
    this.captures.push({serial, leaseId, timeout})
  }

  async renew(serial: string, leaseId: string) {
    this.events.push('renew:' + serial)
    const device = this.inventory.find(item => item.serial === serial)!
    if (device.owner?.email !== owner || device.automationLeaseId !== leaseId) {
      throw new BackendError(409, 'renew')
    }
  }

  async release(serial: string, leaseId: string) {
    this.events.push('release:' + serial)
    const device = this.inventory.find(item => item.serial === serial)!
    if (device.owner?.email !== owner || device.automationLeaseId !== leaseId) {
      throw new BackendError(409, 'release')
    }
    device.owner = null
    device.usage = null
    device.automationLeaseId = null
  }

  async webdriver(method: string, route: string, body?: unknown) {
    this.events.push('webdriver:' + method + ':' + route)
    this.webdriverCalls.push({method, route, ...(body ? {body} : {})})
    if (method === 'POST' && route === '/session') {
      if (this.createError) {
        throw new Error('Network failed after upstream may have created a session')
      }
      if (this.malformedCreate) {
        return {status: 200, contentType: 'application/json', body: Buffer.from('invalid-json')}
      }
      if (this.createStatus !== 200) {
        return response(this.createStatus, {error: 'unknown error', message: 'Backend failed'})
      }
      const capabilities = (body as {capabilities: {alwaysMatch: Record<string, unknown>}})
        .capabilities.alwaysMatch
      const slot = this.slots.nodes.flatMap(node => node.slots).find(item => !item.session)!
      const sessionId = 'session-' + (++this.sessionCounter)
      slot.session = {sessionId, capabilities: structuredClone(capabilities)}
      if (this.createErrorAfterSession) {
        throw new Error('Response lost after creating the upstream session')
      }
      return response(200, {sessionId, capabilities})
    }
    if (method === 'DELETE' && route.startsWith('/session/')) {
      if (this.deleteStatus === 200 && !this.retainDeletedSession) {
        const sessionId = decodeURIComponent(route.split('/')[2]!)
        const slot = this.slots.nodes.flatMap(node => node.slots)
          .find(item => item.session?.sessionId === sessionId)
        if (slot) {
          slot.session = null
        }
      }
      return response(this.deleteStatus, null)
    }
    this.commandEntered?.resolve()
    if (this.commandBarrier) {
      await this.commandBarrier.promise
    }
    return response(200, null)
  }
}

async function fixture(settings: Partial<CoordinatorOptions> = {}, farm = new FakeFarm(),
  store = new MemoryStore(), poolConfig = pools) {
  let time = initialTime
  const config = {...options, ...settings}
  const engine = new Coordinator(config, poolConfig, farm, store, () => time)
  await engine.start()
  const allocate = async(overrides: Partial<AllocationInput> = {}, key = 'request-one') => {
    const request = await engine.submit(input(overrides), key)
    await engine.tick()
    const allocated = engine.requestView(request.id)
    assert.ok(allocated.leaseId, 'Expected a granted lease')
    return engine.leaseView(allocated.leaseId)
  }
  const create = async(id: string, capabilities: Record<string, unknown> = {}) => {
    await engine.webdriver(id, 'POST', '/session', {
      capabilities: {alwaysMatch: capabilities, firstMatch: [{}]}
    })
    const lease = engine.leaseView(id)
    assert.ok(lease.sessionId)
    return lease.sessionId
  }
  return {engine, farm, store, config, allocate, create, advance(ms: number) {
    time += ms
  }, now: () => time}
}

describe('coordinator allocation and lifetime', () => {
  it('makes repeated submissions idempotent and rejects a changed payload', async() => {
    const {engine, farm} = await fixture()
    const first = await engine.submit(input(), 'worker-1')
    const again = await engine.submit(input(), 'worker-1')
    assert.deepEqual(again, first)
    await rejectCode(engine.submit(input({serial: 'OTHER'}), 'worker-1'),
      'idempotency_conflict', 409)
    await engine.tick()
    assert.equal(farm.captures.length, 1)
  })

  it('skips an unavailable oldest request and allocates matching requests in order', async() => {
    const {engine, farm} = await fixture()
    const blocked = await engine.submit(input({model: 'Unavailable model'}), 'blocked')
    const first = await engine.submit(input(), 'first')
    const second = await engine.submit(input(), 'second')
    const third = await engine.submit(input(), 'third')
    await engine.tick()
    assert.equal(engine.requestView(blocked.id).state, 'queued')
    assert.equal(engine.requestView(first.id).state, 'allocated')
    assert.equal(engine.requestView(second.id).state, 'allocated')
    assert.equal(engine.requestView(third.id).state, 'queued')
    assert.deepEqual(farm.captures.map(item => item.serial), ['ANDROID-A', 'ANDROID-B'])
    const ports = engine.leasesView().map(lease => lease.capabilities['appium:systemPort'])
    assert.deepEqual(ports, [8200, 8201])
  })

  it('never captures a manual user phone or issues one serial twice', async() => {
    const farm = new FakeFarm()
    farm.inventory[0]!.owner = {email: 'manual@example.test'}
    const {engine} = await fixture({}, farm)
    await Promise.all([engine.submit(input({serial: 'ANDROID-B'}), 'one')
    , engine.submit(input({serial: 'ANDROID-B'}), 'two')])
    await Promise.all([engine.tick(), engine.tick()])
    assert.deepEqual(farm.captures.map(item => item.serial), ['ANDROID-B'])
    assert.equal(farm.inventory[0]!.owner?.email, 'manual@example.test')
    assert.equal(engine.leasesView().length, 1)
  })

  it('respects parallel limits, remote ADB occupied ports and queue expiry', async() => {
    const farm = new FakeFarm()
    farm.slots.nodes.push({id: 'external', availability: 'UP', slots: [{
      stereotype: {platformName: 'Android', 'appium:remoteAdbHost': 'adb-one'}
    , session: {sessionId: 'external-session', capabilities: {
        'appium:remoteAdbHost': 'adb-one', 'appium:systemPort': 8200
      }}
    }]})
    const {engine, allocate, advance} = await fixture({maxParallel: 1}, farm)
    const lease = await allocate()
    assert.equal(lease.capabilities['appium:systemPort'], 8201)
    const waiting = await engine.submit(input({queueTimeoutSeconds: 1}), 'waiting')
    advance(1000)
    await engine.tick()
    assert.equal(engine.requestView(waiting.id).state, 'expired')
    assert.equal(farm.captures.length, 1)
  })

  it('renews until the deadline and quits before releasing expired ownership', async() => {
    const {engine, allocate, create, advance, farm, now} = await fixture()
    const lease = await allocate({maxDurationSeconds: 12})
    await create(lease.id)
    advance(7000)
    const renewed = await engine.renew(lease.id)
    assert.equal(Date.parse(renewed.expiresAt), initialTime + 12000)
    assert.ok(farm.captures[0]!.timeout > options.leaseTtlSeconds * 1000)
    advance(5000)
    assert.equal(now(), initialTime + 12000)
    await engine.tick()
    assert.equal(engine.leaseView(lease.id).state, 'expired')
    const deleted = farm.events.indexOf('webdriver:DELETE:/session/session-1')
    const released = farm.events.indexOf('release:ANDROID-A')
    assert.ok(deleted >= 0 && released > deleted, 'Quit must precede STF release')
    await rejectCode(engine.renew(lease.id), 'lease_inactive', 409)
  })

  it('expires worker heartbeat despite coordinator-side STF renewal', async() => {
    const {engine, allocate, advance, farm} = await fixture()
    const lease = await allocate()
    advance(3000)
    await engine.tick()
    assert.equal(engine.leaseView(lease.id).state, 'active')
    advance(7000)
    await engine.tick()
    assert.equal(engine.leaseView(lease.id).state, 'expired')
    assert.equal(farm.inventory[0]!.owner, null)
  })

  it('cleans an allocation completed concurrently with request cancellation', async() => {
    const farm = new FakeFarm()
    farm.captureBarrier = deferred()
    farm.captureEntered = deferred()
    const {engine} = await fixture({}, farm)
    const request = await engine.submit(input(), 'cancel-during-capture')
    const scheduling = engine.tick()
    await farm.captureEntered.promise
    const cancellation = engine.cancel(request.id)
    farm.captureBarrier.resolve()
    await scheduling
    await cancellation
    await engine.tick()
    const cancelled = engine.requestView(request.id)
    assert.equal(cancelled.state, 'cancelled')
    assert.ok(cancelled.leaseId)
    assert.equal(engine.leaseView(cancelled.leaseId).state, 'released')
    assert.equal(farm.inventory[0]!.owner, null)
  })

  it('preserves queued requests and cleans old sessions after restart', async() => {
    const original = await fixture()
    const lease = await original.allocate()
    await original.create(lease.id)
    const queued = await original.engine.submit(input({model: 'Unavailable'}), 'queued')
    const replacement = new Coordinator(original.config, pools, original.farm,
      original.store, original.now)
    await replacement.start()
    assert.equal(replacement.requestView(queued.id).state, 'queued')
    assert.equal(replacement.leaseView(lease.id).state, 'expired')
    assert.equal(original.farm.inventory[0]!.owner, null)
    assert.equal(original.farm.slots.nodes[0]!.slots[0]!.session, null)
  })

  it('leaves requests queued when inventory fails and resumes after recovery', async() => {
    const {engine, farm} = await fixture()
    const request = await engine.submit(input(), 'inventory-outage')
    farm.inventoryError = true
    await engine.tick()
    assert.equal(engine.requestView(request.id).state, 'queued')
    assert.equal(farm.captures.length, 0)
    assert.ok(engine.status().lastError)
    farm.inventoryError = false
    await engine.tick()
    assert.equal(engine.requestView(request.id).state, 'allocated')
  })

  it('stops allocations and commands after durable state writes fail', async() => {
    const {engine, store, farm} = await fixture()
    const request = await engine.submit(input(), 'disk-failure')
    store.failWrites = true
    await rejectCode(engine.tick(), 'state_unavailable', 503)
    assert.equal(farm.captures.length, 0, 'No capture may happen before durable allocation')
    assert.equal(engine.ready, false)
    await rejectCode(engine.submit(input(), 'another'), 'not_ready', 503)
    assert.equal(engine.requestView(request.id).state, 'queued')
  })

  it('rejects an expired heartbeat immediately before the scheduler notices expiry', async() => {
    const {engine, allocate, advance} = await fixture()
    const lease = await allocate()
    advance(10000)
    await rejectCode(engine.renew(lease.id), 'lease_inactive', 409)
  })

  it('rejects new commands if saving a heartbeat fails for an existing session', async() => {
    const {engine, allocate, create, store, farm} = await fixture()
    const lease = await allocate()
    const session = await create(lease.id)
    store.failWrites = true
    await rejectCode(engine.renew(lease.id), 'state_unavailable', 503)
    const before = farm.webdriverCalls.length
    await rejectCode(engine.webdriver(lease.id, 'GET', '/session/' + session + '/source'),
      'not_ready', 503)
    assert.equal(farm.webdriverCalls.length, before)
  })

  it('preserves a manual capture that wins the STF reservation race', async() => {
    const farm = new FakeFarm()
    farm.captureBarrier = deferred()
    farm.captureEntered = deferred()
    const {engine} = await fixture({}, farm)
    const request = await engine.submit(input({serial: 'ANDROID-A'}), 'manual-race')
    const scheduling = engine.tick()
    await farm.captureEntered.promise
    farm.inventory[0]!.owner = {email: 'manual@example.test'}
    farm.captureBarrier.resolve()
    await scheduling
    assert.equal(engine.requestView(request.id).state, 'queued')
    assert.equal(farm.inventory[0]!.owner.email, 'manual@example.test')
    assert.equal(farm.events.some(event => event.startsWith('release:')), false)
  })

  it('allows the same system port on distinct remote ADB hosts', async() => {
    const farm = new FakeFarm()
    farm.inventory[1]!.provider = 'provider-two'
    farm.slots.nodes[1]!.slots[0]!.stereotype['appium:remoteAdbHost'] = 'adb-two'
    const separate = [
      {...pools[0]!, systemPorts: [8200]}
    , {provider: 'provider-two', host: 'adb-two', port: 5037, systemPorts: [8200]}
    ]
    const {engine} = await fixture({}, farm, new MemoryStore(), separate)
    await engine.submit(input(), 'one')
    await engine.submit(input(), 'two')
    await engine.tick()
    const leases = engine.leasesView()
    assert.equal(leases.length, 2)
    assert.deepEqual(leases.map(lease => lease.capabilities['appium:systemPort']), [8200, 8200])
    assert.deepEqual(leases.map(lease => lease.capabilities['appium:remoteAdbHost']),
      ['adb-one', 'adb-two'])
  })

  it('requires an exact UP iOS relay with the current OS version', async() => {
    const farm = new FakeFarm()
    farm.inventory = [phone('IPHONE-A', {platform: 'iOS', version: '27.0.1'})]
    farm.slots.nodes = [{id: 'ios-node', availability: 'UP', slots: [{
      stereotype: {platformName: 'iOS', 'appium:udid': 'IPHONE-A'
        , 'appium:platformVersion': '26.7.1'}, session: null
    }]}]
    const {engine} = await fixture({}, farm)
    const request = await engine.submit(input({platform: 'iOS'}), 'ios')
    await engine.tick()
    assert.equal(engine.requestView(request.id).state, 'queued')
    farm.slots.nodes[0]!.slots[0]!.stereotype['appium:platformVersion'] = '27.0.1'
    await engine.tick()
    const allocated = engine.requestView(request.id)
    assert.ok(allocated.leaseId)
    const lease = engine.leaseView(allocated.leaseId)
    assert.equal(lease.capabilities['appium:platformVersion'], '27.0.1')
    assert.equal(Object.hasOwn(lease.capabilities, 'appium:systemPort'), false)
  })
})

describe('coordinator session isolation and uncertain cleanup', () => {
  it('uses authoritative capabilities and blocks conflicting connection overrides', async() => {
    const {engine, allocate, create, farm} = await fixture()
    const lease = await allocate()
    for (const conflict of [
      {'appium:udid': 'OTHER'}, {'appium:systemPort': 9999}
    , {'appium:remoteAdbHost': 'other-adb'}, {'appium:newCommandTimeout': 0}
    , {platformName: 'iOS'}, {'appium:webDriverAgentUrl': 'http://another-phone'}
    ]) {
      await rejectCode(engine.webdriver(lease.id, 'POST', '/session', {
        capabilities: {alwaysMatch: conflict}
      }), 'capability_conflict', 409)
    }
    assert.equal(farm.webdriverCalls.length, 0)
    await create(lease.id, {'appium:appPackage': 'example.app'})
    const body = farm.webdriverCalls[0]!.body as {
      capabilities: {alwaysMatch: Record<string, unknown>}
    }
    assert.equal(body.capabilities.alwaysMatch['appium:systemPort'], 8200)
    assert.equal(body.capabilities.alwaysMatch['appium:udid'], 'ANDROID-A')
    assert.equal(body.capabilities.alwaysMatch['stf:leaseId'], lease.id)
    assert.equal(body.capabilities.alwaysMatch['appium:appPackage'], 'example.app')
  })

  it('rejects commands addressed to another lease session', async() => {
    const {engine, allocate, create, farm} = await fixture()
    const first = await allocate({}, 'first')
    const second = await allocate({}, 'second')
    const firstSession = await create(first.id)
    const secondSession = await create(second.id)
    const callsBefore = farm.webdriverCalls.length
    await rejectCode(engine.webdriver(first.id, 'GET', '/session/' + secondSession + '/source'),
      'session_not_found', 404)
    assert.equal(farm.webdriverCalls.length, callsBefore)
    await engine.webdriver(first.id, 'GET', '/session/' + firstSession + '/source')
    assert.equal(farm.webdriverCalls.length, callsBefore + 1)
  })

  it('rejects nested and malformed W3C capabilities without upstream side effects', async() => {
    const {engine, allocate, farm} = await fixture()
    const lease = await allocate()
    for (const body of [
      {desiredCapabilities: {'appium:udid': 'OTHER'}}
    , {capabilities: {alwaysMatch: {'appium:options': {udid: 'OTHER'}}}}
    , {capabilities: {alwaysMatch: [], firstMatch: [{}]}}
    , {capabilities: {alwaysMatch: {}, firstMatch: [null]}}
    , {capabilities: {alwaysMatch: {}, firstMatch: [{}, {}]}}
    , {capabilities: {alwaysMatch: {}, firstMatch: []}}
    ]) {
      await assert.rejects(engine.webdriver(lease.id, 'POST', '/session', body))
      assert.equal(farm.webdriverCalls.length, 0)
      assert.equal(engine.leaseView(lease.id).state, 'active')
    }
  })

  it('rejects path traversal before it can be normalized into another session', async() => {
    const {engine, allocate, create, farm} = await fixture()
    const lease = await allocate()
    const session = await create(lease.id)
    for (const suffix of [
      '/../../session/OTHER/source', '/%2e%2e/%2e%2e/session/OTHER/source'
    , '/..%2f..%2fsession%2fOTHER%2fsource', '/..\\..\\session\\OTHER\\source'
    ]) {
      const before = farm.webdriverCalls.length
      await assert.rejects(engine.webdriver(lease.id, 'GET', '/session/' + session + suffix))
      assert.equal(farm.webdriverCalls.length, before, 'Unsafe route must not reach Grid')
    }
  })

  it('quarantines an unknown create outcome and keeps the phone and port reserved', async() => {
    const {engine, allocate, farm} = await fixture()
    const lease = await allocate()
    farm.createError = true
    await rejectCode(engine.webdriver(lease.id, 'POST', '/session', {
      capabilities: {alwaysMatch: {}}
    }), 'upstream_unknown', 502)
    assert.equal(engine.leaseView(lease.id).state, 'quarantined')
    const queued = await engine.submit(input({serial: lease.device.serial}), 'waiting')
    await engine.tick()
    assert.equal(engine.requestView(queued.id).state, 'queued')
    assert.equal(farm.inventory[0]!.automationLeaseId, lease.id)
    assert.equal(farm.events.some(event => event.startsWith('release:')), false)
  })

  it('never releases ownership after failed or unconfirmed Appium deletion', async() => {
    for (const failure of ['delete-error', 'still-in-grid']) {
      const {engine, allocate, create, farm} = await fixture()
      const lease = await allocate()
      await create(lease.id)
      farm.deleteStatus = failure === 'delete-error' ? 500 : 200
      farm.retainDeletedSession = failure === 'still-in-grid'
      await engine.release(lease.id)
      await engine.tick()
      assert.equal(engine.leaseView(lease.id).state, 'quarantined')
      assert.equal(farm.inventory[0]!.automationLeaseId, lease.id)
      assert.equal(farm.events.some(event => event.startsWith('release:')), false)
      farm.deleteStatus = 200
      farm.retainDeletedSession = false
      await engine.recover(lease.id)
      assert.equal(engine.leaseView(lease.id).state, 'released')
    }
  })

  it('holds the phone while a previously accepted command is still running', async() => {
    const {engine, allocate, create, farm, advance} = await fixture()
    const lease = await allocate()
    const session = await create(lease.id)
    farm.commandBarrier = deferred()
    farm.commandEntered = deferred()
    const pending = engine.webdriver(lease.id, 'POST', '/session/' + session + '/click', {})
    const settled = pending.catch(() => {})
    await farm.commandEntered.promise
    try {
      advance(10000)
      await engine.tick()
      assert.equal(farm.inventory[0]!.automationLeaseId, lease.id,
        'Device cannot be released while an old command is unsettled')
      assert.equal(farm.events.some(event => event.startsWith('release:')), false)
      const waiting = await engine.submit(input({serial: lease.device.serial}), 'next-worker')
      await engine.tick()
      assert.equal(engine.requestView(waiting.id).state, 'queued')
    }
    finally {
      farm.commandBarrier.resolve()
      await settled
    }
    if (engine.leaseView(lease.id).state === 'quarantined') {
      await engine.recover(lease.id)
    }
    else {
      await engine.tick()
    }
    assert.equal(engine.leaseView(lease.id).state, 'expired')
  })

  it('recovers the exact tagged session when its creation response was lost', async() => {
    const {engine, allocate, farm} = await fixture()
    const lease = await allocate()
    farm.createErrorAfterSession = true
    await rejectCode(engine.webdriver(lease.id, 'POST', '/session', {
      capabilities: {alwaysMatch: {}}
    }), 'upstream_unknown', 502)
    assert.equal(engine.leaseView(lease.id).state, 'quarantined')
    const upstream = farm.slots.nodes[0]!.slots[0]!.session!
    assert.equal(upstream.capabilities['stf:leaseId'], lease.id)
    await engine.recover(lease.id)
    assert.equal(engine.leaseView(lease.id).state, 'expired')
    assert.equal(farm.slots.nodes[0]!.slots[0]!.session, null)
    assert.equal(farm.inventory[0]!.owner, null)
  })

  it('does not release changed ownership even under the same service account', async() => {
    const {engine, allocate, farm} = await fixture()
    const lease = await allocate()
    farm.inventory[0]!.automationLeaseId = 'newer-lease'
    await engine.release(lease.id)
    await engine.tick()
    assert.equal(engine.leaseView(lease.id).state, 'quarantined')
    assert.equal(farm.inventory[0]!.automationLeaseId, 'newer-lease')
    assert.equal(farm.events.some(event => event.startsWith('release:')), false)
  })

  it('quarantines malformed create replies and prevents a second session', async() => {
    const {engine, allocate, farm} = await fixture()
    const lease = await allocate()
    farm.malformedCreate = true
    await assert.rejects(engine.webdriver(lease.id, 'POST', '/session', {
      capabilities: {alwaysMatch: {}}
    }))
    assert.equal(engine.leaseView(lease.id).state, 'quarantined')
    const before = farm.webdriverCalls.length
    await assert.rejects(engine.webdriver(lease.id, 'POST', '/session', {
      capabilities: {alwaysMatch: {}}
    }))
    assert.equal(farm.webdriverCalls.length, before)
  })

  it('quarantines ambiguous HTTP failures during creation', async() => {
    const {engine, allocate, farm} = await fixture()
    const lease = await allocate()
    farm.createStatus = 500
    try {
      await engine.webdriver(lease.id, 'POST', '/session', {capabilities: {alwaysMatch: {}}})
    }
    catch (error) {
      assert.ok(error instanceof CoordinatorError)
    }
    assert.equal(engine.leaseView(lease.id).state, 'quarantined')
  })

  it('accounts for all pending leases sharing a remote ADB host across providers', async() => {
    const farm = new FakeFarm()
    farm.inventory = [phone('ANDROID-A'), phone('ANDROID-B', {provider: 'provider-two'})]
    farm.slots.nodes = [farm.slots.nodes[0]!]
    const sharedPools = [...pools, {provider: 'provider-two', host: 'adb-one'
      , port: 5037, systemPorts: [8202]}]
    const {engine} = await fixture({}, farm, new MemoryStore(), sharedPools)
    await engine.submit(input({provider: 'provider-one'}), 'one')
    const second = await engine.submit(input({provider: 'provider-two'}), 'two')
    await engine.tick()
    assert.equal(farm.captures.length, 1, 'One free Grid slot grants at most one pending lease')
    assert.equal(engine.requestView(second.id).state, 'queued')
  })
})
