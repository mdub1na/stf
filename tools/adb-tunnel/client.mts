import {execFile} from 'node:child_process'
import {constants} from 'node:fs'
import {access, open, readFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import WebSocket from 'ws'
import {originUrl} from './types.mts'
import type {GatewaySession} from './types.mts'

const execFileAsync = promisify(execFile)
const maxBufferedBytes = 1024 * 1024
const localAdbArgs = ['-H', '127.0.0.1', '-P', '5037']

export interface ConnectTunnelOptions {
  server: string
  serial: string
  token?: string
  tokenFile?: string
  adb?: string
  localPort?: number
  caFile?: string
  connectTimeoutMs?: number
  signal?: AbortSignal
  runAdb?: (args: string[]) => Promise<void>
}

export interface TunnelConnection {
  serial: string
  endpoint: string
  sessionId: string
  closed: Promise<void>
  close(): Promise<void>
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Connection cancelled')
  }
}

async function readToken(options: ConnectTunnelOptions): Promise<string> {
  if (options.tokenFile && options.token) {
    throw new Error('Use either a token file or an in-memory token')
  }
  let token = options.token
  if (options.tokenFile) {
    let file
    try {
      file = await open(options.tokenFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16384) {
        throw new Error('Invalid token file')
      }
      if (process.platform !== 'win32' &&
          ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())) {
        throw new Error('Token file must belong to you and have permissions 0600')
      }
      token = await file.readFile('utf8')
    }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Token file must')) {
        throw error
      }
      throw new Error('Cannot read a private token file')
    }
    finally {
      await file?.close()
    }
  }
  else if (!token) {
    token = process.env.STF_ACCESS_TOKEN
  }
  token = token?.trim()
  if (!token || token.length > 16384 || /\s/.test(token)) {
    throw new Error('Provide --token-file or STF_ACCESS_TOKEN with a valid STF access token')
  }
  return token
}

function requestJson(
  url: URL,
  method: 'POST' | 'DELETE',
  token: string,
  body: unknown,
  ca: Buffer | undefined,
  timeout: number,
  signal?: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method,
      ca,
      rejectUnauthorized: true,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(payload ? {'Content-Type': 'application/json'} : {})
      }
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`STF gateway rejected ${method} (HTTP ${response.statusCode ?? 0})`))
        return
      }
      let received = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > 65536) {
          response.destroy()
          reject(new Error('Invalid STF gateway response'))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', () => reject(new Error('STF gateway response was interrupted')))
      response.once('end', () => {
        if (method === 'DELETE') {
          resolve(undefined)
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        }
        catch {
          reject(new Error('Invalid STF gateway response'))
        }
      })
    })
    const deadline = setTimeout(() => request.destroy(new Error('timeout')), timeout)
    request.once('close', () => clearTimeout(deadline))
    request.once('error', () => {
      reject(new Error(signal?.aborted ? 'Connection cancelled' :
        'Cannot establish a verified connection to the STF gateway'))
    })
    request.end(payload)
  })
}

function validateSession(value: unknown, server: URL, serial: string): GatewaySession {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid STF gateway session')
  }
  const session = value as GatewaySession
  for (const name of ['id', 'serial', 'websocketUrl', 'ticket', 'controlToken', 'expiresAt', 'sessionExpiresAt'] as const) {
    if (typeof session[name] !== 'string' || !session[name] || session[name].length > 16384) {
      throw new Error('Invalid STF gateway session')
    }
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(session.id) || session.serial !== serial ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(session.sessionExpiresAt)) ||
      Date.parse(session.sessionExpiresAt) < Date.parse(session.expiresAt) ||
      /\s/.test(session.ticket) || /\s/.test(session.controlToken)) {
    throw new Error('Invalid STF gateway session')
  }
  let stream: URL
  try {
    stream = new URL(session.websocketUrl)
  }
  catch {
    throw new Error('Invalid STF gateway stream address')
  }
  const protocol = server.protocol === 'https:' ? 'wss:' : 'ws:'
  if (stream.protocol !== protocol || stream.host !== server.host || stream.username ||
      stream.password || stream.search || stream.hash ||
      stream.pathname !== `/adb-tunnel/v1/sessions/${session.id}/stream`) {
    throw new Error('STF gateway returned an unexpected stream address')
  }
  return session
}

