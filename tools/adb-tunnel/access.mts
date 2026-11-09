import net from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'

import {HttpError, originUrl} from './types.mts'
import type {Access, Target} from './types.mts'

export interface ProviderRoute {
  host: string
  adbPorts: number[]
}

export interface StfAccessOptions {
  stfUrl: string
  providers: Record<string, ProviderRoute>
  timeoutMs?: number
}

type ObjectValue = Record<string, unknown>

class RemoteStoppedError extends HttpError {
  constructor() {
    super(403, 'Remote ADB was stopped in STF')
  }
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(502, 'STF returned an invalid response')
  }
  return value as ObjectValue
}

function field(value: ObjectValue, name: string): string {
  if (typeof value[name] !== 'string' || !value[name]) {
    throw new HttpError(502, 'STF returned incomplete device information')
  }
  return value[name] as string
}

function validSerial(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f/\\?#]/.test(value)
}

function routePort(address: unknown): number {
  // The hostname is deliberately discarded: only operator-configured destinations are dialled.
  if (typeof address !== 'string' || !/^(?:[A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$/.test(address)) {
    throw new HttpError(502, 'STF returned an invalid Remote ADB address')
  }
  return Number(address.slice(address.lastIndexOf(':') + 1))
}

export class StfAccess implements Access {
  #origin: URL
  #providers: Map<string, ProviderRoute>
  #timeoutMs: number

  constructor(options: StfAccessOptions) {
    this.#origin = originUrl(options.stfUrl, 'stfUrl')
    this.#timeoutMs = options.timeoutMs ?? 5000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30000) {
      throw new Error('STF request timeout must be between 1 and 30000 milliseconds')
    }
    if (!options.providers || typeof options.providers !== 'object' || Array.isArray(options.providers)) {
      throw new Error('Configure at least one trusted provider route')
    }
    this.#providers = new Map(Object.entries(options.providers).map(([name, route]) => {
      if (!name || name.length > 128 || !route || typeof route.host !== 'string' ||
          !(net.isIP(route.host) || /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(route.host)) ||
          !Array.isArray(route.adbPorts) || route.adbPorts.length === 0 ||
          route.adbPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535 || port === 5037)) {
        throw new Error('Provider routes require a hostname and explicit device ADB ports (not 5037)')
      }
      return [name, {host: route.host, adbPorts: [...new Set(route.adbPorts)]}]
    }))
    if (!this.#providers.size) {
      throw new Error('Configure at least one trusted provider route')
    }
  }

  async #request(token: string, path: string, method = 'GET', signal?: AbortSignal): Promise<ObjectValue> {
    if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw new HttpError(401, 'A valid STF access token is required')
    }
    try {
      const response = await fetch(new URL(path, this.#origin), {
        method, headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}
      , redirect: 'manual', signal: signal ?
          AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs)
      })
      if (!response.ok) {
        await response.body?.cancel()
        const status = [401, 403, 404].includes(response.status) ? response.status : 502
        throw new HttpError(status, status === 401 ? 'STF access token was rejected' :
          status === 403 ? 'The device must be occupied by your STF account' :
            status === 404 ? 'The device or STF endpoint was not found' : 'STF API is unavailable')
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel()
        throw new HttpError(502, 'STF did not return JSON; check the API address')
      }
      const reader = response.body?.getReader()
      if (!reader) {
        throw new HttpError(502, 'STF returned an empty response')
      }
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const {value, done} = await reader.read()
        if (done) {
          break
        }
        size += value.byteLength
        if (size > 1024 * 1024) {
          await reader.cancel()
          throw new HttpError(502, 'STF response exceeded its size limit')
        }
        chunks.push(value)
      }
      const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (data.success !== true) {
        throw new HttpError(502, 'STF did not confirm the operation')
      }
      return data
    }
    catch (error) {
      if (error instanceof HttpError) {
        throw error
      }
      throw new HttpError(502, 'STF API request failed')
    }
  }

  async #owned(token: string, serial: string, signal?: AbortSignal): Promise<{email: string, device: ObjectValue}> {
    if (!validSerial(serial)) {
      throw new HttpError(400, 'Provide a valid Android device serial')
    }
    const profile = await this.#request(token, '/api/v1/user', 'GET', signal)
    const email = field(object(profile.user), 'email')
    const response = await this.#request(token, `/api/v1/user/devices/${encodeURIComponent(serial)}`, 'GET', signal)
    const device = object(response.device)
    // The STF API also permits administrators; a tunnel never inherits that ownership bypass.
    if (device.serial !== serial || device.platform !== 'Android' || device.present !== true ||
        device.ready !== true || !device.owner || object(device.owner).email !== email) {
      throw new HttpError(403, 'Occupy a ready Android device using your own STF account first')
    }
    return {email, device}
  }

  #target(email: string, device: ObjectValue, address: unknown): Target {
    const provider = object(device.provider)
    const name = field(provider, 'name')
    const route = this.#providers.get(name)
    const port = routePort(address)
    if (!route || !route.adbPorts.includes(port)) {
      throw new HttpError(403, 'Remote ADB is outside the configured provider routes')
    }
    const channel = field(device, 'channel')
    const ownerGroup = field(object(device.owner), 'group')
    const providerChannel = field(provider, 'channel')
    return {
      serial: field(device, 'serial'), email, provider: name, host: route.host, port
    , binding: JSON.stringify([channel, ownerGroup, providerChannel, address])
    }
  }

  async open(token: string, serial: string, signal?: AbortSignal): Promise<Target> {
    const initial = await this.#owned(token, serial, signal)
    // Reject unknown providers before asking STF to start anything.
    if (!this.#providers.has(field(object(initial.device.provider), 'name'))) {
      throw new HttpError(403, 'The device provider is not configured for remote ADB')
    }
    const response = await this.#request(token,
      `/api/v1/user/devices/${encodeURIComponent(serial)}/remoteConnect`, 'POST', signal)
    const target = this.#target(initial.email, initial.device, response.remoteConnectUrl)
    // Ownership, worker or port assignment may change while Remote ADB is starting.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.check(token, target, signal)
        break
      }
      catch (error) {
        // STF announces the URL before its asynchronous database update is necessarily visible.
        if (!(error instanceof RemoteStoppedError) || attempt === 4) {
          throw error
        }
        await delay(100, undefined, signal ? {signal} : {})
      }
    }
    return target
  }

  async check(token: string, target: Target, signal?: AbortSignal): Promise<void> {
    const {email, device} = await this.#owned(token, target.serial, signal)
    if (device.remoteConnect !== true) {
      throw new RemoteStoppedError()
    }
    const current = this.#target(email, device, device.remoteConnectUrl)
    if (current.email !== target.email || current.provider !== target.provider ||
        current.host !== target.host || current.port !== target.port || current.binding !== target.binding) {
      throw new HttpError(403, 'The device session changed; connect again from STF')
    }
  }
}
