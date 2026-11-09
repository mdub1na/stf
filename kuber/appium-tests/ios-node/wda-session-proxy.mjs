import http from 'node:http'
import {realpathSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

/** Appium borrows the STF runtime's WDA session; it must never replace or delete it. */
export function createWdaSessionProxy({origin = 'http://127.0.0.1:18100', timeout = 45000} = {}) {
  let borrowed = null
  let attaching = false
  const call = async (method, path, body) => {
    const response = await fetch(origin + path, {
      method, signal: AbortSignal.timeout(timeout),
      ...(body ? {headers: {'Content-Type': 'application/json'}, body} : {})
    })
    return {status: response.status, body: Buffer.from(await response.arrayBuffer())}
  }
  const jsonCall = async (method, path, value) => {
    const result = await call(method, path, value === undefined ? undefined : JSON.stringify(value))
    const data = JSON.parse(result.body.toString())
    if (result.status >= 400 || data.value?.error) throw new Error('WDA request failed: ' + path)
    return data
  }
  const respond = (response, status, value) => {
    response.writeHead(status, {'Content-Type': 'application/json'})
    response.end(JSON.stringify(value))
  }
  return http.createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/'
      if (request.method === 'GET' && path === '/healthz') return respond(response, 200, {ready: true})
      if (request.method === 'POST' && path === '/session') {
        request.resume()
        if (borrowed || attaching) return respond(response, 409, {value: {error: 'session not created', message: 'WDA is already borrowed'}})
        attaching = true
        try {
          const status = await jsonCall('GET', '/status')
          if (!status.sessionId || !status.value?.ready) return respond(response, 503, {value: {error: 'session not created', message: 'STF WDA session is not ready'}})
          const id = status.sessionId
          const session = await jsonCall('GET', '/session/' + encodeURIComponent(id))
          const settings = await jsonCall('GET', '/session/' + encodeURIComponent(id) + '/appium/settings')
          borrowed = {id, settings: settings.value}
          return respond(response, 200, {sessionId: id, value: {
            sessionId: id, capabilities: session.value?.capabilities || session.value || {}
          }})
        } finally {
          attaching = false
        }
      }
      const deletion = request.method === 'DELETE' && /^\/session\/[^/]+$/.test(path)
      if (deletion) {
        if (!borrowed || path !== '/session/' + encodeURIComponent(borrowed.id)) {
          return respond(response, 404, {value: {error: 'invalid session id', message: 'Session is not borrowed'}})
        }
        const previous = borrowed
        try {
          await jsonCall('POST', '/session/' + encodeURIComponent(previous.id) + '/appium/settings', {settings: previous.settings})
        } finally {
          borrowed = null
        }
        return respond(response, 200, {value: null})
      }
      if (path === '/wda/shutdown') return respond(response, 403, {value: {error: 'unsupported operation', message: 'WDA lifecycle belongs to STF'}})
      if (path.startsWith('/session/')) {
        const id = path.split('/')[2]
        if (!borrowed || id !== encodeURIComponent(borrowed.id)) return respond(response, 404, {value: {error: 'invalid session id', message: 'Session is not borrowed'}})
      }
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) return respond(response, 413, {value: {error: 'invalid argument', message: 'Request is too large'}})
        chunks.push(chunk)
      }
      const result = await call(request.method, request.url, size ? Buffer.concat(chunks) : undefined)
      response.writeHead(result.status, {'Content-Type': 'application/json'})
      response.end(result.body)
    } catch {
      if (!response.headersSent) respond(response, 502, {value: {error: 'unknown error', message: 'STF WDA is unavailable'}})
      else response.destroy()
    }
  })
}

// ConfigMap files are symlinks; Node resolves import.meta.url to their real path.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const server = createWdaSessionProxy()
  server.listen(Number(process.env.WDA_PROXY_PORT ?? 18101), '127.0.0.1', () => {
    console.log('WDA session adapter listening on loopback:' + server.address().port)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
}
