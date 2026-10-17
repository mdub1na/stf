import http from 'node:http'
import {once} from 'node:events'
import lifecycle from '../../util/lifecycle.js'
import logger from '../../util/logger.js'
import {HttpFarmBackend} from './backend.js'
import {secret, validateOptions} from './config.js'
import {Coordinator} from './engine.js'
import {createCoordinatorApp} from './http.js'
import {FileStateStore} from './state.js'
import type {CoordinatorOptions} from './types.js'

export default async function startCoordinator(options: CoordinatorOptions) {
  const pools = await validateOptions(options)
  const [stfToken, apiToken] = await Promise.all([
    secret(options.stfTokenFile), secret(options.apiTokenFile)
  ])
  const log = logger.createLogger('coordinator')
  const engine = new Coordinator(options, pools,
    new HttpFarmBackend(options.stfApiUrl, options.appiumGridUrl, stfToken,
      options.upstreamTimeoutSeconds * 1000), new FileStateStore(options.stateFile))
  const server = http.createServer(createCoordinatorApp(engine, apiToken))
  server.requestTimeout = (options.upstreamTimeoutSeconds + 10) * 1000
  server.listen(options.port, options.host)
  await once(server, 'listening')
  log.info('Coordinator HTTP endpoint started; recovering persistent leases')
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false
  lifecycle.shutdownTimeout = Math.max(lifecycle.shutdownTimeout, 110000)
  lifecycle.observe(async() => {
    if (timer) {
      clearInterval(timer)
    }
    await engine.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  try {
    await engine.start()
  }
  catch {
    server.closeAllConnections()
    server.close()
    throw new Error('Coordinator recovery failed; persistent state was preserved')
  }
  timer = setInterval(() => {
    if (!ticking) {
      ticking = true
      engine.tick().catch(() => log.error('Coordinator scheduling failed; inspect health status'))
        .finally(() => {
          ticking = false
        })
    }
  }, options.pollIntervalSeconds * 1000)
  log.info('Coordinator is ready')
  return {engine, server}
}
