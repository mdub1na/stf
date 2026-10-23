import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {parseArgs} from 'node:util'
import {runTest} from './run.mts'
import {RunnerError} from './types.mts'
import type {Allocation, Runner} from './types.mts'

const help = `Usage: stf utils test run --runner appium|maestro --platform Android|iOS [options] -- COMMAND [ARGS...]

The repository command runs with one coordinator lease and a private STF_CONNECTION_FILE.
Appium receives APPIUM_SERVER_URL and APPIUM_CAPABILITIES_JSON.
Maestro receives MAESTRO_DEVICE_ID and a leased ADB smart socket on 127.0.0.1:5037.

Options:
  --farm-url URL             Coordinator origin or /api/v1 endpoint (FARM_URL).
  --token-file FILE          Private farm token file (FARM_TOKEN_FILE or FARM_TOKEN).
  --runner RUNNER            appium or maestro; Maestro supports Android devices.
  --platform PLATFORM       Android or iOS.
  --serial SERIAL           Request one exact phone.
  --model MODEL             Filter by model.
  --provider PROVIDER       Filter by provider pool.
  --run-id ID               CI job/run identifier; generated if omitted.
  --queue-timeout SECONDS    Maximum wait for a phone (default 3600).
  --max-duration SECONDS     Absolute lease duration (default 21600).
  --cleanup-timeout SECONDS  Wait for confirmed cleanup (default 120).
  --ca-file FILE            Additional CA for a private HTTPS deployment.

Use a separate pod per worker. Never expose the farm's generic ADB server to jobs.
`

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 86400) {
    throw new RunnerError('Timeouts must be integer seconds between 1 and 86400')
  }
  return Number(value)
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--version') {
    const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
    process.stdout.write(`${metadata.version}\n`)
    return 0
  }
  const namespace = ['utils', 'test', 'run']
  if (argv.length < 3 && argv.every((part, index) => part === namespace[index]) ||
      argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) {
    process.stdout.write(help)
    return 0
  }
  if (argv[0] !== 'utils' || argv[1] !== 'test') throw new RunnerError('Unknown command. Run stf --help for usage.')
  if (argv[2] === '--help' || argv[2] === '-h') { process.stdout.write(help); return 0 }
  if (argv[2] !== 'run') throw new RunnerError('Unknown test command. Run stf utils test run --help for usage.')
  const separator = argv.indexOf('--', 3)
  const options = separator < 0 ? argv.slice(3) : argv.slice(3, separator)
  const command = separator < 0 ? [] : argv.slice(separator + 1)
  let parsed
  try {
    parsed = parseArgs({args: options, strict: true, options: {
      'farm-url': {type: 'string'}, 'token-file': {type: 'string'}, 'ca-file': {type: 'string'},
      runner: {type: 'string'}, platform: {type: 'string'}, serial: {type: 'string'},
      model: {type: 'string'}, provider: {type: 'string'}, 'run-id': {type: 'string'},
      'queue-timeout': {type: 'string'}, 'max-duration': {type: 'string'},
      'cleanup-timeout': {type: 'string'}, help: {type: 'boolean', short: 'h'}
    }})
  }
  catch { throw new RunnerError('Invalid arguments. Run stf utils test run --help; tokens belong in a private file or environment.') }
  const value = parsed.values
  if (value.help) { process.stdout.write(help); return 0 }
  const runner = value.runner as Runner | undefined
  const platform = value.platform?.toLowerCase() === 'android' ? 'Android' :
    value.platform?.toLowerCase() === 'ios' ? 'iOS' : undefined
  if (!runner || !['appium', 'maestro'].includes(runner) || !platform ||
      runner === 'maestro' && platform !== 'Android') {
    throw new RunnerError('Provide --runner appium|maestro and --platform Android|iOS; physical iOS requires Appium')
  }
  if (!command.length || !command[0]) throw new RunnerError('Provide a repository test command after --')
  const url = value['farm-url'] || process.env.FARM_URL || process.env.COORDINATOR_URL
  if (!url) throw new RunnerError('Provide FARM_URL or --farm-url')
  const allocation: Allocation = {runner, platform,
    runId: value['run-id'] || process.env.CI_JOB_ID && `gitlab-${process.env.CI_PROJECT_ID || 'project'}-${process.env.CI_JOB_ID}` || `local-${randomUUID()}`,
    queueTimeoutSeconds: positive(value['queue-timeout'], 3600),
    maxDurationSeconds: positive(value['max-duration'], 21600)}
  for (const key of ['serial', 'model', 'provider'] as const) if (value[key]) allocation[key] = value[key]
  for (const name of ['runId', 'serial', 'model', 'provider'] as const) {
    const item = allocation[name]
    if (item !== undefined && (!item.trim() || item.length > 256 || /\p{Cc}|\p{Cf}/u.test(item))) {
      throw new RunnerError('Invalid device filter or run identifier')
    }
  }
  const abort = new AbortController()
  let interrupted = 0
  const stopInt = () => { interrupted = 130; abort.abort() }
  const stopTerm = () => { interrupted = 143; abort.abort() }
  process.once('SIGINT', stopInt)
  process.once('SIGTERM', stopTerm)
  try {
    const code = await runTest({url, allocation, command, signal: abort.signal,
      cleanupTimeoutSeconds: positive(value['cleanup-timeout'], 120),
      ...(value['token-file'] ? {tokenFile: value['token-file']} : {}),
      ...(value['ca-file'] ? {caFile: value['ca-file']} : {})})
    return interrupted || code
  }
  catch (error) {
    if (interrupted) {
      if (error instanceof Error && error.message !== 'Test run cancelled') {
        process.stderr.write(`STF: ${error.message}\n`)
      }
      return interrupted
    }
    throw error
  }
  finally {
    process.removeListener('SIGINT', stopInt)
    process.removeListener('SIGTERM', stopTerm)
  }
}
