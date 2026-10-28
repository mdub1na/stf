#!/usr/bin/env node
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {StfAccess} from './access.mts'
import {createGateway} from './gateway.mts'

export async function main(args = process.argv.slice(2)) {
  const {values} = parseArgs({
    args,
    options: {config: {type: 'string'}, listen: {type: 'string', default: '127.0.0.1:8080'}, help: {type: 'boolean'}},
    strict: true
  })
  if (values.help) {
    console.log('Usage: node tools/adb-tunnel/server.mts --config gateway.json [--listen 127.0.0.1:8080]')
    return
  }
  if (!values.config) throw new Error('--config is required')
  const config: unknown = JSON.parse(await readFile(values.config, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Gateway config must be an object')
  const data = config as Record<string, unknown>
  if (typeof data.stfUrl !== 'string' || typeof data.publicUrl !== 'string' ||
      !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) {
    throw new Error('Gateway config requires stfUrl, publicUrl and providers')
  }
  const providers: Record<string, {host: string; adbPorts: number[]}> = {}
  for (const [name, value] of Object.entries(data.providers)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid provider configuration')
    }
    const provider = value as Record<string, unknown>
    if (typeof provider.host !== 'string' || !provider.host || !Array.isArray(provider.adbPorts) ||
        provider.adbPorts.length === 0 || !provider.adbPorts.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535)) {
      throw new Error('Each provider requires a host and explicit adbPorts')
    }
    providers[name] = {host: provider.host, adbPorts: provider.adbPorts}
  }
  if (Object.keys(providers).length === 0) throw new Error('At least one provider is required')
  const listen = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(values.listen!)
  if (!listen) throw new Error('--listen must be host:port (use [::1]:port for IPv6)')
  const host = listen[1]!.replace(/^\[|\]$/g, '')
  const port = Number(listen[2])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listen port')
  const access = new StfAccess({stfUrl: data.stfUrl, providers})
  const gateway = createGateway({access, publicUrl: data.publicUrl})
  await new Promise<void>((resolve, reject) => {
    gateway.server.once('error', reject)
    gateway.server.listen(port, host, resolve)
  })
  console.log(`ADB tunnel gateway listening on ${host}:${port}`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void gateway.close().catch(() => { process.exitCode = 1 })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Gateway failed to start')
    process.exitCode = 1
  })
}
