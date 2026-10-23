import {spawn} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CoordinatorClient} from './coordinator.mts'
import {appiumProxy, maestroProxy} from './transports.mts'
import {checkAbort, pause, RunnerError} from './types.mts'
import type {Allocation, ConnectionFile, Lease, LocalTransport} from './types.mts'

export interface RunOptions {
  url: string
  tokenFile?: string
  caFile?: string
  allocation: Allocation
  command: string[]
  cleanupTimeoutSeconds: number
  signal?: AbortSignal
}

function childEnvironment(connection: ConnectionFile, file: string): NodeJS.ProcessEnv {
  const env = {...process.env}
  // The wrapper owns the lease. Tests receive neither acquisition settings nor credentials.
  for (const name of ['FARM_TOKEN', 'FARM_TOKEN_FILE', 'COORDINATOR_TOKEN', 'COORDINATOR_TOKEN_FILE',
    'COORDINATOR_URL', 'STF_TOKEN', 'STF_ACCESS_TOKEN', 'STF_BASE_URL',
    'APPIUM_SERVER_URL', 'APPIUM_CAPABILITIES_JSON', 'MAESTRO_DEVICE_ID', 'ANDROID_SERIAL',
    'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT']) delete env[name]
  env.STF_CONNECTION_FILE = file
  env.STF_DEVICE_SERIAL = connection.device.serial
  env.STF_RUNNER = connection.runner
  if (connection.appium) {
    env.APPIUM_SERVER_URL = connection.appium.url
    env.APPIUM_CAPABILITIES_JSON = JSON.stringify(connection.appium.capabilities)
  }
  if (connection.maestro) {
    env.ANDROID_SERIAL = connection.maestro.deviceId
    env.MAESTRO_DEVICE_ID = connection.maestro.deviceId
    env.ADB_SERVER_SOCKET = `tcp:${connection.maestro.host}:${connection.maestro.port}`
    env.MAESTRO_CLI_NO_ANALYTICS = 'true'
    env.MAESTRO_DISABLE_UPDATE_CHECK = 'true'
    env.MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
    env.MAESTRO_DRIVER_STARTUP_TIMEOUT ||= '120000'
    // Native Settings labels and Maestro flow names must survive Linux CI locale defaults.
    env.LANG = 'C.UTF-8'
    env.LC_ALL = 'C.UTF-8'
  }
  return env
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function command(command: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<number> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      env, stdio: 'inherit', shell: false, detached: process.platform !== 'win32'
    })
    let forced: NodeJS.Timeout | undefined
    const stop = () => {
      signalGroup(child, 'SIGTERM')
      forced ??= setTimeout(() => signalGroup(child, 'SIGKILL'), 3000)
    }
    signal.addEventListener('abort', stop, {once: true})
    if (signal.aborted) stop()
    const finished = () => {
      clearTimeout(forced)
      signal.removeEventListener('abort', stop)
      // Descendants must not retain a transport after their immediate parent exits.
      signalGroup(child, 'SIGKILL')
    }
    child.once('error', () => {
      finished()
      reject(new RunnerError('Cannot start the repository test command'))
    })
    child.once('exit', (code, received) => {
      finished()
      const number = received === 'SIGINT' ? 130 : received === 'SIGTERM' ? 143 : 1
      resolve(code ?? number)
    })
  })
}

/** Owns the complete device lifecycle, including failed tests and interrupted CI jobs. */
export async function runTest(options: RunOptions): Promise<number> {
  if (!options.command.length) throw new RunnerError('Provide a repository test command after --')
  const client = await CoordinatorClient.create(options)
  const lease = await client.acquire(options.allocation, options.signal, options.cleanupTimeoutSeconds)
  const lifetime = new AbortController()
  const active = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
  let failure: Error | undefined
  let transport: LocalTransport | undefined
  let directory: string | undefined
  let current: Lease = lease
  let deadlineTimer: NodeJS.Timeout | undefined
  const fail = (error: Error) => {
    failure ??= error
    lifetime.abort()
  }
  const expiry = () => {
    clearTimeout(deadlineTimer)
    const deadline = Math.min(Date.parse(current.expiresAt), Date.parse(lease.deadlineAt),
      Date.parse(current.deadlineAt))
    if (deadline <= Date.now()) fail(new RunnerError('Coordinator lease expired; test commands were stopped'))
    else deadlineTimer = setTimeout(() => fail(new RunnerError('Coordinator lease expired; test commands were stopped')),
      Math.min(deadline - Date.now(), 2147483647))
  }
  expiry()
  const renewals = (async() => {
    while (!active.aborted) {
      try {
        await pause(lease.heartbeatIntervalSeconds * 1000, active)
        current = await client.renew(lease, active)
        expiry()
      }
      catch {
        if (!active.aborted) fail(new RunnerError('Coordinator heartbeat failed; test commands were stopped'))
        break
      }
    }
  })()
  let code = 1
  let original: unknown
  try {
    checkAbort(active)
    transport = lease.runner === 'appium' ? await appiumProxy(client, lease) : await maestroProxy(client, lease)
    void transport.closed.catch(error => fail(error instanceof Error ? error : new RunnerError('Device transport failed')))
    checkAbort(active)
    const connection: ConnectionFile = {version: 1, runner: lease.runner, leaseId: lease.id, device: lease.device,
      ...(lease.runner === 'appium' ? {appium: {url: transport.url!, capabilities: lease.connection.capabilities!}} :
        {maestro: {host: '127.0.0.1', port: 5037, deviceId: lease.device.serial}})}
    directory = await mkdtemp(join(tmpdir(), 'stf-test-run-'))
    const file = join(directory, 'connection.json')
    await writeFile(file, JSON.stringify(connection, null, 2) + '\n', {flag: 'wx', mode: 0o600})
    process.stderr.write(`STF ${lease.runner}: allocated ${lease.device.serial}.\n`)
    code = await command(options.command, childEnvironment(connection, file), active)
    if (failure) throw failure
    checkAbort(options.signal)
  }
  catch (error) { original = failure ?? error }
  finally {
    lifetime.abort()
    clearTimeout(deadlineTimer)
    await renewals
    try { await transport?.close() }
    catch { original ??= new RunnerError('Cannot close the local device transport') }
    try { if (directory) await rm(directory, {recursive: true, force: true}) }
    catch { original ??= new RunnerError('Cannot remove the private connection file') }
    try {
      await client.release(lease, options.cleanupTimeoutSeconds)
      process.stderr.write('STF: device cleanup confirmed; lease released.\n')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Coordinator cleanup failed'
      if (original) process.stderr.write(`STF cleanup: ${message}\n`)
      else original = error
    }
  }
  if (original) throw original
  return code
}
