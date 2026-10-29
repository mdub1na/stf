#!/usr/bin/env node

// Mount this file read-only into a disposable final image. It never contacts a device.
import assert from 'node:assert/strict'
import {execFile, spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {parseArgs, promisify} from 'node:util'

const {values} = parseArgs({options: {
  'app-root': {type: 'string', default: '/app'},
  aab: {type: 'string'},
  'require-aab': {type: 'boolean', default: false}
}})
const root = path.resolve(values['app-root'])
const require = createRequire(path.join(root, 'package.json'))
const execute = promisify(execFile)
const checks = []
const packageJson = require('./package.json')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stf-image-smoke-'))
const childEnvironment = {...process.env}
delete childEnvironment.ALLOW_OUTDATED_DEPENDENCIES

async function check(name, action) {
  const started = performance.now()
  console.error('Checking ' + name)
  try {
    const details = await action()
    checks.push({name, status: 'passed', milliseconds: Math.round(performance.now() - started), details})
  }
  catch (error) {
    checks.push({name, status: 'failed', milliseconds: Math.round(performance.now() - started),
      error: error.stack || String(error)})
  }
  console.error(name + ': ' + checks.at(-1).status)
}

async function command(file, args, options = {}) {
  return execute(file, args, {cwd: root, env: childEnvironment,
    timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options})
}

async function requiredFile(file) {
  const stat = await fs.stat(file)
  assert(stat.isFile() && stat.size > 0, 'Missing or empty file: ' + file)
  return stat.size
}

async function inventory(directory) {
  const records = []
  async function visit(relative) {
    const entries = await fs.readdir(path.join(directory, relative), {withFileTypes: true})
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        await visit(name)
      }
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(directory, name))
        records.push({path: name, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')})
      }
    }
  }
  await visit('')
  return {files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex')}
}

