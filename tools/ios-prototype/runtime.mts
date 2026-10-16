import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'

import {ManagedProcess, runCommand, runJson} from './process.mts'
import {WdaClient} from './wda.mts'
import {selectedTunnel, rsdEndpoint} from './tunnel.mts'
import {Telemetry, diagnosticReason} from './telemetry.mts'
import {Shake} from './shake.mts'
import type {ImageMounter} from './tunnel.mts'

export interface RuntimeOptions {
  udid: string
  bundleId: string
  xctest: string
  goIos: string
  iproxy: string
  imageMounter: ImageMounter
  pymobiledevice3: string
  wdaPort: number
  mjpegPort: number
  tunnelPort: number
  retryMs: number
  startupMs: number
  stateDirectory?: string
}

interface RuntimeProcess {
  failure: Error | null
  stop(): Promise<void>
}

export interface RuntimeDependencies {
  json: typeof runJson
  run: typeof runCommand
  start: (binary: string, args: string[]) => RuntimeProcess
  wda: WdaClient
  log: (message: string) => void
}

export class IosRuntime {
  readonly instance = randomUUID()
  readonly wda: WdaClient
  readonly options: RuntimeOptions
  state: 'waiting' | 'starting' | 'ready' | 'stopped' = 'waiting'
  lastError: string | null = null
  info: unknown = null
  generation = 0
  readonly telemetry: Telemetry
  private lastTelemetry = 0
  private abort = new AbortController()
  private running: Promise<void> | null = null
  private children: RuntimeProcess[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private dependencies: RuntimeDependencies
  private shaker: Shake

  constructor(options: RuntimeOptions, dependencies?: Partial<RuntimeDependencies>) {
    this.options = {...options}
    this.wda = dependencies?.wda || new WdaClient('http://127.0.0.1:' + options.wdaPort)
    this.dependencies = {
      json: runJson
    , run: runCommand
    , start: (binary, args) => new ManagedProcess(binary, args)
    , log: message => process.stderr.write(message + '\n')
    , ...dependencies
    , wda: this.wda
    }
    this.telemetry = new Telemetry(this.options, this.dependencies.json)
    this.shaker = new Shake(options.goIos, options.udid
      , this.dependencies.json, this.dependencies.run)
  }

  private args(...args: string[]): string[] {
    return ['--udid=' + this.options.udid, '--tunnel-info-port=' + this.options.tunnelPort, ...args]
  }

  start(): void {
    if (this.running) {
      throw new Error('Runtime has already started')
    }
    this.running = this.loop()
  }

  private async sleep(ms: number): Promise<void> {
    await delay(ms, null, {signal: this.abort.signal})
  }

  private checkChildren(): void {
    if (this.abort.signal.aborted) {
      throw new Error('Runtime stopped')
    }
    for (const child of this.children) {
      if (child.failure) {
        throw child.failure
      }
    }
  }

  private async prepare(): Promise<void> {
    const {json, run, start} = this.dependencies
    const o = this.options
    this.telemetry.phase('checking_usb')
    const listing = await json(o.goIos, ['list'], 15000, this.abort.signal) as {
      deviceList?: string[]
    }
    if (!listing.deviceList?.includes(o.udid)) {
      throw new Error('Selected iPhone is not connected: ' + o.udid)
    }
    this.telemetry.phase('pairing')
    this.info = await json(o.goIos, this.args('info'), 15000, this.abort.signal)
    const name = (this.info as {DeviceName?: string})?.DeviceName
    this.telemetry.status.name = typeof name === 'string' ? name.slice(0, 255) : null
    await this.telemetry.refresh(this.abort.signal, true)
    if (this.telemetry.status.wda.installed === false) {
      throw new Error('IOS_WDA_MISSING: Install the signed WDA runner on this iPhone')
    }
    this.checkChildren()
    this.telemetry.phase('tunnel')
    const tunnels = await json(o.goIos, this.args('tunnel', 'ls'), 15000, this.abort.signal)
    const tunnel = selectedTunnel(tunnels, o.udid)
    this.telemetry.phase('mounting')
    if (o.imageMounter === 'pymobiledevice3') {
      // Reuse the selected kernel tunnel; do not start a second tunnel daemon.
      await run(o.pymobiledevice3, [
        'mounter', 'auto-mount', '--udid=' + o.udid, '--rsd', ...rsdEndpoint(tunnel)
      ], 120000, this.abort.signal)
    }
    else {
      await run(o.goIos, this.args('image', 'auto'), 120000, this.abort.signal)
    }
    this.checkChildren()
    this.telemetry.phase('wda')
    this.children.push(start(o.iproxy, [
      '-u', o.udid, '-l', '-s', '127.0.0.1'
    , o.wdaPort + ':8100', o.mjpegPort + ':9100'
    ]))
    // Catch a failed bind before asking the device to start WDA.
    await this.sleep(300)
    this.checkChildren()
    this.children.push(start(o.goIos, this.args('runwda',
      '--bundleid=' + o.bundleId, '--testrunnerbundleid=' + o.bundleId,
      '--xctestconfig=' + o.xctest)))
    const deadline = Date.now() + o.startupMs
    while (Date.now() < deadline) {
      this.checkChildren()
      try {
        await this.wda.request('GET', '/status')
        this.checkChildren()
        this.telemetry.phase('session')
        await this.wda.open()
        this.checkChildren()
        return
      }
      catch (error) {
        this.checkChildren()
        this.lastError = (error as Error).message
        await this.sleep(500)
      }
    }
    throw new Error('WDA did not start: ' + this.lastError)
  }

  private async cleanup(): Promise<void> {
    this.generation += 1
    await this.queue.catch(() => null)
    await this.wda.close().catch(() => null)
    await Promise.all(this.children.splice(0).map(child => child.stop()))
  }

  private async loop(): Promise<void> {
    await this.telemetry.load()
    while (!this.abort.signal.aborted) {
      try {
        this.state = 'starting'
        this.telemetry.status.attempts++
        await this.prepare()
        this.state = 'ready'
        this.lastError = null
        this.telemetry.phase('ready', 'ready')
        this.telemetry.status.lastReadyAt = new Date().toISOString()
        this.dependencies.log('iPhone ' + this.options.udid + ': ready')
        while (!this.abort.signal.aborted) {
          await this.sleep(this.options.retryMs)
          this.checkChildren()
          // Probe our session, not just /status: WDA can outlive a lost XCTest session.
          await this.wda.call('GET', '')
          const locked = await this.wda.call('GET', '/wda/locked')
          this.telemetry.status.locked = typeof locked.value === 'boolean' ? locked.value : null
          const profile = this.telemetry.status.wda.profile
          let reason = 'wda_profile_unknown'
          if (profile === 'valid') {
            reason = 'ready'
          }
          if (profile === 'expired' || profile === 'expiring') {
            reason = 'wda_profile_' + profile
          }
          if (locked.value === true) {
            reason = 'locked'
          }
          this.telemetry.phase('ready', reason)
          if (Date.now() - this.lastTelemetry > 30000) {
            await this.telemetry.refresh(this.abort.signal)
            this.lastTelemetry = Date.now()
          }
        }
      }
      catch (error) {
        if (!this.abort.signal.aborted) {
          this.lastError = (error as Error).message
          let reason = diagnosticReason(this.telemetry.status.phase, error)
          if (reason === 'wda_unavailable' && this.telemetry.status.wda.profile === 'expired') {
            reason = 'wda_profile_expired'
          }
          this.telemetry.phase(this.telemetry.status.phase, reason)
          this.dependencies.log('iPhone: ' + this.lastError)
        }
      }
      finally {
        this.state = 'waiting'
        await this.cleanup()
      }
      if (!this.abort.signal.aborted) {
        await this.sleep(this.options.retryMs).catch(() => null)
      }
    }
    this.state = 'stopped'
    this.telemetry.phase('stopped', 'provider_unavailable')
  }

  shake(signal: AbortSignal): Promise<void> {
    return this.execute(wda => this.shaker.perform(wda,
      AbortSignal.any([this.abort.signal, signal, AbortSignal.timeout(45000)])))
  }

  execute<T>(action: (wda: WdaClient) => Promise<T>): Promise<T> {
    const generation = this.generation
    const work = this.queue.then(async() => {
      if (this.state !== 'ready' || this.telemetry.status.locked ||
          generation !== this.generation) {
        throw new Error('iPhone is not ready')
      }
      this.checkChildren()
      return action(this.wda)
    })
    this.queue = work.catch(() => null)
    return work
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await this.running
  }
}
