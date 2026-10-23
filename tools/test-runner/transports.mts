import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import WebSocket from 'ws'
import {CoordinatorClient} from './coordinator.mts'
import {RunnerError} from './types.mts'
import type {Lease, LocalTransport} from './types.mts'

const maxBuffer = 4 * 1024 * 1024

function completion() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const closed = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void closed.catch(() => {})
  return {closed, resolve, reject}
}

function webdriverPath(path: string): boolean {
  if (path.includes('?') || path.includes('#')) return false
  let parts: string[]
  try { parts = path.split('/').slice(1).map(decodeURIComponent) }
  catch { return false }
  if (parts.some(part => part === '.' || part === '..' || part.includes('%') ||
      part.includes('/') || part.includes('\\') || /\p{Cc}|\p{Cf}|\s/u.test(part))) return false
  return path === '/session' || path.startsWith('/session/') && !!parts[1]
}

/** Authenticates only the one lease endpoint; credentials never reach the test process. */
export async function appiumProxy(client: CoordinatorClient, lease: Lease): Promise<LocalTransport> {
  const done = completion()
  const upstreams = new Set<http.ClientRequest>()
  const sockets = new Set<net.Socket>()
  let stopped = false
  const server = http.createServer((incoming, outgoing) => {
    const path = incoming.url ?? ''
    if (!webdriverPath(path)) {
      outgoing.writeHead(404, {'Content-Type': 'application/json'})
      outgoing.end(JSON.stringify({value: {error: 'unknown command', message: 'Unsupported lease WebDriver path', stacktrace: ''}}))
      incoming.resume()
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let oversized = false
    incoming.on('data', (chunk: Buffer) => {
      if (oversized) return
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        oversized = true
        outgoing.writeHead(413).end()
        incoming.destroy()
      }
      else chunks.push(chunk)
    })
    incoming.once('end', () => {
      if (outgoing.destroyed || stopped) return
      const url = client.endpoint(lease.connection.path + path)
      const payload = Buffer.concat(chunks)
      const remote = (url.protocol === 'https:' ? https : http).request(url, {
        method: incoming.method, ca: client.ca, rejectUnauthorized: true,
        headers: {...client.headers(), Accept: 'application/json',
          'Content-Type': 'application/json', 'Content-Length': String(payload.length)}
      }, response => {
        // Streaming keeps screenshots out of the wrapper's memory; cap unexpected output.
        let received = 0
        outgoing.writeHead(response.statusCode ?? 502, {
          'Content-Type': String(response.headers['content-type'] ?? 'application/json'),
          'Cache-Control': 'no-store'
        })
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > 32 * 1024 * 1024) {
            response.destroy()
            outgoing.destroy()
          }
          else if (!outgoing.write(chunk)) response.pause()
        })
        outgoing.on('drain', () => response.resume())
        response.once('end', () => outgoing.end())
        response.once('error', () => outgoing.destroy())
      })
      upstreams.add(remote)
      const timeout = setTimeout(() => remote.destroy(new Error('timeout')), 240000)
      remote.once('close', () => { clearTimeout(timeout); upstreams.delete(remote) })
      remote.once('error', () => {
        if (outgoing.headersSent) outgoing.destroy()
        else {
          outgoing.writeHead(502, {'Content-Type': 'application/json'})
          outgoing.end(JSON.stringify({value: {error: 'unknown error', message: 'Coordinator WebDriver connection failed', stacktrace: ''}}))
        }
      })
      outgoing.once('close', () => remote.destroy())
      remote.end(payload)
    })
    incoming.on('error', () => outgoing.destroy())
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const close = async(error?: Error) => {
    if (stopped) return
    stopped = true
    for (const request of upstreams) request.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (error) done.reject(error)
    else done.resolve()
  }
  server.on('error', () => void close(new RunnerError('Local Appium proxy failed')))
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new RunnerError('Cannot open the local Appium proxy')))
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new RunnerError('Cannot determine the local Appium port')
  return {url: `http://127.0.0.1:${address.port}`, closed: done.closed, close: () => close()}
}

/** One ADB smart-socket TCP client maps to one fenced, authenticated WebSocket. */
export async function maestroProxy(client: CoordinatorClient, lease: Lease, localPort = 5037): Promise<LocalTransport> {
  const done = completion()
  const pairs = new Set<{socket: net.Socket, ws: WebSocket}>()
  let stopped = false
  const url = client.endpoint(lease.connection.path)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const server = net.createServer(socket => {
    socket.pause()
    socket.setNoDelay(true)
    const ws = new WebSocket(url, {headers: client.headers(), ca: client.ca,
      rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 15000,
      maxPayload: 1024 * 1024, perMessageDeflate: false})
    const pair = {socket, ws}
    pairs.add(pair)
    let alive = true
    let disposed = false
    const heartbeat = setInterval(() => {
      if (!alive) {
        void close(new RunnerError('Coordinator ADB stream heartbeat timed out'))
        return
      }
      alive = false
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 15000)
    const dispose = () => {
      disposed = true
      clearInterval(heartbeat)
      pairs.delete(pair)
      socket.destroy()
      ws.terminate()
    }
    socket.on('error', dispose)
    socket.once('close', dispose)
    ws.on('pong', () => { alive = true })
    ws.once('open', () => socket.resume())
    ws.once('close', code => {
      clearInterval(heartbeat)
      if (!stopped && !disposed && code !== 1000) {
        void close(new RunnerError('Coordinator ADB stream was revoked or interrupted'))
        return
      }
      socket.end()
    })
    ws.once('error', () => {
      dispose()
      void close(new RunnerError('Coordinator ADB stream failed; device commands are disabled'))
    })
    socket.on('data', chunk => {
      socket.pause()
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > maxBuffer) { dispose(); return }
      ws.send(chunk, {binary: true}, error => {
        if (error) dispose()
        else if (!stopped) socket.resume()
      })
    })
    ws.on('message', (data, binary) => {
      if (!binary) {
        void close(new RunnerError('Coordinator returned a non-binary ADB stream'))
        return
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (socket.writableLength + chunk.length > maxBuffer) { dispose(); return }
      if (!socket.write(chunk)) ws.pause()
    })
    socket.on('drain', () => ws.resume())
  })
  const close = async(error?: Error) => {
    if (stopped) return
    stopped = true
    for (const {socket, ws} of pairs) { socket.destroy(); ws.terminate() }
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (error) done.reject(error)
    else done.resolve()
  }
  server.on('error', () => {
    if (server.listening) void close(new RunnerError('Local Maestro ADB proxy failed'))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(new RunnerError(error.code === 'EADDRINUSE' ?
      'Maestro requires an isolated CI pod: 127.0.0.1:5037 is occupied; the existing ADB server was left untouched' :
      'Cannot open the local Maestro ADB proxy')))
    server.listen(localPort, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new RunnerError('Cannot determine the local ADB proxy port')
  return {url: `tcp://127.0.0.1:${address.port}`, closed: done.closed, close: () => close()}
}
