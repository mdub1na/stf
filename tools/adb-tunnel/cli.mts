#!/usr/bin/env node
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {connectTunnel} from './client.mts'

const helpFlags = new Set(['--help', '-h'])
const mainUsage = `Usage: stf utils <command>

Farm utilities:
  stf utils adb connect SERIAL   Connect a reserved Android device to your local SDK adb.

Run stf utils adb connect --help for connection options.
Run stf --version to show the installed utilities version.
`
const utilsUsage = `Usage: stf utils <command>

Commands:
  adb     Android device connection utilities.

Run stf utils adb --help for available ADB commands.
`
const adbUsage = `Usage: stf utils adb <command>

Commands:
  connect SERIAL   Connect a reserved device through a verified HTTPS/WebSocket tunnel.

Run stf utils adb connect --help for connection options.
`
const connectUsage = `Usage:
  stf utils adb connect SERIAL --server https://stf.finservice.tech \\
    --token-file /private/stf-token --adb /SDK/platform-tools/adb [--local-port 0] [--ca-file CA.pem]

The token file must have permissions 0600 on POSIX. STF_ACCESS_TOKEN may be used instead.
Use the SDK adb executable selected in Android Studio. Keep this process open; Ctrl+C disconnects.
`

async function version(): Promise<string> {
  const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version)) {
    throw new Error('Cannot determine the installed STF utilities version')
  }
  return metadata.version
}

export async function main(argv: string[]): Promise<void> {
  if (!argv.length || (argv.length === 1 && helpFlags.has(argv[0]!))) {
    process.stdout.write(mainUsage)
    return
  }
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${await version()}\n`)
    return
  }
  if (argv[0] !== 'utils') {
    throw new Error('Unknown command. Run stf --help for usage.')
  }
  if (argv.length === 1 || (argv.length === 2 && helpFlags.has(argv[1]!))) {
    process.stdout.write(utilsUsage)
    return
  }
  if (argv[1] !== 'adb') {
    throw new Error('Unknown utilities command. Run stf utils --help for usage.')
  }
  if (argv.length === 2 || (argv.length === 3 && helpFlags.has(argv[2]!))) {
    process.stdout.write(adbUsage)
    return
  }
  if (argv[2] !== 'connect') {
    throw new Error('Unknown ADB command. Run stf utils adb --help for usage.')
  }
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({
      args: argv.slice(3),
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
    throw new Error('Invalid arguments. Run stf utils adb connect --help; access tokens belong in a file.')
  }
  if (args.values.help) {
    process.stdout.write(connectUsage)
    return
  }
  if (args.positionals.length !== 1 || !args.values.server) {
    throw new Error('Provide SERIAL and --server. Run stf utils adb connect --help for usage.')
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
      serial: args.positionals[0]!,
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

export function reportError(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : 'STF connection failed'}\n`)
  process.exitCode = 1
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  // The standalone and installed entry points use the public `stf utils` namespace.
  // Keep the direct module form available for local prototype verification scripts.
  const command = argv[0] === 'connect' ? ['utils', 'adb', ...argv] : argv
  main(command).catch(reportError)
}
