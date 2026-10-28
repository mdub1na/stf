import {createHash, randomUUID} from 'node:crypto'
import {BackendError} from './backend.js'
import {CoordinatorError, endpoint} from './config.js'
import type {StateStore} from './state.js'
import type {
  AdbPool, AllocationInput, AllocationRequest, CoordinatorOptions, CoordinatorState, FarmBackend
, FarmDevice, GridStatus, Lease, UpstreamResponse
} from './types.js'

const terminal = new Set(['released', 'expired'])
const requestTerminal = new Set(['cancelled', 'expired', 'failed'])

export class Coordinator {
  private state: CoordinatorState = {version: 1, requests: [], leases: []}
  private queue: Promise<unknown> = Promise.resolve()
  private owner = ''
  private initialized = false
  private stopping = false
  private fault = false
  private lastError: string | null = null
  private readonly renewed = new Map<string, number>()
  private readonly commands = new Map<string, Promise<unknown>>()
  private readonly allocations = new Map<string, Promise<void>>()
  private readonly cleanups = new Map<string, Promise<void>>()
  private ticking: Promise<void> | null = null

  constructor(readonly options: CoordinatorOptions, private readonly pools: AdbPool[],
    private readonly backend: FarmBackend, private readonly store: StateStore,
    private readonly now: () => number = Date.now) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  private async save() {
    try {
      await this.store.save(this.state)
    }
    catch {
      this.fault = true
      throw new CoordinatorError(503, 'state_unavailable', 'Persistent state is unavailable')
    }
  }

  private assertReady() {
    if (!this.initialized || this.stopping || this.fault) {
      throw new CoordinatorError(503, 'not_ready', 'Coordinator is not ready')
    }
  }

  get ready() {
    return this.initialized && !this.stopping && !this.fault
  }

  get stfTimeoutMs() {
    const grace = 180 + 2 * this.options.upstreamTimeoutSeconds
    return (this.options.leaseTtlSeconds + grace) * 1000
  }

  async start() {
    this.state = await this.store.load()
    this.owner = (await this.backend.identity()).email
    for (const lease of this.state.leases) {
      if (!terminal.has(lease.state)) {
        lease.state = 'cleaning'
        lease.finishState = 'expired'
        lease.error = 'coordinator_restarted'
      }
    }
    await this.save()
    for (const lease of this.state.leases.filter(item => item.state === 'cleaning')) {
      await this.cleanup(lease)
    }
    this.initialized = true
  }

  status() {
    const count = (items: {state: string}[]) => Object.fromEntries(
      [...new Set(items.map(item => item.state))].map(state => [state
        , items.filter(item => item.state === state).length]))
    return {ready: this.ready, requests: count(this.state.requests)
    , leases: count(this.state.leases)
    , lastError: this.lastError}
  }

  private lease(id: string) {
    const lease = this.state.leases.find(item => item.id === id)
    if (!lease) {
      throw new CoordinatorError(404, 'lease_not_found', 'Lease not found')
    }
    return lease
  }

  private request(id: string) {
    const request = this.state.requests.find(item => item.id === id)
    if (!request) {
      throw new CoordinatorError(404, 'request_not_found', 'Request not found')
    }
    return request
  }

  requestView(id: string) {
    const request = this.request(id)
    return {id: request.id, runId: request.input.runId, state: request.state
    , createdAt: new Date(request.createdAt).toISOString()
    , ...(request.leaseId ? {leaseId: request.leaseId} : {})
    , ...(request.error ? {error: request.error} : {})}
  }

  leaseView(id: string) {
    const lease = this.lease(id)
    const device = lease.device
    return {id: lease.id, requestId: lease.requestId, runId: lease.runId, state: lease.state
    , device: {serial: device.serial, model: device.model, platform: device.platform
      , provider: device.provider, version: device.version}
    , expiresAt: new Date(lease.expiresAt).toISOString()
    , deadlineAt: new Date(lease.deadlineAt).toISOString()
    , heartbeatIntervalSeconds: this.options.heartbeatIntervalSeconds
    , capabilities: lease.capabilities
    , webdriverUrl: endpoint(this.options.publicUrl) + `/api/v1/leases/${lease.id}/webdriver`
    , ...(lease.sessionId ? {sessionId: lease.sessionId} : {})
    , ...(lease.error ? {error: lease.error} : {})}
  }

