import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {after, before, test} from 'node:test'
import {buildRelease} from '../build-release.mts'
import {generateFormula} from '../generate-formula.mts'
import {stageRelease} from '../stage-release.mts'
import {archiveFiles, sha256, unpackRelease} from '../archive.mts'

let directory: string
let artifact: string
let version: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stf-utils-release-test-'))
  const first = await buildRelease({out: join(directory, 'first'), offline: true})
  version = first.version
  artifact = join(directory, 'first', first.artifact)
})
after(async () => {if (directory) await rm(directory, {recursive: true, force: true})})

test('release contains only portable client runtime and the pinned ws dependency', async() => {
  const bytes = await readFile(artifact)
  const files = unpackRelease(bytes, `stf-utils-${version}`)
  const names = files.map(file => file.path)
  assert.ok(names.includes('node_modules/ws/lib/websocket.js'))
  assert.ok(names.includes('node_modules/ws/LICENSE'))
  assert.ok(names.includes('package-lock.json'))
  assert.ok(!names.some(name => !name.startsWith('node_modules/ws/') &&
    /(?:gateway|server|access|guard|test|\.node$|\.npmrc|\.env)/.test(name)))
  assert.equal(JSON.parse(files.find(file => file.path === 'node_modules/ws/package.json')!.data.toString()).version, '8.22.0')
  const checksum = await readFile(artifact + '.sha256', 'utf8')
  assert.equal(checksum, `${sha256(bytes)}  stf-utils-${version}.tar.gz\n`)
})

test('identical locked inputs produce byte-identical release archives', async() => {
  const second = await buildRelease({out: join(directory, 'second'), offline: true})
  assert.deepEqual(await readFile(join(directory, 'second', second.artifact)), await readFile(artifact))
})

test('staged client works outside the checkout with no npm, SDK, or credentials', async() => {
  const executable = await stageRelease({artifact, prefix: join(directory, 'installed')})
  const env = {...process.env, HOME: join(directory, 'home'), XDG_CONFIG_HOME: join(directory, 'config'),
    NODE_PATH: '', STF_ACCESS_TOKEN: '', ANDROID_SDK_ROOT: '', ANDROID_HOME: ''}
  const run = (args: string[]) => execFileSync(executable, args, {cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  assert.match(run(['--version']), new RegExp(version.replaceAll('.', '\\.')))
  assert.match(run(['utils', 'adb', 'connect', '--help']), /connect|serial/i)
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(join(directory, 'installed/libexec/client.mts')).href)})`], {cwd: directory, env})
  assert.throws(() => run(['utils', 'adb', 'connect']))
})

test('staging never replaces a pre-existing stf command', async() => {
  const prefix = join(directory, 'occupied')
  await mkdir(join(prefix, 'bin'), {recursive: true})
  await writeFile(join(prefix, 'bin/stf'), 'existing server command\n')
  await assert.rejects(stageRelease({artifact, prefix}), {code: 'EEXIST'})
  assert.equal(await readFile(join(prefix, 'bin/stf'), 'utf8'), 'existing server command\n')
})

test('formula derives its checksum and version from the actual artifact', async() => {
  const formula = await generateFormula({artifact, out: join(directory, 'Formula/stf-utils.rb')})
  assert.ok(formula.includes(JSON.stringify(pathToFileURL(artifact).href)))
  assert.ok(formula.includes(`sha256 "${sha256(await readFile(artifact))}"`))
  assert.match(formula, /depends_on "node@24"/)
  assert.doesNotMatch(formula, /system "npm"|link_overwrite/)
  execFileSync('ruby', ['-c', join(directory, 'Formula/stf-utils.rb')], {stdio: 'pipe'})
})

test('formula generation refuses a modified archive without an updated manifest', async() => {
  const copy = join(directory, 'tampered')
  await mkdir(copy)
  const original = await readFile(artifact)
  await writeFile(join(copy, `stf-utils-${version}.tar.gz`), Buffer.concat([original, Buffer.from('changed')]))
  await writeFile(join(copy, `stf-utils-${version}.manifest.json`), await readFile(join(directory, 'first', `stf-utils-${version}.manifest.json`)))
  await assert.rejects(generateFormula({artifact: join(copy, `stf-utils-${version}.tar.gz`), out: join(copy, 'stf-utils.rb')}), /do not match/)
})

test('archive reader rejects traversal and writer normalizes file order and metadata', () => {
  const files = [{path: 'two', data: Buffer.from('2')}, {path: 'one', data: Buffer.from('1')}]
  assert.deepEqual(archiveFiles('package', files), archiveFiles('package', [...files].reverse()))
  assert.throws(() => unpackRelease(archiveFiles('package', [{path: '../escape', data: Buffer.from('bad')}]), 'package'), /Unsafe/)
})
