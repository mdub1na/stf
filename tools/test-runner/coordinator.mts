import {constants} from 'node:fs'
import {open, readFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import {randomUUID} from 'node:crypto'
import {checkAbort, pause, RunnerError} from './types.mts'
import type {Allocation, Lease, Runner} from './types.mts'

const segment = (value: string) => encodeURIComponent(value)
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 1024 && !/\p{Cc}|\p{Cf}/u.test(value)

export function normalizeFarmUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) }
  catch { throw new RunnerError('FARM_URL must be an absolute HTTP(S) endpoint') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username ||
      url.password || url.search || url.hash ||
      !['', '/', '/api/v1', '/api/v1/'].includes(url.pathname)) {
    throw new RunnerError('FARM_URL must be an HTTP(S) origin or its /api/v1 endpoint, without credentials')
  }
  url.pathname = '/api/v1'
  return url
}

export async function readFarmToken(file?: string, environment = process.env): Promise<string> {
  const path = file || environment.FARM_TOKEN_FILE || environment.COORDINATOR_TOKEN_FILE
  let token: string | undefined
  if (path) {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 16384 ||
          (process.platform !== 'win32' &&
            ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
        throw new Error('private file required')
      }
      token = await handle.readFile('utf8')
    }
    catch { throw new RunnerError('Token file must be a private regular file owned by the current user') }
    finally { await handle?.close() }
  }
  else token = environment.FARM_TOKEN || environment.COORDINATOR_TOKEN
  token = token?.trim()
  if (!token || token.length > 16384 || /\s/.test(token)) {
    throw new RunnerError('Provide FARM_TOKEN_FILE, FARM_TOKEN, or --token-file with a valid farm token')
  }
  return token
}

class ApiError extends RunnerError {
  readonly status: number
  constructor(status: number) {
    super(`Coordinator request failed (HTTP ${status})`)
    this.status = status
  }
}

export function parseLease(value: unknown, expectedRunner: Runner): Lease {
  if (!record(value) || !text(value.id) || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id) ||
      !text(value.state) || !record(value.device)) {
    throw new RunnerError('Invalid coordinator lease')
  }
  const runner = value.runner ?? 'appium'
  if (runner !== expectedRunner || !['Android', 'iOS'].includes(String(value.device.platform)) ||
      !text(value.device.serial) ||
      (runner === 'maestro' && value.device.platform !== 'Android')) {
    throw new RunnerError('Coordinator lease does not match the requested runner and platform')
  }
  for (const key of ['expiresAt', 'deadlineAt']) {
    if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) {
      throw new RunnerError('Invalid coordinator lease deadline')
    }
  }
  if (typeof value.heartbeatIntervalSeconds !== 'number' ||
      !Number.isSafeInteger(value.heartbeatIntervalSeconds) || value.heartbeatIntervalSeconds < 1 ||
      value.heartbeatIntervalSeconds > 3600) {
    throw new RunnerError('Invalid coordinator heartbeat interval')
  }
  const type = runner === 'appium' ? 'webdriver' : 'adb'
  const path = `/api/v1/leases/${segment(value.id)}/${type}`
  // Paths are validated; a URL/host returned by the server is never a dial destination.
  const supplied = value.connection
  if (supplied !== undefined && (!record(supplied) || supplied.type !== type || supplied.path !== path)) {
    throw new RunnerError('Unexpected coordinator connection path')
  }
  if (runner === 'maestro' && !record(supplied)) {
    throw new RunnerError('Coordinator did not provide an ADB connection')
  }
  if (record(supplied) && supplied.serial !== undefined && supplied.serial !== value.device.serial) {
    throw new RunnerError('Coordinator connection serial does not match the leased phone')
  }
  const capabilities = record(supplied) && supplied.capabilities !== undefined ? supplied.capabilities : value.capabilities
  if (runner === 'appium' && (!record(capabilities) ||
      capabilities['appium:udid'] !== value.device.serial)) {
    throw new RunnerError('Coordinator capabilities do not match the leased phone')
  }
  const device = value.device
  return {
    id: value.id, runner: runner as Runner, state: value.state,
    device: {serial: device.serial as string, platform: device.platform as Lease['device']['platform'],
      model: typeof device.model === 'string' ? device.model : '',
      provider: typeof device.provider === 'string' ? device.provider : '',
      version: typeof device.version === 'string' ? device.version : ''},
    expiresAt: value.expiresAt as string, deadlineAt: value.deadlineAt as string,
    heartbeatIntervalSeconds: value.heartbeatIntervalSeconds,
    connection: {type, path, ...(runner === 'appium' ? {capabilities: capabilities as Record<string, unknown>} :
      {serial: device.serial as string})}
  }
}

export class CoordinatorClient {
  readonly base: URL
  readonly ca: Buffer | undefined
  private readonly token: string
  private constructor(base: URL, token: string, ca?: Buffer) {
    this.base = base
    this.ca = ca
    this.token = token
  }

  static async create(options: {url: string, tokenFile?: string, caFile?: string}): Promise<CoordinatorClient> {
    return new CoordinatorClient(normalizeFarmUrl(options.url), await readFarmToken(options.tokenFile),
      options.caFile ? await readFile(options.caFile) : undefined)
  }

  endpoint(path: string): URL {
    if (!path.startsWith('/api/v1/') || path.includes('?') || path.includes('#')) {
      throw new RunnerError('Invalid coordinator API path')
    }
    const url = new URL(this.base)
    url.pathname = path
    return url
  }

  headers(): Record<string, string> { return {Authorization: `Bearer ${this.token}`} }