async function resolveAdb(explicit?: string): Promise<string> {
  const name = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
  let candidate = explicit
  if (!candidate && sdk) {
    candidate = join(sdk, 'platform-tools', name)
  }
  if (!candidate) {
    const platformSdk = process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') :
      process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'Android', 'Sdk') :
        join(homedir(), 'Android', 'Sdk')
    candidate = join(platformSdk, 'platform-tools', name)
  }
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  }
  catch {
    throw new Error('Select the Android Studio SDK executable with --adb')
  }
  return candidate
}

function adbEnvironment(): NodeJS.ProcessEnv {
  const env = {...process.env}
  delete env.ADB_SERVER_SOCKET
  delete env.ANDROID_ADB_SERVER_ADDRESS
  delete env.ANDROID_ADB_SERVER_PORT
  delete env.STF_ACCESS_TOKEN
  return env
}

async function localServerVersion(): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: '127.0.0.1', port: 5037})
    let data = Buffer.alloc(0)
    let done = false
    const finish = (error?: Error, version?: number) => {
      if (done) {
        return
      }
      done = true
      socket.destroy()
      if (error) {
        reject(error)
      }
      else {
        resolve(version)
      }
    }
    socket.setTimeout(2000, () => finish(new Error('Cannot inspect the local ADB server')))
    socket.once('connect', () => socket.write('000chost:version'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? undefined :
        new Error('Cannot inspect the local ADB server'))
    })
    socket.once('close', () => {
      if (!done) {
        finish(new Error('Cannot inspect the local ADB server'))
      }
    })
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      if (data.length > 1024 || (data.length >= 4 && data.subarray(0, 4).toString() !== 'OKAY')) {
        finish(new Error('Cannot inspect the local ADB server'))
        return
      }
      if (data.length >= 8) {
        const sizeText = data.subarray(4, 8).toString()
        const size = /^[a-f0-9]{4}$/i.test(sizeText) ? parseInt(sizeText, 16) : 0
        if (!size || size > 16) {
          finish(new Error('Cannot inspect the local ADB server'))
          return
        }
        if (data.length >= 8 + size) {
          const text = data.subarray(8, 8 + size).toString()
          finish(/^[a-f0-9]+$/i.test(text) ? undefined :
            new Error('Cannot inspect the local ADB server'), parseInt(text, 16))
        }
      }
    })
  })
}

