export type Runner = 'appium' | 'maestro'
export type Platform = 'Android' | 'iOS'

export interface Device {
  serial: string
  model: string
  platform: Platform
  version: string
  provider: string
}

export interface Lease {
  id: string
  state: string
  runner: Runner
  device: Device
  expiresAt: string
  deadlineAt: string
  heartbeatIntervalSeconds: number
  connection: {
    type: 'webdriver' | 'adb'
    path: string
    capabilities?: Record<string, unknown>
    serial?: string
  }
}

export interface Allocation {
  runner: Runner
  platform: Platform
  runId: string
  serial?: string
  model?: string
  provider?: string
  queueTimeoutSeconds: number
  maxDurationSeconds: number
}

export interface ConnectionFile {
  version: 1
  runner: Runner
  leaseId: string
  device: Device
  appium?: {url: string, capabilities: Record<string, unknown>}
  maestro?: {host: string, port: number, deviceId: string}
}

export interface LocalTransport {
  url?: string
  closed: Promise<void>
  close(): Promise<void>
}

export class RunnerError extends Error {}

export function abortError(): RunnerError {
  return new RunnerError('Test run cancelled')
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

export async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    const cancel = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(abortError())
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', cancel, {once: true})
  })
}
