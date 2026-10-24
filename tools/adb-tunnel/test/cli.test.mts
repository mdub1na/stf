import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {access, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {after, before, describe, it} from 'node:test'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)
const packagePath = fileURLToPath(new URL('..', import.meta.url))
const stf = join(packagePath, 'stf.mts')
const cli = join(packagePath, 'cli.mts')
const repositoryPath = resolve(packagePath, '../..')
const secret = 'namespace-test-token-must-not-appear'
let temporary: string

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'stf-utils-cli-'))
})

after(async () => {
  await rm(temporary, {recursive: true, force: true})
})

async function command(entry: string, args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [entry, ...args], {
      timeout: 5000,
      env: {...process.env, STF_ACCESS_TOKEN: secret},
      maxBuffer: 131072
    })
    return {...result, code: 0}
  }
  catch (error) {
    const result = error as Error & {code: number, stdout: string, stderr: string}
    if (typeof result.code !== 'number') throw error
    return {stdout: result.stdout, stderr: result.stderr, code: result.code}
  }
}

async function npmCli(): Promise<string> {
  for (const candidate of [process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'npm')]) {
    if (!candidate) continue
    try {
      await access(candidate)
      return candidate
    }
    catch {
      // Check the other standard npm installation layout.
    }
  }
  throw new Error('npm CLI is required to verify the standalone package contents')
}

describe('stf utils command namespace and standalone package', () => {
  it('provides help at each public namespace level without requiring credentials or an SDK', async () => {
    for (const args of [[], ['--help'], ['utils'], ['utils', '--help'],
      ['utils', 'adb'], ['utils', 'adb', '--help'], ['utils', 'adb', 'connect', '--help']]) {
      const result = await command(stf, args)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /stf utils adb/)
      assert.equal(result.stderr, '')
      assert.doesNotMatch(result.stdout, /stf-adb/)
      assert.doesNotMatch(result.stdout, new RegExp(secret))
    }
  })

  it('prints the version of the installed utilities package', async () => {
    const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'))
    const result = await command(stf, ['--version'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, `${metadata.version}\n`)
  })

  it('rejects unknown namespaces, unsafe options, and missing arguments without echoing values', async () => {
    for (const args of [[secret], ['utils', secret], ['utils', 'adb', secret],
      ['utils', 'adb', 'connect'],
      ['utils', 'adb', 'connect', 'PHONE', '--token', secret],
      ['utils', 'adb', 'connect', 'PHONE', '--insecure', '--help'],
      ['utils', 'adb', 'connect', 'PHONE', '--server', 'https://stf.invalid', '--local-port', '2.5']]) {
      const result = await command(stf, args)
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.ok(result.stderr.length > 0)
      assert.doesNotMatch(result.stderr, new RegExp(secret))
      assert.doesNotMatch(result.stderr, /Error:|\n\s+at /)
    }
  })

  it('imports the CLI without starting it and passes only the explicit main arguments', async () => {
    const {stdout, stderr} = await execFileAsync(process.execPath, ['--input-type=module', '--eval',
      `process.argv = ['node', 'ignored', '${secret}'];
       const cli = await import(${JSON.stringify(new URL('../cli.mts', import.meta.url).href)});
       process.stdout.write('IMPORTED_ONLY\\n');
       await cli.main(['utils', 'adb', '--help']);`], {timeout: 5000})
    assert.equal(stderr, '')
    assert.match(stdout, /^IMPORTED_ONLY\nUsage: stf utils adb/)
    assert.doesNotMatch(stdout, new RegExp(secret))
  })

  it('retains the direct module connect form only for internal verification scripts', async () => {
    const internal = await command(cli, ['connect', '--help'])
    assert.equal(internal.code, 0, internal.stderr)
    assert.match(internal.stdout, /stf utils adb connect SERIAL/)
    const installed = await command(stf, ['connect', '--help'])
    assert.equal(installed.code, 1)
    assert.match(installed.stderr, /Unknown command/)
  })

  it('dispatches root bin/stf utils without loading server bootstrap or compiled/native modules', async () => {
    const isolated = join(temporary, 'server-layout')
    const toolPath = join(isolated, 'tools', 'adb-tunnel')
    await mkdir(join(isolated, 'bin'), {recursive: true})
    await mkdir(join(isolated, 'lib', 'cli'), {recursive: true})
    await mkdir(join(toolPath, 'node_modules'), {recursive: true})
    await cp(join(repositoryPath, 'bin', 'stf'), join(isolated, 'bin', 'stf'))
    await writeFile(join(isolated, 'lib', 'cli', 'please.js'),
      "throw new Error('SERVER_BOOTSTRAP_WAS_LOADED')\n")
    for (const name of ['stf.mts', 'cli.mts', 'client.mts', 'types.mts', 'package.json']) {
      await cp(join(packagePath, name), join(toolPath, name))
    }
    await cp(join(packagePath, 'node_modules', 'ws'), join(toolPath, 'node_modules', 'ws'),
      {recursive: true})
    const result = await command(join(isolated, 'bin', 'stf'), ['utils', 'adb', 'connect', '--help'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /stf utils adb connect SERIAL/)
    assert.equal(result.stderr, '')
    const existing = await command(join(isolated, 'bin', 'stf'), ['local'])
    assert.equal(existing.code, 1)
    assert.match(existing.stderr, /SERVER_BOOTSTRAP_WAS_LOADED/)
  })

  it('packs only the installable client runtime and preserves its locked dependency and bin contract', async () => {
    const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'))
    const lock = JSON.parse(await readFile(join(packagePath, 'package-lock.json'), 'utf8'))
    assert.equal(metadata.name, '@finservice/stf-utils')
    assert.equal(metadata.private, true)
    assert.deepEqual(metadata.bin, {stf: 'stf.mts'})
    assert.equal(lock.name, metadata.name)
    assert.equal(lock.packages[''].name, metadata.name)
    assert.deepEqual(lock.packages[''].bin, metadata.bin)
    assert.equal(lock.packages['node_modules/ws'].version, metadata.dependencies.ws)
    assert.match(lock.packages['node_modules/ws'].integrity, /^sha512-/)
    const {stdout} = await execFileAsync(process.execPath, [await npmCli(), 'pack',
      '--dry-run', '--json', '--ignore-scripts', '--offline', '--cache', join(temporary, 'npm-cache')],
    {cwd: packagePath, timeout: 15000, maxBuffer: 131072})
    const [packed] = JSON.parse(stdout)
    const names = packed.files.map((file: {path: string}) => file.path).sort()
    assert.deepEqual(names, ['LICENSE', 'README.md', 'cli.mts', 'client.mts', 'package.json',
      'stf.mts', 'types.mts'].sort())
    assert.ok(packed.files.find((file: {path: string, mode: number}) =>
      file.path === 'stf.mts' && (file.mode & 0o111) !== 0), 'installed stf must be executable')
  })
})
