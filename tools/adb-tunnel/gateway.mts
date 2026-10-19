import http, {type IncomingMessage, type ServerResponse} from 'node:http'
import net, {type Socket} from 'node:net'
import {randomBytes, timingSafeEqual} from 'node:crypto'
import type {Duplex, Transform} from 'node:stream'
import {WebSocket, WebSocketServer, createWebSocketStream} from 'ws'
import {createAdbGuard} from './adb-guard.mts'
import {HttpError, originUrl, type Access, type Target} from './types.mts'

interface GatewayOptions {
  access: Access
  publicUrl: string
  prefix?: string
  pollMs?: number
  ticketTtlMs?: number
  sessionTtlMs?: number
  maxSessions?: number
}

interface Session {
  id: string
  token: string
  target: Target
  ticket: string
  controlToken: string
  state: 'pending' | 'claimed' | 'active' | 'closed'
  expiresAt: number
  deadline: number
  timers: ReturnType<typeof setTimeout>[]
  tcp?: Socket
  ws?: WebSocket
  stream?: Duplex
  guard?: Transform
  handshake?: Duplex
}

const ACCESS_TIMEOUT_MS = 5000
const CONNECT_TIMEOUT_MS = 5000
const MAX_BODY_BYTES = 8192
const MAX_WS_PAYLOAD = 1024 * 1024

function secret() {
  return randomBytes(32).toString('base64url')
}

function equalSecret(actual: string, expected: string) {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearer(req: IncomingMessage) {
  const header = req.headers.authorization
  if (!header || header.length > 4096 || !/^Bearer [^\s]+$/.test(header)) {
    throw new HttpError(401, 'A Bearer credential is required')
  }
  return header.slice(7)
}

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HttpError(504, 'Authorization timed out')), milliseconds)
      timer.unref()
    })
  ]).finally(() => clearTimeout(timer))
}

async function authorize<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  try {
    return await bounded(operation(controller.signal), ACCESS_TIMEOUT_MS)
  }
  finally {
    controller.abort()
  }
}

function respond(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(JSON.stringify(value))
}

function errorResponse(res: ServerResponse, error: unknown) {
  res.setHeader('Connection', 'close')
  respond(res, error instanceof HttpError ? error.status : 502, {
    error: error instanceof HttpError ? error.message : 'STF authorization unavailable'
  })
}

async function readBody(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new HttpError(408, 'Request body timed out')), 5000)
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAbort)
      if (error) {
        req.pause()
        reject(error)
      }
      else resolve()
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) finish(new HttpError(413, 'Request body is too large'))
      else chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => finish()
    const onError = () => finish(new HttpError(400, 'Invalid request body'))
    const onAbort = () => finish(new HttpError(400, 'Request was aborted'))
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAbort)
  })
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('object required')
    }
    const serial = (body as Record<string, unknown>).serial
    if (typeof serial !== 'string' || serial.length === 0 || serial.length > 256 || /[\x00-\x1f]/.test(serial)) {
      throw new Error('serial required')
    }
    return serial
  }
  catch {
    throw new HttpError(400, 'A device serial is required')
  }
}

