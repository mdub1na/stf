import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {chmod, readFile, symlink, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {test} from 'node:test'
import {normalizeFarmUrl, readFarmToken} from '../coordinator.mts'
import {cli, directory, farm, token} from './helpers.mts'

test('public help and version need no SDK, farm access, or token', async() => {
  for (const args of [[], ['--help'], ['utils'], ['utils', 'test'], ['utils', 'test', '--help'], ['utils', 'test', 'run', '--help']]) {
    const result = await cli(args, {FARM_TOKEN: ''}).finished
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /stf utils test run/)
    assert.equal(result.stderr, '')
  }
  const version = await cli(['--version']).finished
  assert.equal(version.code, 0)
  assert.match(version.stdout, /^0\.1\.0\n$/)
})

test('invalid flags and unsupported physical iOS Maestro do not echo token arguments', async() => {
  for (const args of [['utils', 'test', 'run', '--token', token],
    ['utils', 'test', 'run', '--runner', 'maestro', '--platform', 'iOS', '--', 'unused'],
    ['utils', 'test', 'run', '--runner', 'appium', '--platform', 'Android', '--queue-timeout', '0', '--farm-url', 'http://127.0.0.1', '--', 'unused']]) {
    const result = await cli(args).finished
    assert.equal(result.code, 1)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token))
    assert.doesNotMatch(result.stderr, /\n\s+at /)
  }
})

test('token file reader rejects shared files and symbolic links', async() => {
  const temp = await directory()
  try {
    assert.equal(await readFarmToken(temp.tokenFile), token)
    const link = join(temp.path, 'link')
    await symlink(temp.tokenFile, link)
    await assert.rejects(readFarmToken(link), /private regular file/)
    await chmod(temp.tokenFile, 0o644)
    await assert.rejects(readFarmToken(temp.tokenFile), /private regular file/)
  }
  finally { await temp.close() }
})

test('farm endpoint rejects credentials, fragments, queries, and arbitrary path prefixes', () => {
  for (const value of ['https://user:secret@farm.invalid', 'https://farm.invalid/?token=secret',
    'https://farm.invalid/#secret', 'https://farm.invalid/other', 'file:///tmp/token']) {
    assert.throws(() => normalizeFarmUrl(value))
  }
  assert.equal(normalizeFarmUrl('http://coordinator.stf.svc.cluster.local:8080').pathname, '/api/v1')
})

test('npm package contains every standalone runtime module and executable bin', async() => {
  const temp = await directory()
  const root = fileURLToPath(new URL('..', import.meta.url))
  try {
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
    assert.equal(metadata.name, '@finservice/stf-test-runner')
    assert.deepEqual(metadata.bin, {stf: 'stf.mjs'})
    assert.equal(lock.packages['node_modules/ws'].version, '8.22.0')
    const {stdout} = await promisify(execFile)('npm', ['pack', '--dry-run', '--json', '--ignore-scripts',
      '--offline', '--cache', join(temp.path, 'cache')], {cwd: root, timeout: 15000, maxBuffer: 131072})
    const [packed] = JSON.parse(stdout)
    assert.deepEqual(packed.files.map((file: {path: string}) => file.path).sort(),
      [...metadata.files, 'package.json'].filter((value, index, all) => all.indexOf(value) === index).sort())
    assert.ok(packed.files.find((file: {path: string, mode: number}) => file.path === 'stf.mjs' && file.mode & 0o111))
    assert.ok(packed.files.every((file: {path: string}) => !file.path.endsWith('.mts')))
  }
  finally { await temp.close() }
})

test('npm pack installed under node_modules executes help and a complete fake Appium lease', async() => {
  const temp = await directory()
  const api = await farm()
  const root = fileURLToPath(new URL('..', import.meta.url))
  const exec = promisify(execFile)
  try {
    const {stdout: packed} = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp.path],
      {cwd: root, timeout: 15000, maxBuffer: 131072})
    const artifact = join(temp.path, JSON.parse(packed)[0].filename)
    const prefix = join(temp.path, 'installed')
    await exec('npm', ['install', '--prefix', prefix, artifact, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      {cwd: temp.path, timeout: 15000, maxBuffer: 131072})
    const bin = join(prefix, 'node_modules', '.bin', 'stf')
    const help = await exec(process.execPath, [bin, 'utils', 'test', 'run', '--help'], {timeout: 5000})
    assert.match(help.stdout, /stf utils test run/)
    assert.equal(help.stderr, '')
    const script = `const result=await fetch(process.env.APPIUM_SERVER_URL+'/session',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({capabilities:{alwaysMatch:JSON.parse(process.env.APPIUM_CAPABILITIES_JSON)}})});
      if((await result.json()).value.sessionId!=='session-1') process.exit(5);`
    const run = await exec(process.execPath, [bin, 'utils', 'test', 'run', '--farm-url', api.url,
      '--token-file', temp.tokenFile, '--runner', 'appium', '--platform', 'Android', '--',
      process.execPath, '--input-type=module', '--eval', script], {timeout: 8000, maxBuffer: 131072})
    assert.match(run.stderr, /cleanup confirmed/)
    assert.ok(api.events.some(e => e.path.endsWith('/webdriver/session')))
    assert.doesNotMatch(run.stderr + run.stdout, new RegExp(token))
  }
  finally { await api.close(); await temp.close() }
})