  leasesView() {
    return this.state.leases.map(lease => this.leaseView(lease.id))
  }

  submit(input: AllocationInput, key: string) {
    return this.exclusive(async() => {
      this.assertReady()
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const existing = this.state.requests.find(request => request.key === key)
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new CoordinatorError(409, 'idempotency_conflict',
            'Idempotency-Key was already used for a different request')
        }
        return this.requestView(existing.id)
      }
      if (this.state.requests.length >= 10000) {
        throw new CoordinatorError(429, 'queue_limit', 'Prototype request history limit reached')
      }
      const request: AllocationRequest = {
        id: randomUUID(), key, fingerprint, input, state: 'queued', createdAt: this.now()
      , queueDeadlineAt: this.now() + input.queueTimeoutSeconds * 1000
      }
      this.state.requests.push(request)
      await this.save()
      return this.requestView(request.id)
    })
  }

  cancel(id: string) {
    return this.exclusive(async() => {
      this.assertReady()
      const request = this.request(id)
      if (!requestTerminal.has(request.state)) {
        request.state = 'cancelled'
        await this.save()
        if (request.leaseId) {
          await this.beginCleanup(this.lease(request.leaseId), 'released')
        }
      }
      return this.requestView(id)
    })
  }

  async renew(id: string) {
    const lease = await this.exclusive(async() => {
      this.assertReady()
      const current = this.lease(id)
      this.assertActive(current)
      return current
    })
    await this.refreshOwnership(lease)
    return this.exclusive(async() => {
      // IO must not hold the state queue; cancellation/expiry may have won while it ran.
      this.assertActive(lease)
      lease.expiresAt = Math.min(lease.deadlineAt,
        this.now() + this.options.leaseTtlSeconds * 1000)
      await this.save()
      return this.leaseView(id)
    })
  }

  private async refreshOwnership(lease: Lease) {
    try {
      await this.backend.renew(lease.device.serial, lease.id, this.stfTimeoutMs)
    }
    catch {
      await this.exclusive(async() => {
        if (lease.state === 'active') {
          await this.beginCleanup(lease, 'expired', 'ownership_lost')
        }
      })
      throw new CoordinatorError(409, 'ownership_lost', 'STF lease renewal failed')
    }
    this.renewed.set(lease.id, this.now())
  }

  release(id: string) {
    return this.exclusive(async() => {
      this.assertReady()
      await this.beginCleanup(this.lease(id), 'released')
      return this.leaseView(id)
    })
  }

  async recover(id: string) {
    const lease = await this.exclusive(async() => {
      this.assertReady()
      const current = this.lease(id)
      if (current.state !== 'quarantined') {
        throw new CoordinatorError(409, 'not_quarantined', 'Lease is not quarantined')
      }
      current.state = 'cleaning'
      await this.save()
      return current
    })
    await this.cleanup(lease)
    return this.leaseView(id)
  }

  private assertActive(lease: Lease) {
    this.assertReady()
    if (lease.state !== 'active' || lease.expiresAt <= this.now() ||
        lease.deadlineAt <= this.now()) {
      throw new CoordinatorError(409, 'lease_inactive', 'Lease is no longer active')
    }
  }

  private held(lease: Lease) {
    return !terminal.has(lease.state)
  }

  private matches(device: FarmDevice, request: AllocationRequest) {
    const input = request.input
    return device.present && device.ready && !device.owner && !device.using && !device.claimed &&
      device.platform.toLowerCase() === input.platform.toLowerCase() &&
      (!input.serial || input.serial === device.serial) &&
      (!input.model || input.model === device.model) &&
      (!input.provider || input.provider === device.provider) &&
      !this.state.leases.some(lease => this.held(lease) && lease.device.serial === device.serial)
  }

  private connection(device: FarmDevice, grid: GridStatus): Record<string, unknown> | null {
    const pool = this.pools.find(item => item.provider === device.provider)
    if (device.platform === 'Android' && !pool) {
      return null
    }
    const nodes = grid.nodes.filter(node => node.availability === 'UP' &&
      node.slots.some(slot => {
        const cap = slot.stereotype
        return String(cap.platformName).toLowerCase() === device.platform.toLowerCase() &&
          (device.platform === 'Android' ? cap['appium:remoteAdbHost'] === pool!.host :
            cap['appium:udid'] === device.serial &&
            cap['appium:platformVersion'] === device.version)
      }))
    const free = nodes.filter(node => node.slots.every(slot => !slot.session)).length
    const sessions = new Set(nodes.flatMap(node => node.slots)
      .flatMap(slot => slot.session ? [slot.session.sessionId] : []))
    const pending = this.state.leases.filter(lease => this.held(lease) &&
      lease.device.platform === device.platform &&
      (device.platform === 'Android' ? lease.capabilities['appium:remoteAdbHost'] === pool!.host :
        lease.device.serial === device.serial) &&
      (!lease.sessionId || !sessions.has(lease.sessionId))).length
    if (free <= pending) {
      return null
    }
    const result: Record<string, unknown> = {
      platformName: device.platform, 'appium:udid': device.serial
    , 'appium:automationName': device.platform === 'Android' ? 'UiAutomator2' : 'XCUITest'
    , 'appium:noReset': true, 'appium:newCommandTimeout': 120
    }
    if (device.platform === 'iOS') {
      return {...result, 'appium:platformVersion': device.version, 'appium:autoLaunch': false
      , 'appium:skipLogCapture': true, 'appium:shouldTerminateApp': false}
    }
    const unavailable = new Set(this.state.leases.filter(lease => this.held(lease) &&
      lease.capabilities['appium:remoteAdbHost'] === pool!.host)
      .map(lease => lease.capabilities['appium:systemPort']))
    for (const slot of grid.nodes.flatMap(node => node.slots)) {
      if (slot.session?.capabilities['appium:remoteAdbHost'] === pool!.host) {
        unavailable.add(slot.session.capabilities['appium:systemPort'])
      }
    }
    const port = pool!.systemPorts.find(value => !unavailable.has(value))
    return port === undefined ? null : {...result, 'appium:remoteAdbHost': pool!.host
    , 'appium:adbPort': pool!.port, 'appium:systemPort': port}
  }

  tick(): Promise<void> {
    if (this.ticking) {
      return this.ticking
    }
    const operation = this.schedule()
    this.ticking = operation
    operation.finally(() => {
      if (this.ticking === operation) {
        this.ticking = null
      }
    }).catch(() => {})
    return operation
  }

  private async schedule() {
    const maintenance = await this.exclusive(async() => {
      if (!this.ready) {
        return null
      }
      const cleaning: Lease[] = []
      const refreshing: Lease[] = []
      for (const lease of this.state.leases.filter(item => this.held(item))) {
        if (lease.state === 'active' &&
            (lease.expiresAt <= this.now() || lease.deadlineAt <= this.now())) {
          await this.beginCleanup(lease, 'expired', 'heartbeat_expired')
        }
        if (lease.state === 'cleaning') {
          cleaning.push(lease)
        }
        if (this.held(lease) && lease.state !== 'allocating' &&
            this.now() - (this.renewed.get(lease.id) || 0) >=
            this.options.heartbeatIntervalSeconds * 1000) {
          refreshing.push(lease)
        }
      }
      for (const request of this.state.requests.filter(item => item.state === 'queued')) {
        if (request.queueDeadlineAt <= this.now()) {
          request.state = 'expired'
          request.error = 'queue_timeout'
          if (request.leaseId) {
            await this.beginCleanup(this.lease(request.leaseId), 'expired', 'queue_timeout')
          }
          await this.save()
        }
      }
      return {cleaning, refreshing}
    })
    if (!maintenance) {
      return
    }
    // Slow recovery or one unavailable phone must not block another worker's heartbeat.
    await Promise.all([
      ...maintenance.cleaning.map(lease => this.cleanup(lease))
    , ...maintenance.refreshing.map(lease => this.refreshOwnership(lease).catch(() => {}))
    ])
    const needed = await this.exclusive(async() => this.ready &&
      this.state.requests.some(request => request.state === 'queued') &&
      this.state.leases.filter(lease => this.held(lease)).length < this.options.maxParallel)
    if (!needed) {
      return
    }
    let devices: FarmDevice[]
     , grid: GridStatus
    try {
      [devices, grid] = await Promise.all([this.backend.devices(), this.backend.grid()])
    }
    catch {
      this.lastError = 'Farm inventory is temporarily unavailable'
      return
    }
    const allocations = await this.exclusive(async() => {
      if (!this.ready) {
        return []
      }
      this.lastError = null
      const reserved: {lease: Lease, request: AllocationRequest}[] = []
      for (const request of this.state.requests.filter(item => item.state === 'queued')) {
        if (request.queueDeadlineAt <= this.now()) {
          request.state = 'expired'
          request.error = 'queue_timeout'
          await this.save()
          continue
        }
        if (this.state.leases.filter(lease => this.held(lease)).length >=
            this.options.maxParallel) {
          break
        }
        for (const device of [...devices].sort((a, b) => a.serial.localeCompare(b.serial))) {
          if (!this.matches(device, request)) {
            continue
          }
          const capabilities = this.connection(device, grid)
          if (!capabilities) {
            continue
          }
          const time = this.now()
          const lease: Lease = {
            id: randomUUID(), requestId: request.id, runId: request.input.runId
          , state: 'allocating', device: structuredClone(device), capabilities
          , createdAt: time, expiresAt: time + this.options.leaseTtlSeconds * 1000
          , deadlineAt: time + request.input.maxDurationSeconds * 1000
          , captureUncertain: true
          }
          lease.expiresAt = Math.min(lease.expiresAt, lease.deadlineAt)
          request.leaseId = lease.id
          this.state.leases.push(lease)
          await this.save()
          reserved.push({lease, request})
          break
        }
      }
      return reserved
    })
    await Promise.all(allocations.map(({lease, request}) => {
      const operation = this.allocate(lease, request)
      this.allocations.set(lease.id, operation)
      return operation.finally(async() => {
        this.allocations.delete(lease.id)
        if (lease.state === 'cleaning') {
          await this.cleanup(lease)
        }
      })
    }))
  }

  private async allocate(lease: Lease, request: AllocationRequest) {
    try {
      await this.backend.capture(lease.device.serial, lease.id, this.stfTimeoutMs)
      const continuing = await this.exclusive(async() => {
        lease.captureConfirmed = true
        delete lease.captureUncertain
        if (!this.ready || lease.state !== 'allocating' || request.state !== 'queued' ||
            request.queueDeadlineAt <= this.now() || lease.deadlineAt <= this.now()) {
          if (request.state === 'queued') {
            request.state = 'expired'
          }
          await this.beginCleanup(lease, 'released', 'allocation_cancelled')
          return false
        }
        await this.save()
        return true
      })
      if (!continuing) {
        return
      }
      await this.backend.renew(lease.device.serial, lease.id, this.stfTimeoutMs)
      await this.exclusive(async() => {
        // A cancellation/stop during capture must never be overwritten by the late result.
        if (!this.ready || lease.state !== 'allocating' || request.state !== 'queued' ||
            request.queueDeadlineAt <= this.now() || lease.deadlineAt <= this.now()) {
          if (request.state === 'queued') {
            request.state = 'expired'
          }
          await this.beginCleanup(lease, 'released', 'allocation_cancelled')
          return
        }
        lease.state = 'active'
        lease.expiresAt = Math.min(lease.deadlineAt,
          this.now() + this.options.leaseTtlSeconds * 1000)
        request.state = 'allocated'
        delete request.error
        this.renewed.set(lease.id, this.now())
        await this.save()
      })
    }
    catch (error) {
      await this.exclusive(async() => {
        if (!lease.captureConfirmed && error instanceof BackendError &&
            [403, 409].includes(error.status)) {
          lease.state = 'released'
          delete lease.captureUncertain
          if (request.state === 'queued') {
            delete request.leaseId
          }
        }
        else {
          if (request.state === 'queued') {
            request.state = 'failed'
            request.error = 'allocation_failed'
          }
          await this.beginCleanup(lease, 'released', 'allocation_failed')
        }
        await this.save()
      })
    }
  }

  /** Call while holding the state queue, then perform upstream cleanup outside it. */
  private async beginCleanup(lease: Lease, finish: 'released' | 'expired', error?: string) {
    if (terminal.has(lease.state)) {
      return
    }
    lease.state = 'cleaning'
    lease.finishState ||= finish
    if (error) {
      lease.error = error
    }
    await this.save()
  }

  private cleanup(lease: Lease): Promise<void> {
    const existing = this.cleanups.get(lease.id)
    if (existing) {
      return existing
    }
    const operation = this.cleanLease(lease)
    this.cleanups.set(lease.id, operation)
    operation.finally(() => {
      if (this.cleanups.get(lease.id) === operation) {
        this.cleanups.delete(lease.id)
      }
    }).catch(() => {})
    return operation
  }

  private async cleanLease(lease: Lease) {
    try {
      const pending = await this.exclusive(async() => terminal.has(lease.state) ||
        this.allocations.has(lease.id) ||
        (lease.creatingSession && this.commands.has(lease.id)))
      if (pending) {
        return
      }
      if (lease.creatingSession) {
        const grid = await this.backend.grid()
        const sessions = grid.nodes.flatMap(node => node.slots).flatMap(slot =>
          slot.session && slot.session.capabilities['stf:leaseId'] === lease.id ?
            [slot.session.sessionId] : [])
        if (sessions.length !== 1) {
          throw new Error('Uncertain Appium session creation')
        }
        await this.exclusive(async() => {
          lease.sessionId = sessions[0]!
          delete lease.creatingSession
          if (!this.commands.has(lease.id)) {
            delete lease.commandInFlight
          }
          await this.save()
        })
      }
      if (lease.sessionId) {
        const session = lease.sessionId
        const response = await this.backend.webdriver('DELETE',
          '/session/' + encodeURIComponent(session))
        if (response.status >= 300 && response.status !== 404) {
          throw new Error('Appium session cleanup failed')
        }
        const grid = await this.backend.grid()
        if (grid.nodes.some(node => node.slots.some(slot =>
          slot.session?.sessionId === session))) {
          throw new Error('Grid still reports the Appium session')
        }
        await this.exclusive(async() => {
          delete lease.sessionId
          await this.save()
        })
      }
      if (lease.commandInFlight) {
        if (this.commands.has(lease.id)) {
          return
        }
        throw new Error('Uncertain in-flight command')
      }
      const device = (await this.backend.devices())
        .find(item => item.serial === lease.device.serial)
      if (!device) {
        throw new Error('Device is unavailable during cleanup')
      }
      if (device.owner) {
        if (device.owner.email !== this.owner || device.automationLeaseId !== lease.id) {
          throw new Error('Device ownership changed; refusing to release another lease')
        }
        await this.backend.release(device.serial, lease.id)
        const after = (await this.backend.devices()).find(item => item.serial === device.serial)
        if (!after || after.owner || after.automationLeaseId) {
          throw new Error('STF ownership release is not confirmed')
        }
      }
      else if (lease.captureUncertain) {
        throw new Error('Uncertain STF capture; requires operator recovery')
      }
      await this.exclusive(async() => {
        lease.state = lease.finishState || 'released'
        delete lease.error
        await this.save()
      })
    }
    catch {
      await this.exclusive(async() => {
        lease.state = 'quarantined'
        lease.error = 'cleanup_unconfirmed'
        await this.save()
      })
    }
  }

  private createCapabilities(lease: Lease, body: unknown): unknown {
    const input = body as {capabilities?: {
      alwaysMatch?: Record<string, unknown>, firstMatch?: Record<string, unknown>[]
    }}
    const record = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
    const capabilities = input?.capabilities
    if (!record(input) || !record(capabilities) ||
        (capabilities.alwaysMatch !== undefined && !record(capabilities.alwaysMatch)) ||
        (capabilities.firstMatch !== undefined && (!Array.isArray(capabilities.firstMatch) ||
          capabilities.firstMatch.length !== 1 || !record(capabilities.firstMatch[0]))) ||
        (body as Record<string, unknown>).desiredCapabilities) {
      throw new CoordinatorError(400, 'invalid_capabilities', 'Expected one W3C capability set')
    }
    const supplied = {...capabilities.alwaysMatch
      , ...(capabilities.firstMatch || [{}])[0]}
    const protectedKeys = new Set(['platformName', 'appium:udid', 'appium:systemPort'
      , 'appium:remoteAdbHost', 'appium:adbPort', 'appium:automationName', 'appium:platformVersion'
      , 'appium:webDriverAgentUrl', 'appium:derivedDataPath', 'appium:wdaLocalPort'
      , 'appium:newCommandTimeout', 'appium:autoLaunch', 'appium:shouldTerminateApp'
    , 'stf:leaseId'])
    for (const [key, value] of Object.entries(supplied)) {
      const matching = key === 'platformName' ?
        String(lease.capabilities[key]).toLowerCase() === String(value).toLowerCase() :
        lease.capabilities[key] === value
      if (protectedKeys.has(key) && !matching) {
        throw new CoordinatorError(409, 'capability_conflict',
          'A requested capability conflicts with the allocated connection')
      }
      if (key === 'appium:options' || key === 'desiredCapabilities') {
        throw new CoordinatorError(400, 'invalid_capabilities',
          'Nested capability overrides are not supported')
      }
    }
    return {capabilities: {alwaysMatch: {...supplied, ...lease.capabilities
      , 'stf:leaseId': lease.id}, firstMatch: [{}]}}
  }

  async webdriver(id: string, method: string, route: string, body?: unknown) {
    const lease = this.lease(id)
    this.assertActive(lease)
    const parts = route.split('/').slice(1).map(part => decodeURIComponent(part))
    if (parts.some(part => part === '.' || part === '..' ||
        part.includes('%') || part.includes('/') || part.includes('\\') ||
        [...part].some(character => character.charCodeAt(0) <= 32))) {
      throw new CoordinatorError(400, 'invalid_webdriver_path', 'Invalid WebDriver path')
    }
    const create = route === '/session' && method === 'POST'
    if (!create && !route.startsWith('/session/')) {
      throw new CoordinatorError(404, 'webdriver_route', 'Unsupported WebDriver route')
    }
    const operation = async(): Promise<UpstreamResponse> => {
      let payload = body
      await this.exclusive(async() => {
        this.assertActive(lease)
        if (create) {
          if (lease.sessionId || lease.creatingSession) {
            throw new CoordinatorError(409, 'session_exists', 'Lease already has an Appium session')
          }
          payload = this.createCapabilities(lease, body)
        }
        else {
          const session = decodeURIComponent(route.split('/')[2] || '')
          if (session !== lease.sessionId) {
            throw new CoordinatorError(404, 'session_not_found', 'Session does not belong to lease')
          }
        }
      })
      await this.refreshOwnership(lease)
      await this.exclusive(async() => {
        this.assertActive(lease)
        if (create) {
          lease.creatingSession = true
        }
        lease.commandInFlight = true
        await this.save()
      })
      let response: UpstreamResponse
      try {
        response = await this.backend.webdriver(method, route, payload)
      }
      catch {
        await this.exclusive(async() => {
          await this.beginCleanup(lease, 'expired', 'upstream_outcome_unknown')
          lease.state = 'quarantined'
          await this.save()
        })
        throw new CoordinatorError(502, 'upstream_unknown', 'Appium outcome is uncertain')
      }
      await this.exclusive(async() => {
        delete lease.commandInFlight
        if (create) {
          let sessionId: string | undefined
          try {
            const result = JSON.parse(response.body.toString()) as {
              value?: {sessionId?: string}, sessionId?: string
            }
            sessionId = result.value?.sessionId || result.sessionId
          }
          catch {
            // Preserve the creation marker so recovery cannot blindly reissue the phone.
          }
          if (response.status >= 300 || !sessionId || typeof sessionId !== 'string') {
            lease.state = 'quarantined'
            lease.error = 'uncertain_session_creation'
            await this.save()
            throw new CoordinatorError(502, 'upstream_unknown', 'Appium session is uncertain')
          }
          lease.sessionId = sessionId
          delete lease.creatingSession
        }
        else if (method === 'DELETE' && route ===
            '/session/' + encodeURIComponent(lease.sessionId || '') && response.status < 300) {
          delete lease.sessionId
        }
        await this.save()
        this.assertActive(lease)
      })
      return response
    }
    const previous = this.commands.get(id) || Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    this.commands.set(id, result)
    try {
      return await result
    }
    finally {
      if (this.commands.get(id) === result) {
        this.commands.delete(id)
      }
    }
  }

  async stop() {
    this.stopping = true
    await this.exclusive(async() => {
      for (const lease of this.state.leases.filter(item => this.held(item))) {
        await this.beginCleanup(lease, 'expired', 'coordinator_stopped')
      }
    })
    // Pending capture/commands cannot resurrect a lease after the stop marker.
    await Promise.allSettled([
      ...(this.ticking ? [this.ticking] : [])
    , ...this.allocations.values(), ...this.commands.values(), ...this.cleanups.values()
    ])
    await Promise.all(this.state.leases.filter(item => this.held(item))
      .map(lease => this.cleanup(lease)))
  }
}