// Kill the entire isolated child process group on timeout, including Java started by STF.
async function runAabWorker(aabPath) {
  const source = `
    const fs = require('node:fs')
    const path = require('node:path')
    const {createRequire} = require('node:module')
    const req = createRequire(path.join(process.argv[1], 'package.json'))
    const convert = req('./lib/util/bundletool.js').default
    const ApkReader = req('@devicefarmer/adbkit-apkreader')
    const work = process.argv[2]
    const file = {path: path.join(work, 'sample.aab'), isAab: true}
    fs.copyFileSync(process.argv[3], file.path)
    convert({bundletoolPath: path.join(process.argv[1], 'bundletool/bundletool.jar'), file,
      keystore: {ksPath: path.join(work, 'test.keystore'), ksKeyAlias: 'smoke',
        ksPass: 'smoke-test', ksKeyPass: 'smoke-test', ksKeyalg: 'RSA',
        ksValidity: 1, ksKeysize: 2048,
        ksDname: 'CN=STF image smoke,OU=Test,O=Test,L=Test,C=US'}})
      .then(async result => {
        const reader = await ApkReader.open(result.path)
        const manifest = await reader.readManifest()
        if (!manifest.package) throw new Error('Converted APK has no package')
        console.log('STF_AAB_RESULT=' + JSON.stringify({package: manifest.package,
          apkBytes: fs.statSync(result.path).size}))
      }).catch(error => {console.error(error.stack); process.exitCode = 1})
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, root, temporary, aabPath], {
      cwd: root, env: childEnvironment, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      try { process.kill(-child.pid, 'SIGKILL') }
      catch (error) { if (error.code !== 'ESRCH') reject(error) }
    }, 180000)
    child.stdout.on('data', chunk => {stdout += chunk})
    child.stderr.on('data', chunk => {stderr += chunk})
    child.once('error', error => {clearTimeout(timer); reject(error)})
    child.once('close', code => {
      clearTimeout(timer)
      if (expired || code !== 0) {
        reject(new Error('AAB worker ' + (expired ? 'timed out' : 'exited ' + code) + '\n' + stderr + stdout))
        return
      }
      const result = stdout.split('\n').find(line => line.startsWith('STF_AAB_RESULT='))
      if (!result) { reject(new Error('AAB worker produced no result: ' + stdout)); return }
      resolve(JSON.parse(result.slice('STF_AAB_RESULT='.length)))
    })
  })
}

try {
  await check('nonroot', () => {
    assert.equal(typeof process.getuid, 'function')
    assert.notEqual(process.getuid(), 0, 'Final image must run as a nonroot user')
    return {uid: process.getuid(), gid: process.getgid()}
  })

  await check('production-dependencies', async () => {
    const problems = require('./lib/util/depcheck.js').findProblems(root)
    assert.deepEqual(problems, [])
    const versions = {}
    for (const name of Object.keys(packageJson.dependencies).sort()) {
      versions[name] = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version
    }
    return {count: Object.keys(versions).length, versions}
  })

  await check('cli', async () => {
    const version = await command(path.join(root, 'bin/stf'), ['--version'])
    assert.equal(version.stdout.trim(), packageJson.version)
    const help = await command(path.join(root, 'bin/stf'), ['--help'])
    assert.match(help.stdout, /ios-provider/)
    assert.match(help.stdout, /storage-plugin-image/)
    return {version: version.stdout.trim()}
  })

  await check('jpeg-roundtrip', () => {
    const jpeg = require('@julusian/jpeg-turbo')
    const raw = Buffer.alloc(8 * 8 * 4, 255)
    const encoded = jpeg.compressSync(raw, {format: jpeg.FORMAT_RGBA,
      width: 8, height: 8, quality: 95, subsampling: jpeg.SAMP_444})
    assert(Buffer.isBuffer(encoded) && encoded.length > 0)
    const decoded = jpeg.decompressSync(encoded, {format: jpeg.FORMAT_RGBA})
    assert.equal(decoded.width, 8)
    assert.equal(decoded.height, 8)
    assert.equal(decoded.data.length, raw.length)
    assert(Math.abs(decoded.data[0] - 255) <= 2)
    return {encodedBytes: encoded.length}
  })

  await check('websocket-native-addons', () => {
    const details = {}
    for (const name of ['bufferutil', 'utf-8-validate']) {
      const entry = require.resolve(name)
      const moduleRequire = createRequire(entry)
      const native = moduleRequire('node-gyp-build')(path.dirname(entry))
      const publicApi = require(name)
      if (name === 'bufferutil') {
        assert.equal(publicApi.mask, native.mask, 'bufferutil silently fell back to JavaScript')
        const input = Buffer.from('websocket smoke')
        const mask = Buffer.from([0x01, 0x37, 0x80, 0xff])
        const output = Buffer.alloc(input.length)
        native.mask(input, mask, output, 0, input.length)
        assert.notDeepEqual(output, input)
        native.unmask(output, mask)
        assert.deepEqual(output, input)
      }
      else {
        assert.equal(publicApi, native, 'utf-8-validate silently fell back to JavaScript')
        assert.equal(native(Buffer.from('STF \u041f\u0440\u0438\u0432\u0435\u0442 \ud83d\udcf1')), true)
        assert.equal(native(Buffer.from([0xc0, 0xaf])), false)
      }
      details[name] = 'native'
    }
    return details
  })

  await check('static-assets', async () => {
    const files = ['res/build/entry/app.entry.js', 'res/build/entry/authmock.entry.js',
      'res/build/entry/authldap.entry.js', 'res/common/logo/exports/STF-128.png',
      'lib/wire/wire.proto', 'tools/ios-prototype/main.mts']
    for (const file of files) await requiredFile(path.join(root, file))
    return {files: files.length}
  })

  await check('graphicsmagick-transform', async () => {
    const png = await fs.readFile(path.join(root, 'res/common/logo/exports/STF-128.png'))
    const input = path.join(temporary, 'input.png')
    const output = path.join(temporary, 'resized.png')
    await fs.writeFile(input, png)
    await command('gm', ['convert', input, '-geometry', '16x16^', '-crop', '16x16+0+0', output])
    const resized = await fs.readFile(output)
    assert.deepEqual(resized.subarray(0, 8), png.subarray(0, 8))
    assert.equal(resized.readUInt32BE(16), 16)
    assert.equal(resized.readUInt32BE(20), 16)
    return {outputBytes: resized.length}
  })

  await check('android-all-abi-resources', async () => {
    const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
    const resources = {}
    for (const name of ['minicap', 'minitouch', 'minirev']) {
      const directory = path.join(root, 'node_modules/@devicefarmer/' + name + '-prebuilt/prebuilt')
      for (const abi of abis) {
        const files = await inventory(path.join(directory, abi))
        assert(files.files > 0 && files.bytes > 0, 'Missing Android ABI: ' + name + '/' + abi)
        if (name !== 'minicap') {
          await requiredFile(path.join(directory, abi, 'bin', name))
          await requiredFile(path.join(directory, abi, 'bin', name + '-nopie'))
        }
      }
      resources[name] = await inventory(directory)
    }
    await requiredFile(path.join(root, 'node_modules/@devicefarmer/minicap-prebuilt/prebuilt/noarch/minicap.apk'))
    const service = path.join(root, 'node_modules/@devicefarmer/stfservice-prebuilt/prebuilt/noarch')
    await requiredFile(path.join(service, 'wire.proto'))
    await requiredFile(path.join(service, 'STFService.apk'))
    resources.service = await inventory(service)
    return resources
  })

  await check('apk-manifest', async () => {
    const ApkReader = require('@devicefarmer/adbkit-apkreader')
    const apk = path.join(root, 'node_modules/@devicefarmer/stfservice-prebuilt/prebuilt/noarch/STFService.apk')
    const reader = await ApkReader.open(apk)
    const manifest = await reader.readManifest()
    assert.equal(manifest.package, 'jp.co.cyberagent.stf')
    return {package: manifest.package}
  })

  await check('java-keytool-bundletool', async () => {
    const java = await command('java', ['-version'])
    await command('keytool', ['-help'])
    const bundletool = await command('java', ['-jar', path.join(root, 'bundletool/bundletool.jar'), 'version'])
    assert.match(java.stderr + java.stdout, /version/)
    assert.match(bundletool.stdout, /1\.2\.0/)
    return {java: (java.stderr + java.stdout).split('\n')[0], bundletool: bundletool.stdout.trim()}
  })

  await check('runtime-inventory', async () => {
    const npm = await command('npm', ['--version'])
    const packages = await command('dpkg-query', ['-W', '-f=${Package}\t${Version}\n'])
    return {npm: npm.stdout.trim(), os: await fs.readFile('/etc/os-release', 'utf8'),
      packages: packages.stdout.trim().split('\n')}
  })

  if (values.aab) {
    await check('stf-aab-to-apk', async () => {
      const file = path.resolve(values.aab)
      await requiredFile(file)
      const result = await runAabWorker(file)
      return {...result, fixtureSha256: createHash('sha256').update(await fs.readFile(file)).digest('hex')}
    })
  }
  else if (values['require-aab']) {
    await check('stf-aab-to-apk', () => {throw new Error('--require-aab requires --aab PATH')})
  }
  else {
    checks.push({name: 'stf-aab-to-apk', status: 'skipped', reason: 'No --aab fixture supplied'})
  }

  // Keep native messaging threads after subprocess probes. This also avoids
  // forking after a ZeroMQ context has started under CPU emulation.
  await check('zeromq-message', async () => {
    const zmq = require('zeromq')
    const receiver = new zmq.Pair({receiveTimeout: 10000})
    const sender = new zmq.Pair({sendTimeout: 10000})
    try {
      const address = 'inproc://stf-image-smoke-' + process.pid
      await receiver.bind(address)
      sender.connect(address)
      await sender.send('stf-runtime-smoke')
      const [message] = await receiver.receive()
      assert.equal(message.toString(), 'stf-runtime-smoke')
      return {version: zmq.version}
    }
    finally { sender.close(); receiver.close() }
  })
}
finally {
  await fs.rm(temporary, {recursive: true, force: true})
}

const failed = checks.filter(check => check.status === 'failed')
console.log(JSON.stringify({schema: 1, node: process.version, arch: process.arch,
  platform: process.platform, packageVersion: packageJson.version,
  status: failed.length ? 'failed' : 'passed', checks}, null, 2))
process.exitCode = failed.length ? 1 : 0