export function createGateway(options: GatewayOptions) {
  const publicUrl = originUrl(options.publicUrl, 'publicUrl')
  const prefix = options.prefix ?? '/adb-tunnel'
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.endsWith('/')) {
    throw new Error('Invalid gateway path prefix')
  }
  const pollMs = options.pollMs ?? 2000
  const ticketTtlMs = options.ticketTtlMs ?? 30000
  const sessionTtlMs = options.sessionTtlMs ?? 3600000
  const maxSessions = options.maxSessions ?? 128
  if (![pollMs, ticketTtlMs, sessionTtlMs, maxSessions].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Gateway limits must be positive integers')
  }
  const sessionsPath = `${prefix}/v1/sessions`
  const sessions = new Map<string, Session>()
  const sockets = new Set<Socket>()
  const wss = new WebSocketServer({noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false})
  let opening = 0
  let closing = false

  function closeSession(session: Session, destroyHandshake = true) {
    if (session.state === 'closed') return
    session.state = 'closed'
    sessions.delete(session.id)
    session.token = ''
    session.ticket = ''
    session.controlToken = ''
    session.timers.forEach(timer => clearTimeout(timer))
    session.guard?.destroy()
    session.stream?.destroy()
    session.ws?.terminate()
    session.tcp?.destroy()
    if (destroyHandshake) session.handshake?.destroy()
  }

  function validateOrigin(req: IncomingMessage) {
    if (req.headers.origin !== undefined && req.headers.origin !== publicUrl.origin) {
      throw new HttpError(403, 'Origin is not allowed')
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (closing) throw new HttpError(503, 'Gateway is shutting down')
      validateOrigin(req)
      const url = new URL(req.url ?? '/', 'http://gateway.invalid')
      if (url.search) throw new HttpError(400, 'Query parameters are not accepted')
      if (req.method === 'GET' && url.pathname === '/healthz') {
        respond(res, 200, {status: 'ok'})
        return
      }
      if (req.method === 'POST' && url.pathname === sessionsPath) {
        const token = bearer(req)
        if (sessions.size + opening >= maxSessions) throw new HttpError(503, 'Session limit reached')
        opening++
        try {
          const serial = await readBody(req)
          const target = await authorize(signal => options.access.open(token, serial, signal))
          if (closing || req.aborted || res.destroyed) throw new HttpError(503, 'Request is no longer available')
          const now = Date.now()
          const session: Session = {
            id: secret(), token, target, ticket: secret(), controlToken: secret(), state: 'pending',
            expiresAt: now + Math.min(ticketTtlMs, sessionTtlMs), deadline: now + sessionTtlMs, timers: []
          }
          sessions.set(session.id, session)
          session.timers.push(setTimeout(() => {
            if (session.state === 'pending' || session.state === 'claimed') closeSession(session)
          }, session.expiresAt - now))
          session.timers.push(setTimeout(() => closeSession(session), sessionTtlMs))
          const websocketUrl = new URL(`${sessionsPath}/${session.id}/stream`, publicUrl)
          websocketUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'
          respond(res, 201, {
            id: session.id, serial: target.serial, websocketUrl: websocketUrl.href,
            ticket: session.ticket, controlToken: session.controlToken,
            expiresAt: new Date(session.expiresAt).toISOString(),
            sessionExpiresAt: new Date(session.deadline).toISOString()
          })
        }
        finally {
          opening--
        }
        return
      }
      if (req.method === 'DELETE' && url.pathname.startsWith(`${sessionsPath}/`)) {
        const id = url.pathname.slice(sessionsPath.length + 1)
        const session = sessions.get(id)
        if (!session || !equalSecret(bearer(req), session.controlToken)) {
          throw new HttpError(404, 'Session not found')
        }
        closeSession(session)
        respond(res, 200, {closed: true})
        return
      }
      throw new HttpError(404, 'Route not found')
    }
    catch (error) {
      if (!res.destroyed && !res.headersSent) errorResponse(res, error)
    }
  })

  server.headersTimeout = 5000
  server.requestTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxConnections = maxSessions * 4 + 32
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  function rejectUpgrade(socket: Duplex, error: unknown) {
    if (socket.destroyed) return
    const status = error instanceof HttpError ? error.status : 502
    const description = http.STATUS_CODES[status] ?? 'Error'
    socket.end(`HTTP/1.1 ${status} ${description}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`)
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    let session: Session | undefined
    let claimed = false
    try {
      validateOrigin(req)
      const url = new URL(req.url ?? '/', 'http://gateway.invalid')
      const pathStart = `${sessionsPath}/`
      if (closing || req.method !== 'GET' || url.search || !url.pathname.startsWith(pathStart) || !url.pathname.endsWith('/stream')) {
        throw new HttpError(404, 'Stream not found')
      }
      if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
          !/^[+/0-9A-Za-z]{22}==$/.test(String(req.headers['sec-websocket-key'] ?? ''))) {
        throw new HttpError(400, 'A valid WebSocket upgrade is required')
      }
      const id = url.pathname.slice(pathStart.length, -'/stream'.length)
      session = sessions.get(id)
      if (!session || session.state !== 'pending' || Date.now() >= session.expiresAt || !equalSecret(bearer(req), session.ticket)) {
        throw new HttpError(401, 'Ticket is invalid or has already been used')
      }
      // Consume before the first await: two upgrades can never share one ticket.
      session.state = 'claimed'
      session.ticket = ''
      session.handshake = socket
      claimed = true
      const current = session
      socket.once('close', () => closeSession(current))
      const checked = session
      await authorize(signal => options.access.check(checked.token, checked.target, signal))
      if (!sessions.has(session.id) || socket.destroyed) throw new HttpError(410, 'Session has ended')
      const tcp = net.createConnection({host: session.target.host, port: session.target.port})
      session.tcp = tcp
      tcp.on('error', () => closeSession(current))
      tcp.once('close', () => closeSession(current))
      await bounded(new Promise<void>((resolve, reject) => {
        tcp.once('connect', resolve)
        tcp.once('error', reject)
      }), CONNECT_TIMEOUT_MS)
      if (!sessions.has(session.id) || socket.destroyed) throw new HttpError(410, 'Session has ended')
      tcp.setNoDelay(true)
      wss.handleUpgrade(req, socket, head, ws => {
        if (current.state === 'closed') {
          ws.terminate()
          return
        }
        current.state = 'active'
        delete current.handshake
        current.ws = ws
        let alive = true
        let checking = false
        ws.on('pong', () => { alive = true })
        ws.on('error', () => closeSession(current))
        ws.once('close', () => closeSession(current))
        ws.on('message', (_data, binary) => {
          if (!binary) closeSession(current)
        })
        const stream = createWebSocketStream(ws, {highWaterMark: 64 * 1024})
        const guard = createAdbGuard()
        current.stream = stream
        current.guard = guard
        stream.on('error', () => closeSession(current))
        guard.on('error', () => closeSession(current))
        stream.pipe(guard).pipe(tcp)
        tcp.pipe(stream)
        current.timers.push(setInterval(() => {
          if (!alive) {
            closeSession(current)
            return
          }
          alive = false
          ws.ping()
        }, 10000))
        current.timers.push(setInterval(() => {
          if (checking || current.state !== 'active') return
          checking = true
          authorize(signal => options.access.check(current.token, current.target, signal))
            .catch(() => closeSession(current))
            .finally(() => { checking = false })
        }, pollMs))
      })
    }
    catch (error) {
      // A failed competing upgrade must not revoke the legitimate connection.
      rejectUpgrade(socket, error)
      if (claimed && session) closeSession(session, false)
    }
  }
  server.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head) })

  return {
    server,
    async close() {
      closing = true
      for (const session of sessions.values()) closeSession(session)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => {
        wss.close(() => resolve())
      })
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  }
}
