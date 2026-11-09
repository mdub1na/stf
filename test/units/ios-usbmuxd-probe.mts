import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'node:child_process'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {Script} from 'node:vm'

const yaml = createRequire(import.meta.url)('js-yaml')
const manifest = fileURLToPath(new URL(
  '../../kuber/ios-prototype/deployment.yaml', import.meta.url
))

describe('iOS usbmuxd liveness probes', function() {
  this.timeout(10000)
  let directory = ''
  let server: ChildProcess | null = null

  beforeEach(async function() {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stf-usbmuxd-'))
  })

  afterEach(async function() {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL')
      await once(server, 'exit')
    }
    server = null
    await fs.rm(directory, {recursive: true, force: true})
  })

  async function listen(socket: string) {
    server = spawn(process.execPath, ['-e'
    , 'require("node:net").createServer(s=>s.on("error",()=>{}))' +
      '.listen(process.argv[1],()=>process.send("ready"))'
    , socket
    ], {stdio: ['ignore', 'ignore', 'inherit', 'ipc']})
    const [message] = await once(server, 'message')
    assert.equal(message, 'ready')
  }

  async function checkSocketRecovery(name: string) {
    const documents = yaml.loadAll(await fs.readFile(manifest, 'utf8'))
    const deployment = documents.find((doc: any) => doc?.kind === 'Deployment')
    const container = deployment.spec.template.spec.containers
      .find((item: any) => item.name === name)
    const probe = container.livenessProbe
    const [node, flag, code, socketPath] = probe.exec.command
    assert.deepEqual([node, flag, socketPath], ['node', '-e', '/run/usbmuxd'])
    assert.ok(probe.failureThreshold * probe.periodSeconds <= 30)
    const socket = path.join(directory, 'usbmuxd')
    const check = async() => {
      const child = spawn(process.execPath, ['-e', code, socket], {stdio: 'ignore'})
      const [status] = await once(child, 'exit')
      return status
    }

    assert.equal(await check(), 1, 'A missing host socket must trigger recovery')
    await listen(socket)
    assert.equal(await check(), 0, 'A listening usbmuxd needs no connected phone')
    server!.kill('SIGKILL')
    await once(server!, 'exit')
    assert.ok((await fs.stat(socket)).isSocket(), 'Abrupt daemon exit leaves a stale inode')
    assert.equal(await check(), 1, 'A stale socket must trigger recovery')

    await fs.unlink(socket)
    await listen(socket)
    assert.equal(await check(), 0, 'The replacement socket must restore liveness')
  }

  it('keeps every embedded probe program valid after YAML parsing', async function() {
    const documents = yaml.loadAll(await fs.readFile(manifest, 'utf8'))
    const deployment = documents.find((doc: any) => doc?.kind === 'Deployment')
    for (const container of deployment.spec.template.spec.containers) {
      for (const kind of ['livenessProbe', 'readinessProbe']) {
        const command = container[kind]?.exec.command
        if (command) {
          assert.doesNotThrow(() => new Script(command[2]), `${container.name} ${kind}`)
        }
      }
    }
  })

  for (const name of ['tunnel', 'prototype']) {
    it(`${name} detects a stale socket and accepts its replacement without a phone`,
      async() => checkSocketRecovery(name))
  }
})
