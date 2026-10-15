import {setTimeout as delay} from 'node:timers/promises'

import {ManagedProcess, runCommand, runJson} from './process.mts'
import {WdaClient} from './wda.mts'

export interface RuntimeOptions {
  udid: string
  bundleId: string
  xctest: string
  goIos: string
  iproxy: string
  wdaPort: number
  mjpegPort: number
  tunnelPort: number
  retryMs: number
  startupMs: number
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
  readonly wda: WdaClient
  readonly options: RuntimeOptions
  state: 'waiting' | 'starting' | 'ready' | 'stopped' = 'waiting'
  lastError: string | null = null
  info: unknown = null
  generation = 0
  private abort = new AbortController()
  private running: Promise<void> | null = null
  private children: RuntimeProcess[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private dependencies: RuntimeDependencies

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
    const listing = await json(o.goIos, ['list'], 15000, this.abort.signal) as {
      deviceList?: string[]
    }
    if (!listing.deviceList?.includes(o.udid)) {
      throw new Error('Selected iPhone is not connected: ' + o.udid)
    }
    this.info = await json(o.goIos, this.args('info'), 15000, this.abort.signal)
    this.checkChildren()
    const tunnels = await json(o.goIos, this.args('tunnel', 'ls'), 15000, this.abort.signal)
    if (!Array.isArray(tunnels) || !tunnels.some(t => t?.udid === o.udid || t?.Udid === o.udid)) {
      throw new Error('No go-ios tunnel for this iPhone; start the tunnel agent first')
    }
    await run(o.goIos, this.args('image', 'auto'), 120000, this.abort.signal)
    this.checkChildren()
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
    while (!this.abort.signal.aborted) {
      try {
        this.state = 'starting'
        await this.prepare()
        this.state = 'ready'
        this.lastError = null
        this.dependencies.log('iPhone ' + this.options.udid + ': ready')
        while (!this.abort.signal.aborted) {
          await this.sleep(this.options.retryMs)
          this.checkChildren()
          // Probe our session, not just /status: WDA can outlive a lost XCTest session.
          await this.wda.call('GET', '')
        }
      }
      catch (error) {
        if (!this.abort.signal.aborted) {
          this.lastError = (error as Error).message
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
  }

  execute<T>(action: (wda: WdaClient) => Promise<T>): Promise<T> {
    const generation = this.generation
    const work = this.queue.then(async() => {
      if (this.state !== 'ready' || generation !== this.generation) {
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