  async request(method: string, path: string, body?: unknown, key?: string,
    signal?: AbortSignal): Promise<Record<string, unknown>> {
    checkAbort(signal)
    const url = this.endpoint('/api/v1' + path)
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, ca: this.ca, rejectUnauthorized: true, ...(signal ? {signal} : {}),
        headers: {...this.headers(), Accept: 'application/json',
          ...(payload === undefined ? {} : {'Content-Type': 'application/json'}),
          ...(key ? {'Idempotency-Key': key} : {})}
      }, response => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume()
          reject(new ApiError(response.statusCode ?? 0))
          return
        }
        let bytes = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 1024 * 1024) response.destroy(new Error('response limit'))
          else chunks.push(chunk)
        })
        response.once('error', () => reject(new RunnerError('Coordinator response was interrupted')))
        response.once('end', () => {
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!record(result)) throw new Error('invalid response')
            resolve(result)
          }
          catch { reject(new RunnerError('Invalid coordinator response')) }
        })
      })
      const timer = setTimeout(() => request.destroy(new Error('timeout')), 15000)
      request.once('close', () => clearTimeout(timer))
      request.once('error', () => reject(new RunnerError(signal?.aborted ? 'Test run cancelled' :
        'Cannot reach the configured coordinator')))
      request.end(payload)
    })
  }

  async acquire(input: Allocation, signal?: AbortSignal, cleanupTimeoutSeconds = 120): Promise<Lease> {
    checkAbort(signal)
    const key = randomUUID()
    let result: Record<string, unknown> | undefined
    // Creation retries reuse the same key, including an ambiguous network failure.
    // Do not abort a creation in flight: obtain its ID first so cancellation can delete it.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await this.request('POST', '/requests', input, key); break }
      catch (error) {
        if (error instanceof ApiError && error.status < 500) throw error
        if (attempt === 2) {
          throw new RunnerError('Allocation outcome could not be confirmed; coordinator request/lease expiry will recover any accepted request')
        }
      }
    }
    let request = result?.request
    if (!record(request) || !text(request.id) || !/^[A-Za-z0-9_-]{1,200}$/.test(request.id)) {
      throw new RunnerError('Coordinator did not return an allocation request')
    }
    const id = request.id
    const deadline = Date.now() + input.queueTimeoutSeconds * 1000
    try {
      while (true) {
        checkAbort(signal)
        if (request.state === 'allocated') {
          if (!text(request.leaseId) || !/^[A-Za-z0-9_-]{1,200}$/.test(request.leaseId)) {
            throw new RunnerError('Coordinator allocation has no valid lease ID')
          }
          const lease = await this.getLease(request.leaseId, input.runner, signal)
          if (lease.state !== 'active' || lease.device.platform !== input.platform ||
              input.serial && lease.device.serial !== input.serial) {
            throw new RunnerError('Coordinator did not return the requested active device')
          }
          return lease
        }
        if (request.state !== 'queued') throw new RunnerError('Coordinator allocation ended without a device')
        if (Date.now() >= deadline) throw new RunnerError('Timed out waiting for a farm device')
        await pause(Math.min(1000, deadline - Date.now()), signal)
        request = (await this.request('GET', `/requests/${segment(id)}`, undefined, undefined, signal)).request
        if (!record(request)) throw new RunnerError('Invalid coordinator allocation response')
      }
    }
    catch (error) {
      try {
        const cancelled = (await this.request('DELETE', `/requests/${segment(id)}`)).request
        // Allocation may have completed while the caller timed out or received a signal.
        if (record(cancelled) && typeof cancelled.leaseId === 'string') {
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(cancelled.leaseId)) throw new RunnerError('Invalid cancellation lease')
          const lease = await this.getLease(cancelled.leaseId, input.runner)
          await this.release(lease, cleanupTimeoutSeconds)
        }
      }
      catch {
        const message = error instanceof Error ? error.message : 'Allocation failed'
        throw new RunnerError(`${message}; cancellation cleanup could not be confirmed; coordinator expiry will recover it`)
      }
      throw error
    }
  }

  async getLease(id: string, runner: Runner, signal?: AbortSignal): Promise<Lease> {
    const result = await this.request('GET', `/leases/${segment(id)}`, undefined, undefined, signal)
    const lease = parseLease(result.lease, runner)
    if (lease.id !== id) throw new RunnerError('Coordinator returned a different lease')
    return lease
  }

  async renew(lease: Lease, signal?: AbortSignal): Promise<Lease> {
    const result = await this.request('POST', `/leases/${segment(lease.id)}/renew`, {}, undefined, signal)
    const renewed = parseLease(result.lease, lease.runner)
    if (renewed.id !== lease.id || renewed.device.serial !== lease.device.serial || renewed.state !== 'active') {
      throw new RunnerError('Coordinator lease renewal no longer owns this device')
    }
    return renewed
  }

  async release(lease: Lease, timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000
    let result = await this.request('DELETE', `/leases/${segment(lease.id)}`)
    while (true) {
      const current = parseLease(result.lease, lease.runner)
      if (current.id !== lease.id) throw new RunnerError('Coordinator returned a different cleanup lease')
      if (current.state === 'quarantined') throw new RunnerError('Coordinator quarantined the device because cleanup could not be confirmed')
      if (['released', 'expired'].includes(current.state)) return
      if (!['active', 'cleaning'].includes(current.state)) throw new RunnerError('Unknown coordinator cleanup state')
      if (Date.now() >= deadline) throw new RunnerError('Coordinator cleanup is pending; device must not be reused')
      await pause(Math.min(500, deadline - Date.now()))
      result = await this.request('GET', `/leases/${segment(lease.id)}`)
    }
  }
}
