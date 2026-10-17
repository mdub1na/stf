import {createHash, timingSafeEqual} from 'node:crypto'
import express from 'express'
import type {ErrorRequestHandler} from 'express'
import {CoordinatorError} from './config.js'
import {Coordinator} from './engine.js'
import type {AllocationInput, CoordinatorOptions} from './types.js'

function authenticate(header: string | undefined, token: string) {
  let supplied = ''
  if (header?.startsWith('Bearer ')) {
    supplied = header.slice(7)
  }
  else if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString()
    if (decoded.startsWith('coordinator:')) {
      supplied = decoded.slice('coordinator:'.length)
    }
  }
  const hash = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(hash(supplied), hash(token))
}

function allocation(body: unknown, options: CoordinatorOptions): AllocationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CoordinatorError(400, 'invalid_request', 'Expected a JSON allocation request')
  }
  const value = body as Record<string, unknown>
  const keys = ['runId', 'platform', 'serial', 'model', 'provider', 'queueTimeoutSeconds'
    , 'maxDurationSeconds']
  if (Object.keys(value).some(key => !keys.includes(key)) ||
      !['Android', 'iOS'].includes(String(value.platform))) {
    throw new CoordinatorError(400, 'invalid_request', 'Unknown field or unsupported platform')
  }
  for (const key of ['runId', 'serial', 'model', 'provider']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' ||
        !(value[key] as string).trim() || (value[key] as string).length > 256)) {
      throw new CoordinatorError(400, 'invalid_request', 'Invalid allocation string field')
    }
  }
  if (!value.runId) {
    throw new CoordinatorError(400, 'invalid_request', 'runId is required')
  }
  const integer = (key: string, fallback: number) => {
    const number = value[key] ?? fallback
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 ||
        number > 86400) {
      throw new CoordinatorError(400, 'invalid_request', 'Invalid allocation timeout')
    }
    return number
  }
  const input: AllocationInput = {
    runId: value.runId as string, platform: value.platform as AllocationInput['platform']
  , queueTimeoutSeconds: integer('queueTimeoutSeconds', 3600)
  , maxDurationSeconds: integer('maxDurationSeconds', options.maxDurationSeconds)
  }
  if (input.maxDurationSeconds > options.maxDurationSeconds) {
    throw new CoordinatorError(400, 'duration_limit',
      'Requested duration exceeds coordinator limit')
  }
  for (const key of ['serial', 'model', 'provider'] as const) {
    if (value[key] !== undefined) {
      input[key] = value[key] as string
    }
  }
  return input
}

export function createCoordinatorApp(engine: Coordinator, token: string) {
  const app = express()
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.get('/healthz', (_req, res) => res.json({healthy: true}))
  app.get('/readyz', (_req, res) => res.status(engine.ready ? 200 : 503)
    .json({ready: engine.ready}))
  app.use('/api/v1', (req, res, next) => {
    if (!authenticate(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="STF coordinator"')
      res.status(401).json({error: {code: 'unauthorized', message: 'Authentication required'}})
      return
    }
    next()
  })
  app.use(express.json({limit: '1mb', strict: true}))
  app.get('/api/v1/status', (_req, res) => res.json(engine.status()))
  app.post('/api/v1/requests', async(req, res) => {
    const key = req.header('Idempotency-Key')
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new CoordinatorError(400, 'idempotency_required', 'Idempotency-Key is required')
    }
    const request = await engine.submit(allocation(req.body, engine.options), key)
    res.status(202).json({request})
  })
  app.get('/api/v1/requests/:id', (req, res) =>
    res.json({request: engine.requestView(req.params.id)}))
  app.delete('/api/v1/requests/:id', async(req, res) =>
    res.status(202).json({request: await engine.cancel(req.params.id)}))
  app.get('/api/v1/leases', (_req, res) => res.json({leases: engine.leasesView()}))
  app.get('/api/v1/leases/:id', (req, res) => res.json({lease: engine.leaseView(req.params.id)}))
  app.post('/api/v1/leases/:id/renew', async(req, res) =>
    res.json({lease: await engine.renew(req.params.id)}))
  app.delete('/api/v1/leases/:id', async(req, res) =>
    res.status(202).json({lease: await engine.release(req.params.id)}))
  app.post('/api/v1/leases/:id/recover', async(req, res) =>
    res.status(202).json({lease: await engine.recover(req.params.id)}))
  app.use('/api/v1/leases/:id/webdriver', async(req, res) => {
    const route = req.url.split('?')[0] || ''
    const parts = route.split('/').slice(1).map(part => decodeURIComponent(part))
    if (req.url.includes('?') || parts.some(part => part === '.' || part === '..' ||
        part.includes('%') ||
        part.includes('/') || part.includes('\\') ||
        [...part].some(character => character.charCodeAt(0) <= 32))) {
      throw new CoordinatorError(400, 'invalid_webdriver_path', 'Invalid WebDriver path')
    }
    const response = await engine.webdriver(String(req.params.id), req.method, route, req.body)
    res.status(response.status).type(response.contentType).send(response.body)
  })
  app.use((_req, res) => res.status(404)
    .json({error: {code: 'not_found', message: 'Route not found'}}))
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const known = error instanceof CoordinatorError
    let status = 500
    let code = 'internal_error'
    let message = 'Coordinator operation failed'
    if (known) {
      status = error.status
      code = error.code
      message = error.message
    }
    else if (error instanceof URIError || error instanceof SyntaxError) {
      status = 400
      code = 'invalid_request'
      message = 'Invalid request'
    }
    if (req.originalUrl.includes('/webdriver/')) {
      res.status(status).json({value: {
        error: status === 404 ? 'invalid session id' : 'unknown error'
      , message, stacktrace: ''}})
    }
    else {
      res.status(status).json({error: {code, message}})
    }
  }
  app.use(errors)
  return app
}
