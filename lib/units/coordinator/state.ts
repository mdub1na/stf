import {chmod, mkdir, open, readFile, rename, unlink} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import type {CoordinatorState} from './types.js'

export interface StateStore {
  load(): Promise<CoordinatorState>
  save(state: CoordinatorState): Promise<void>
}

export class FileStateStore implements StateStore {
  constructor(private readonly filename: string) {}

  async load(): Promise<CoordinatorState> {
    try {
      const state = JSON.parse(await readFile(this.filename, 'utf8')) as CoordinatorState
      const validTime = (value: unknown) => typeof value === 'number' &&
        Number.isSafeInteger(value) && value >= 0
      const requestStates = new Set(['queued', 'allocated', 'cancelled', 'expired', 'failed'])
      const leaseStates = new Set(['allocating', 'active', 'cleaning', 'released', 'expired'
        , 'quarantined'])
      const validProject = (value: unknown) => value === undefined ||
        typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
      const valid = state && state.version === 1 && Array.isArray(state.requests) &&
        Array.isArray(state.leases) && state.requests.every(request => request &&
          typeof request.id === 'string' && request.id && typeof request.key === 'string' &&
          request.key && typeof request.fingerprint === 'string' && request.fingerprint &&
          validProject(request.projectId) &&
          requestStates.has(request.state) && validTime(request.createdAt) &&
          validTime(request.queueDeadlineAt) && request.input &&
          typeof request.input.runId === 'string' && request.input.runId &&
          ['Android', 'iOS'].includes(request.input.platform) &&
          (request.input.runner === undefined ||
            ['appium', 'maestro'].includes(request.input.runner)) &&
          (request.input.runner !== 'maestro' || request.input.platform === 'Android') &&
          validTime(request.input.queueTimeoutSeconds) && request.input.queueTimeoutSeconds > 0 &&
          validTime(request.input.maxDurationSeconds) && request.input.maxDurationSeconds > 0) &&
        state.leases.every(lease => lease && typeof lease.id === 'string' && lease.id &&
          validProject(lease.projectId) &&
          (lease.maestroCleanupConfirmed === undefined ||
            typeof lease.maestroCleanupConfirmed === 'boolean') &&
          typeof lease.requestId === 'string' && lease.requestId &&
          typeof lease.runId === 'string' && lease.runId && leaseStates.has(lease.state) &&
          validTime(lease.createdAt) && validTime(lease.expiresAt) && validTime(lease.deadlineAt) &&
          lease.device && typeof lease.device.serial === 'string' && lease.device.serial &&
          ['Android', 'iOS'].includes(lease.device.platform) && lease.capabilities &&
          typeof lease.capabilities === 'object' && !Array.isArray(lease.capabilities) &&
          (lease.runner === 'maestro' ? lease.device.platform === 'Android' &&
            (!lease.maestroBaseline || Array.isArray(lease.maestroBaseline.packages) &&
              lease.maestroBaseline.packages.every(name => typeof name === 'string') &&
              lease.maestroBaseline.settings &&
              typeof lease.maestroBaseline.settings === 'object' &&
              Object.values(lease.maestroBaseline.settings)
                .every(value => typeof value === 'string')) :
            (lease.runner === undefined || lease.runner === 'appium') &&
              lease.capabilities['appium:udid'] === lease.device.serial))
      if (!valid || new Set(state.requests.map(request => request.id)).size !==
          state.requests.length || new Set(state.requests.map(request =>
          (request.projectId || 'legacy') + '\0' + request.key)).size !==
          state.requests.length || new Set(state.leases.map(lease => lease.id)).size !==
          state.leases.length || state.leases.some(lease =>
          !state.requests.some(request => request.id === lease.requestId &&
            (request.projectId || 'legacy') === (lease.projectId || 'legacy')))) {
        throw new Error('Invalid coordinator state; refusing to discard recovery information')
      }
      await chmod(this.filename, 0o600)
      return state
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {version: 1, requests: [], leases: []}
      }
      throw error
    }
  }

  async save(state: CoordinatorState): Promise<void> {
    await mkdir(path.dirname(this.filename), {recursive: true, mode: 0o700})
    const temporary = this.filename + '.' + randomUUID() + '.tmp'
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(state) + '\n')
      await file.sync()
      await file.close()
      await rename(temporary, this.filename)
      const directory = await open(path.dirname(this.filename), 'r')
      try {
        await directory.sync()
      }
      finally {
        await directory.close()
      }
    }
    catch (error) {
      await file.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
