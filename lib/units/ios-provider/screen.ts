import http from 'node:http'
import {WebSocketServer, WebSocket} from 'ws'
import {authorizeScreen, type IosOwner} from './access.js'
import {MjpegDecoder} from './mjpeg.js'
import type {PrototypeClient} from './client.js'
import {CoreDeviceScreenDecoder} from './coredevice-screen.js'

interface ScreenStream {
  controller: AbortController
  native: boolean
  sessionId?: string
  releaseInput?: () => void
  failover?: (error: unknown) => void
  lastKeyframeRequest: number
}

const maxBufferedBytes = 1024 * 1024

export function createScreenServer(options: {
  client: PrototypeClient
  apiUrl: string
  publicOrigin: string
  serial: string
  owner: () => IosOwner | null
  coreDevice?: {
    available: () => boolean
    connectInput: (
      sessionId: string, signal: AbortSignal, fail: (error: unknown) => void
    ) => (() => void) | undefined
  }
  onError?: (error: unknown) => void
}) {
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end()
  })
  const sockets = new WebSocketServer({noServer: true, maxPayload: 1024})
  sockets.on('error', error => {
    options.onError?.(error)
  })
  server.on('upgrade', (req, socket, head) => {
    const owner = options.owner()
    const deadline = setTimeout(() => socket.destroy(), 6000)
    authorizeScreen(options.apiUrl, options.publicOrigin, options.serial, owner, req.headers)
      .then(allowed => {
        clearTimeout(deadline)
        if (socket.destroyed || !allowed || !owner || options.owner() !== owner ||
            req.url !== '/') {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          return
        }
        sockets.handleUpgrade(req, socket, head, ws => {
          let stream: ScreenStream | null = null
          let alive = true
          let acceptsHevc = false
          ws.on('pong', () => {
            alive = true
          })
          const stop = () => {
            const previous = stream
            stream = null
            previous?.controller.abort()
            previous?.releaseInput?.()
          }
          const authorized = () => options.owner() === owner
          const receiving = (active: ScreenStream) =>
            stream === active && authorized() && ws.readyState === WebSocket.OPEN
          const keyframe = (active: ScreenStream) => {
            const now = performance.now()
            if (active.sessionId && now - active.lastKeyframeRequest >= 1000) {
              active.lastKeyframeRequest = now
              const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(2000)])
              const body = {sessionId: active.sessionId}
              options.client.request('/coredevice/keyframe', body, signal)
                .then(response => response.arrayBuffer()).catch(() => {})
            }
          }
          const start = async(native = false) => {
            if (stream || !authorized()) {
              return
            }
            const active: ScreenStream = {
              controller: new AbortController(), native, lastKeyframeRequest: -Infinity
            }
            const signal = active.controller.signal
            stream = active
            active.failover = error => {
              if (receiving(active)) {
                options.onError?.(error)
                downgrade()
              }
            }
            try {
              if (native) {
                const allowed = await authorizeScreen(
                  options.apiUrl, options.publicOrigin, options.serial, owner, req.headers, true
                )
                if (!receiving(active)) {
                  return
                }
                if (!allowed) {
                  downgrade()
                  return
                }
                await hevc(active)
              }
              else {
                await mjpeg(active)
              }
              if (receiving(active)) {
                throw new Error('Screen stream ended')
              }
            }
            catch (error) {
              if (receiving(active)) {
                if (native) {
                  active.failover(error)
                }
                else {
                  options.onError?.(error)
                  ws.close(1011, 'Screen unavailable')
                }
              }
            }
            finally {
              if (stream === active) {
                stop()
              }
              else if (!signal.aborted) {
                active.controller.abort()
              }
            }
          }
          const downgrade = () => {
            acceptsHevc = false
            if (stream?.native) {
              stop()
            }
            ws.send('mjpeg')
            start()
          }
          const mjpeg = async(active: ScreenStream) => {
            const {signal} = active.controller
            const response = await options.client.request('/screen', undefined, signal)
            const contentType = response.headers.get('content-type')
            if (!contentType?.startsWith('multipart/x-mixed-replace') || !response.body) {
              throw new Error('Invalid screen stream')
            }
            const decoder = new MjpegDecoder()
            for await (const chunk of response.body) {
              if (!receiving(active)) {
                break
              }
              for (const frame of decoder.feed(chunk)) {
                // Drop frames for slow consumers instead of accumulating screen data.
                if (ws.bufferedAmount < maxBufferedBytes) {
                  ws.send(frame)
                }
              }
            }
          }
          const hevc = async(active: ScreenStream) => {
            const startup = new AbortController()
            const deadline = setTimeout(() => startup.abort(), 15000)
            const signal = AbortSignal.any([startup.signal, active.controller.signal])
            const response = await options.client.request('/coredevice/screen', undefined, signal)
              .finally(() => clearTimeout(deadline))
            const codec = response.headers.get('x-stf-hevc-codec')
            const description = response.headers.get('x-stf-hevc-description')
            const sessionId = response.headers.get('x-stf-coredevice-session')
            if (!response.body || !codec || !description || !sessionId ||
                !response.headers.get('content-type')?.startsWith('application/octet-stream')) {
              throw new Error('Invalid CoreDevice screen stream')
            }
            if (!receiving(active)) {
              return
            }
            active.sessionId = sessionId
            ws.send('hevc ' + JSON.stringify({codec, description}))
            const decoder = new CoreDeviceScreenDecoder()
            let needsKeyframe = true
            for await (const chunk of response.body) {
              if (!receiving(active)) {
                break
              }
              for (const unit of decoder.feed(chunk)) {
                if (ws.bufferedAmount >= maxBufferedBytes) {
                  needsKeyframe = true
                }
                else if (needsKeyframe && unit[0] === 1) {
                  keyframe(active)
                }
                else {
                  if (needsKeyframe) {
                    // Discard old reference frames after we skip packets.
                    unit[0] = 2
                  }
                  needsKeyframe = false
                  ws.send(unit)
                }
              }
            }
          }
          const timer = setInterval(() => {
            if (!alive) {
              ws.terminate()
              return
            }
            alive = false
            ws.ping()
            const requireReservationOwner = stream?.native
            authorizeScreen(
              options.apiUrl, options.publicOrigin, options.serial, owner, req.headers,
              requireReservationOwner
            ).then(allowedNow => {
              if (!allowedNow || !authorized()) {
                ws.close(1008, 'Device access ended')
              }
            })
          }, 5000)
          const cleanup = () => {
            clearInterval(timer)
            stop()
          }
          ws.on('error', err => {
            options.onError?.(err)
            cleanup()
          })
          ws.on('close', () => {
            cleanup()
          })
          ws.on('message', data => {
            if (!authorized()) {
              ws.close(1008, 'Device access ended')
              return
            }
            const message = data.toString()
            if (message === 'hevc' && !stream) {
              acceptsHevc = true
            }
            else if (message === 'on') {
              start(acceptsHevc && options.coreDevice?.available() === true)
            }
            else if (message === 'hevc ready' && stream?.sessionId && !stream.releaseInput) {
              const release = options.coreDevice?.connectInput(
                stream.sessionId, stream.controller.signal, stream.failover!)
              if (release) {
                stream.releaseInput = release
              }
              else {
                downgrade()
              }
            }
            else if (message === 'hevc keyframe' && stream?.native) {
              keyframe(stream)
            }
            else if (message === 'mjpeg' && (acceptsHevc || stream?.native)) {
              downgrade()
            }
            else if (message === 'off') {
              stop()
            }
            else if (message === 'ping') {
              ws.send('pong')
            }
          })
          ws.send('start ' + JSON.stringify({quirks: {alwaysUpright: true}}))
        })
      }).catch(() => {
        clearTimeout(deadline)
        socket.destroy()
      })
  })
  const disconnect = () => {
    for (const ws of sockets.clients) {
      ws.terminate()
    }
  }
  return {server, disconnect, close: () => {
    disconnect()
    sockets.close()
    server.close()
  }}
}