async function sdkRunner(
  adb: string,
  timeout: number,
  connectSignal: AbortSignal
): Promise<(args: string[]) => Promise<void>> {
  const env = adbEnvironment()
  let versionText: string
  try {
    versionText = (await execFileAsync(adb, ['version'], {
      env, timeout, maxBuffer: 65536, windowsHide: true, signal: connectSignal
    })).stdout
  }
  catch {
    throw new Error('Cannot run the selected SDK adb executable')
  }
  const version = /Android Debug Bridge version \d+\.\d+\.(\d+)/.exec(versionText)
  if (!version) {
    throw new Error('Cannot determine the selected SDK adb version')
  }
  const serverVersion = await localServerVersion()
  if (serverVersion !== undefined && serverVersion !== Number(version[1])) {
    throw new Error('ADB server version differs; use --adb from the Android Studio SDK')
  }
  return async args => {
    const connecting = args[localAdbArgs.length] === 'connect'
    if (connecting) cancelled(connectSignal)
    const currentVersion = await localServerVersion()
    if (connecting) cancelled(connectSignal)
    if (currentVersion !== undefined && currentVersion !== Number(version[1])) {
      throw new Error('ADB server version differs; use --adb from the Android Studio SDK')
    }
    if (args[localAdbArgs.length] === 'disconnect' && currentVersion === undefined) {
      return
    }
    try {
      const result = await execFileAsync(adb, args, {
        env, timeout: connecting ? timeout : Math.min(timeout, 3000),
        maxBuffer: 65536, windowsHide: true,
        ...(connecting ? {signal: connectSignal} : {})
      })
      if (args[localAdbArgs.length] === 'connect' &&
          !result.stdout.split(/\r?\n/).some(line =>
            line === `connected to ${args[args.length - 1]}` ||
            line === `already connected to ${args[args.length - 1]}`)) {
        throw new Error('connect failed')
      }
    }
    catch {
      throw new Error('SDK adb could not complete the requested connection')
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ADB tunnel connection timed out')), timeout)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export async function connectTunnel(options: ConnectTunnelOptions): Promise<TunnelConnection> {
  const server = originUrl(options.server, 'STF server')
  const timeout = options.connectTimeoutMs ?? 15000
  const port = options.localPort ?? 0
  if (!options.serial || options.serial.length > 1024 || /\p{Cc}|\p{Cf}/u.test(options.serial) ||
      !Number.isInteger(port) ||
      port < 0 || port > 65535 || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Provide a device serial, a valid local port, and a positive timeout')
  }
  cancelled(options.signal)
  const token = await readToken(options)
  const ca = options.caFile ? await readFile(options.caFile) : undefined
  const connectAbort = new AbortController()
  const connectSignal = options.signal ? AbortSignal.any([options.signal, connectAbort.signal]) :
    connectAbort.signal
  const runAdb = options.runAdb ?? await sdkRunner(
    await resolveAdb(options.adb), timeout, connectSignal
  )
  cancelled(options.signal)
  const sessionsUrl = new URL('/adb-tunnel/v1/sessions', server)
  const response = await requestJson(
    sessionsUrl, 'POST', token, {serial: options.serial}, ca, timeout, options.signal
  )
  let session: GatewaySession
  try {
    session = validateSession(response, server, options.serial)
  }
  catch (error) {
    const invalid = response as Partial<GatewaySession> | undefined
    if (invalid && typeof invalid.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(invalid.id) &&
        typeof invalid.controlToken === 'string' && invalid.controlToken.length <= 16384 &&
        invalid.controlToken && !/\s/.test(invalid.controlToken)) {
      await requestJson(new URL(`${sessionsUrl.pathname}/${invalid.id}`, server),
        'DELETE', invalid.controlToken, undefined, ca, 5000).catch(() => {})
    }
    throw error
  }
  const controlUrl = new URL(`${sessionsUrl.pathname}/${session.id}`, server)
  let listener: net.Server | undefined
  let local: net.Socket | undefined
  let ws: WebSocket | undefined
  let endpoint = ''
  let attemptedAdb = false
  let adbConnect: Promise<void> | undefined
  let finished = false
  let cleanup: Promise<void> | undefined
  let expiry: NodeJS.Timeout | undefined
  let resolveClosed: () => void
  let rejectClosed: (error: Error) => void
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  // Setup may fail before the caller receives the connection and its completion promise.
  void closed.catch(() => {})
  const finish = (error?: Error): Promise<void> => {
    if (cleanup) {
      return cleanup
    }
    finished = true
    connectAbort.abort()
    clearTimeout(expiry)
    options.signal?.removeEventListener('abort', onAbort)
    local?.destroy()
    listener?.close()
    ws?.terminate()
    cleanup = (async () => {
      if (adbConnect) {
        await withTimeout(adbConnect, 2500).catch(() => {})
      }
      if (attemptedAdb && endpoint) {
        await withTimeout(Promise.resolve().then(() =>
          runAdb([...localAdbArgs, 'disconnect', endpoint])), 5000).catch(() => {})
      }
      await requestJson(controlUrl, 'DELETE', session.controlToken, undefined, ca, 5000)
        .catch(() => {})
      if (error) {
        rejectClosed(error)
      }
      else {
        resolveClosed()
      }
    })()
    return cleanup
  }
  const onAbort = () => void finish(new Error('Connection cancelled'))
  options.signal?.addEventListener('abort', onAbort, {once: true})
  let acceptLocal: () => void
  const accepted = new Promise<void>(resolve => {
    acceptLocal = resolve
  })
  const pending: Buffer[] = []
  let pendingBytes = 0
  let draining = false
  const flush = () => {
    if (!local || draining || finished) {
      return
    }
    while (pending.length) {
      const chunk = pending.shift()!
      pendingBytes -= chunk.length
      if (!local.write(chunk)) {
        draining = true
        ws?.pause()
        return
      }
    }
    ws?.resume()
  }
  try {
    cancelled(options.signal)
    ws = new WebSocket(session.websocketUrl, {
      headers: {Authorization: `Bearer ${session.ticket}`},
      ca,
      rejectUnauthorized: true,
      followRedirects: false,
      handshakeTimeout: timeout,
      maxPayload: maxBufferedBytes,
      perMessageDeflate: false
    })
    ws.on('error', () => void finish(new Error('Cannot establish a verified STF tunnel stream')))
    ws.on('close', () => {
      if (!finished) {
        void finish(new Error('STF tunnel stream closed; select the device again to reconnect'))
      }
    })
    ws.on('message', (data, binary) => {
      if (!binary) {
        void finish(new Error('STF tunnel returned an invalid stream frame'))
        return
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      pendingBytes += chunk.length
      if (pendingBytes > maxBufferedBytes) {
        void finish(new Error('STF tunnel exceeded its buffering limit'))
        return
      }
      pending.push(chunk)
      flush()
    })
    await withTimeout(Promise.race([
      new Promise<void>((resolve, reject) => {
        ws!.once('open', resolve)
        ws!.once('error', () => reject(new Error('Cannot establish a verified STF tunnel stream')))
        ws!.once('close', () => reject(new Error('STF tunnel stream closed during connection')))
      }),
      closed.then(() => { throw new Error('STF tunnel closed during connection') })
    ]), timeout)
    expiry = setTimeout(() => void finish(new Error('STF tunnel session expired')),
      Math.min(Date.parse(session.sessionExpiresAt) - Date.now(), 2147483647))
    cancelled(options.signal)
    if (finished) {
      await closed
      throw new Error('STF tunnel closed during connection')
    }
    listener = net.createServer(socket => {
      if (local || finished) {
        socket.destroy()
        return
      }
      local = socket
      listener?.close()
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 10000)
      socket.pause()
      socket.on('error', () => void finish(new Error('Local ADB connection failed')))
      socket.on('close', () => {
        if (!finished) {
          void finish(new Error('Local ADB connection closed'))
        }
      })
      socket.on('drain', () => {
        draining = false
        flush()
      })
      socket.on('data', chunk => {
        socket.pause()
        if (ws?.readyState !== WebSocket.OPEN) {
          void finish(new Error('STF tunnel is no longer connected'))
          return
        }
        ws.send(chunk, {binary: true}, error => {
          if (error) {
            void finish(new Error('STF tunnel stream failed'))
          }
          else if (!finished) {
            socket.resume()
          }
        })
      })
      acceptLocal()
      flush()
      socket.resume()
    })
    listener.on('error', () => void finish(new Error('Cannot open the local ADB listener')))
    await withTimeout(Promise.race([
      new Promise<void>((resolve, reject) => {
        listener!.once('error', () => reject(new Error('Cannot open the local ADB listener')))
        listener!.listen(port, '127.0.0.1', () => {
          const address = listener!.address()
          if (finished || !address || typeof address === 'string') {
            reject(new Error('STF tunnel closed during connection'))
            return
          }
          endpoint = `127.0.0.1:${address.port}`
          resolve()
        })
      }),
      closed.then(() => { throw new Error('STF tunnel closed during connection') })
    ]), timeout)
    cancelled(options.signal)
    if (finished) {
      await closed
      throw new Error('STF tunnel closed during connection')
    }
    attemptedAdb = true
    adbConnect = Promise.resolve().then(() => {
      if (finished) throw new Error('STF tunnel closed during connection')
      return runAdb([...localAdbArgs, 'connect', endpoint])
    })
    await withTimeout(Promise.race([
      adbConnect.catch(() => {
        throw new Error('SDK adb could not connect to the device')
      }).then(() => accepted),
      closed.then(() => { throw new Error('STF tunnel closed during connection') })
    ]), timeout)
    if (finished) {
      await closed
      throw new Error('STF tunnel closed during connection')
    }
    return {serial: session.serial, endpoint, sessionId: session.id, closed,
      close: () => finish()}
  }
  catch (error) {
    const safeError = error instanceof Error ? error : new Error('Cannot connect the STF tunnel')
    await finish(safeError)
    throw safeError
  }
}
