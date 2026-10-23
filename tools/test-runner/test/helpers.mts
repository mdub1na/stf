import http from 'node:http'
import {once} from 'node:events'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import WebSocket, {WebSocketServer} from 'ws'
import type {Runner} from '../types.mts'

export const token = 'test-farm-token-never-pass-to-child'
export const executable = fileURLToPath(new URL('../stf.mjs', import.meta.url))

export async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'stf-runner-test-'))
  const tokenFile = join(path, 'token')
  await writeFile(tokenFile, token, {mode: 0o600})
  return {path, tokenFile, close: () => rm(path, {recursive: true, force: true})}
}

export interface FakeOptions {
  runner?: Runner
  queued?: boolean
  badRenewal?: boolean
  quarantine?: boolean
  wrongPath?: boolean
  allocationDelay?: number
  failFirstAllocation?: boolean
}

export async function farm(options: FakeOptions = {}) {
  const events: Array<{method: string, path: string, auth: string | undefined,
    key: string | undefined, body: unknown}> = []
  const runner = options.runner ?? 'appium'
  let released = false
  const lease = () => ({id: 'lease-1', requestId: 'request-1', state: released ? options.quarantine ? 'quarantined' : 'released' : 'active',
    runner, device: {serial: 'PHONE', platform: 'Android', model: 'Test phone', provider: 'provider', version: '16'},
    expiresAt: new Date(Date.now() + 30000).toISOString(), deadlineAt: new Date(Date.now() + 120000).toISOString(),
    heartbeatIntervalSeconds: 1,
    capabilities: {'platformName': 'Android', 'appium:udid': 'PHONE', 'appium:automationName': 'UiAutomator2'},
    connection: {type: runner === 'appium' ? 'webdriver' : 'adb',
      path: options.wrongPath ? '/api/v1/leases/other/adb' : `/api/v1/leases/lease-1/${runner === 'appium' ? 'webdriver' : 'adb'}`,
      url: 'https://untrusted.invalid/steal-credential', serial: 'PHONE',
      ...(runner === 'appium' ? {capabilities: {'platformName': 'Android', 'appium:udid': 'PHONE', 'appium:automationName': 'UiAutomator2'}} : {})}})
  const server = http.createServer(async(req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const body: unknown = raw ? JSON.parse(raw) : undefined
    const path = req.url ?? ''
    const method = req.method ?? ''
    events.push({method, path, auth: req.headers.authorization,
      key: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined, body})
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('{}'); return }
    if (method === 'POST' && path === '/api/v1/requests') {
      if (options.failFirstAllocation && events.filter(e => e.path === path).length === 1) {
        res.writeHead(503).end('{}')
        return
      }
      if (options.allocationDelay) await new Promise(resolve => setTimeout(resolve, options.allocationDelay))
      res.writeHead(202).end(JSON.stringify({request: {id: 'request-1', state: options.queued ? 'queued' : 'allocated', leaseId: 'lease-1'}}))
    }
    else if (path === '/api/v1/requests/request-1' && method === 'DELETE') {
      res.writeHead(202).end(JSON.stringify({request: {id: 'request-1', state: 'cancelled',
        ...(options.queued ? {} : {leaseId: 'lease-1'})}}))
    }
    else if (path === '/api/v1/requests/request-1') {
      res.end(JSON.stringify({request: {id: 'request-1', state: 'queued'}}))
    }
    else if (path === '/api/v1/leases/lease-1/renew') {
      if (options.badRenewal) res.writeHead(503).end('{}')
      else res.end(JSON.stringify({lease: lease()}))
    }
    else if (path === '/api/v1/leases/lease-1') {
      if (method === 'DELETE') released = true
      res.end(JSON.stringify({lease: lease()}))
    }
    else if (path.startsWith('/api/v1/leases/lease-1/webdriver/session')) {
      res.end(JSON.stringify({value: path.endsWith('/session') ? {sessionId: 'session-1', capabilities: {}} : 'through-proxy'}))
    }
    else res.writeHead(404).end('{}')
  })
  const wss = new WebSocketServer({noServer: true})
  const streams: WebSocket[] = []
  server.on('upgrade', (req, socket, head) => {
    events.push({method: 'UPGRADE', path: req.url ?? '', auth: req.headers.authorization, key: undefined, body: undefined})
    if (req.url !== '/api/v1/leases/lease-1/adb' || req.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      streams.push(ws)
      ws.on('message', (data, binary) => ws.send(data, {binary}))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  return {url: `http://127.0.0.1:${address.port}`, events, lease,
    async close() {
      for (const ws of streams) ws.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }}
}

export function cli(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [executable, ...args], {
    env: {...process.env, ...environment}, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const finished = new Promise<{code: number | null, stdout: string, stderr: string}>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI test timed out')) }, 12000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve({code, stdout, stderr}) })
  })
  return {child, finished, stdout: () => stdout, stderr: () => stderr}
}

export async function until(predicate: () => boolean | Promise<boolean>, milliseconds = 5000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Condition timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export function gone(child: ChildProcess | number): boolean {
  const pid = typeof child === 'number' ? child : child.pid
  if (!pid) return true
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
