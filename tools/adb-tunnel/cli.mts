#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {connectTunnel} from './client.mts'

const usage = `Usage:
  node tools/adb-tunnel/cli.mts connect SERIAL --server https://stf.finservice.tech \\
    --token-file /private/stf-token --adb /SDK/platform-tools/adb [--local-port 0] [--ca-file CA.pem]

The token file must have permissions 0600 on POSIX. STF_ACCESS_TOKEN may be used instead.
Use the SDK adb executable selected in Android Studio. Keep this process open; Ctrl+C disconnects.
`

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        server: {type: 'string'},
        'token-file': {type: 'string'},
        adb: {type: 'string'},
        'local-port': {type: 'string'},
        'ca-file': {type: 'string'},
        help: {type: 'boolean', short: 'h'}
      }
    })
  }
  catch {
    throw new Error('Invalid arguments. Run with --help for usage; access tokens belong in a file.')
  }
  if (args.values.help) {
    process.stdout.write(usage)
    return
  }
  if (args.positionals.length !== 2 || args.positionals[0] !== 'connect' || !args.values.server) {
    throw new Error('Provide connect SERIAL and --server. Run with --help for usage.')
  }
  const rawPort = args.values['local-port'] as string | undefined
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) {
    throw new Error('--local-port must be an integer between 0 and 65535')
  }
  const abort = new AbortController()
  let interrupted = false
  const stop = () => {
    interrupted = true
    abort.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const tunnel = await connectTunnel({
      serial: args.positionals[1]!,
      server: args.values.server as string,
      ...(args.values['token-file'] ? {tokenFile: args.values['token-file'] as string} : {}),
      ...(args.values.adb ? {adb: args.values.adb as string} : {}),
      ...(args.values['ca-file'] ? {caFile: args.values['ca-file'] as string} : {}),
      localPort: rawPort === undefined ? 0 : Number(rawPort),
      signal: abort.signal
    })
    process.stdout.write(`Connected ${tunnel.serial} as ${tunnel.endpoint}. Ctrl+C disconnects.\n`)
    await tunnel.closed
  }
  catch (error) {
    if (!interrupted) {
      throw error
    }
  }
  finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'STF connection failed'}\n`)
  process.exitCode = 1
})
