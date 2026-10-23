import events from 'node:events'
import {Readable} from 'node:stream'

import {expect} from 'chai'
import sinon from 'sinon'
import Bluebird from 'bluebird'

import wire from '../../lib/wire/index.js'
import lifecycle from '../../lib/util/lifecycle.js'
import group from '../../lib/units/device/plugins/group.js'
import type {GroupPlugin} from '../../lib/types/device-plugins.js'

type Handler = (channel: string, message: unknown) => Bluebird<void>

function setup(adb?: ReturnType<typeof maestroAdb>) {
  var handlers: Record<number, Handler> = {}
  var router = {
    on: function(type: {$code: number}, handler: Handler) {
      handlers[type.$code] = handler
      return router
    }
  }
  var push = {send: sinon.spy()}
  var sub = {subscribe: sinon.spy(), unsubscribe: sinon.spy()}
  var channels = Object.assign(new events.EventEmitter(), {
    register: sinon.spy()
  , unregister: sinon.spy()
  })
  var service = {
    wake: sinon.spy()
  , acquireWakeLock: sinon.spy()
  , releaseWakeLock: sinon.spy()
  }
  var plugin = group.invoke(
    {serial: 'test-device', groupTimeout: 1000}
  , {channel: 'solo-channel'}
  , {}
  , service
  , router
  , push
  , sub
  , channels
  , adb
  ) as GroupPlugin
  return {plugin: plugin, handlers: handlers, push: push}
}

function maestroAdb() {
  const packages = new Set<string>()
  let failCleanup = false
  const commands: string[] = []
  return {commands, packages, setFailCleanup(value: boolean) {
 failCleanup = value
}
  , shell(_serial: string, command: string) {
      const body = command.split('; status=$?;')[0]!
      commands.push(body)
      let output = ''
      if (body === 'pm list packages') {
 output = [...packages].map(name => 'package:' + name).join('\n')
}
      if (body.startsWith('settings get ')) {
 output = '0'
}
      if (body === 'ps -A' && failCleanup) {
 output = 'u0_a123 123 1 S dev.mobile.maestro'
}
      if (body.startsWith('pm uninstall ')) {
        packages.delete(body.slice('pm uninstall '.length))
        output = 'Success'
      }
      return Bluebird.resolve(Readable.from([Buffer.from(output + '\n__STF_EXIT__0\n')]))
    }
  , util: {readAll(stream: Readable) {
      return Bluebird.resolve((async() => {
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
 chunks.push(Buffer.from(chunk))
}
        return Buffer.concat(chunks)
      })())
    }}
  }
}

function messages(push: ReturnType<typeof setup>['push'], code: number) {
  return push.send.getCalls().map(call => wire.Envelope.decode(call.args[0][1]))
    .filter(envelope => envelope.type === code)
}

function autoGroup(handlers: Record<number, Handler>, identifier: string) {
  var owner = new wire.OwnerMessage('a@example.com', 'a', 'group-channel')
  return handlers[wire.AutoGroupMessage.$code]!(
    'channel'
  , new wire.AutoGroupMessage(owner, identifier)
  )
}

describe('Device group plugin', function() {
  beforeEach(function() {
    sinon.stub(lifecycle, 'observe')
  })

  afterEach(function() {
    sinon.restore()
  })

  it('should pass the autojoin identifier to join listeners', function() {
    var context = setup()
    var joins: Array<string | undefined> = []
    context.plugin.on('join', function(joined, identifier) {
      joins.push(identifier)
    })

    return autoGroup(context.handlers, 'fingerprint').then(function() {
      expect(joins).to.eql(['fingerprint'])
    })
  })

  it('should not send the autojoin identifier as the usage', function() {
    var context = setup()

    return autoGroup(context.handlers, 'fingerprint').then(function() {
      var envelope = wire.Envelope.decode(context.push.send.firstCall.args[0][1])
      var message = wire.JoinGroupMessage.decode(envelope.message)
      expect(message.usage).to.not.equal('fingerprint')
    })
  })
})


describe('Device group Maestro cleanup fence', function() {
  beforeEach(function() {
 sinon.stub(lifecycle, 'observe')
})
  afterEach(function() {
 sinon.restore()
})

  it('captures the baseline before the ownership ACK and refuses a simultaneous capture',
    async function() {
    const adb = maestroAdb()
    const context = setup(adb)
    const owner = new wire.OwnerMessage('ci@example.test', 'CI', 'ci-channel')
    const capture = context.plugin.join(owner, 10000, 'automation', undefined, 'lease-a', 'maestro')
    let blocked = false
    try {
 await context.plugin.join(owner, 10000, 'automation', undefined, 'lease-b', 'maestro')
}
    catch {
 blocked = true
}
    expect(blocked).to.equal(true)
    await capture
    expect(adb.commands.filter(command => command.startsWith('settings get '))).to.have.length(6)
    const joined = messages(context.push, wire.JoinGroupMessage.$code)
    expect(joined).to.have.length(1)
    expect(wire.JoinGroupMessage.decode(joined[0]!.message).automationRunner).to.equal('maestro')
    await context.plugin.leave('test_cleanup')
  })

  it('retains ownership and the epoch when native cleanup fails, then permits an exact retry',
    async function() {
    const adb = maestroAdb()
    const context = setup(adb)
    const owner = new wire.OwnerMessage('ci@example.test', 'CI', 'ci-channel')
    await context.plugin.join(owner, 10000, 'automation', undefined, 'lease-a', 'maestro')
    adb.packages.add('dev.mobile.maestro')
    adb.packages.add('dev.mobile.maestro.test')
    adb.setFailCleanup(true)
    let failed = false
    try {
 await context.plugin.leave('automation_release')
}
 catch {
 failed = true
}
    expect(failed).to.equal(true)
    expect((await context.plugin.get()).email).to.equal(owner.email)
    expect(messages(context.push, wire.LeaveGroupMessage.$code)).to.have.length(0)
    adb.setFailCleanup(false)
    await context.plugin.leave('automation_release')
    expect(messages(context.push, wire.LeaveGroupMessage.$code)).to.have.length(1)
    expect([...adb.packages]).to.eql([])
  })

  it('cleans on provider expiry without a coordinator and keeps failed cleanup fenced',
    async function() {
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']})
    const adb = maestroAdb()
    const context = setup(adb)
    const owner = new wire.OwnerMessage('ci@example.test', 'CI', 'ci-channel')
    await context.plugin.join(owner, 10, 'automation', undefined, 'lease-a', 'maestro')
    adb.setFailCleanup(true)
    await clock.tickAsync(11)
    for (let count = 0; count < 5; count++) {
 await new globalThis.Promise(resolve => setImmediate(resolve))
}
    expect((await context.plugin.get()).email).to.equal(owner.email)
    expect(adb.commands).to.include('am force-stop dev.mobile.maestro')
    expect(messages(context.push, wire.LeaveGroupMessage.$code)).to.have.length(0)
    await context.handlers[wire.AutomationLeaseMessage.$code]!('reply',
      new wire.AutomationLeaseMessage('test-device', owner, 'lease-a', 'renew', 10000))
    const renewal = messages(context.push, wire.TransactionDoneMessage.$code)
    expect(wire.TransactionDoneMessage.decode(renewal[renewal.length - 1]!.message).success)
      .to.equal(false)
    adb.setFailCleanup(false)
    await context.handlers[wire.AutomationLeaseMessage.$code]!('reply',
      new wire.AutomationLeaseMessage('test-device', owner, 'lease-a', 'release'))
    expect(messages(context.push, wire.LeaveGroupMessage.$code)).to.have.length(1)
    await context.plugin.join(owner, 10000, 'automation', undefined, 'lease-b', 'maestro')
    await context.handlers[wire.AutomationLeaseMessage.$code]!('reply',
      new wire.AutomationLeaseMessage('test-device', owner, 'lease-a', 'release'))
    expect((await context.plugin.get()).email).to.equal(owner.email)
    expect(messages(context.push, wire.LeaveGroupMessage.$code)).to.have.length(1)
    await context.plugin.leave('test_cleanup')
    clock.restore()
  })

  it('finishes native cleanup on provider expiry while the coordinator is absent',
    async function() {
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']})
    const adb = maestroAdb()
    const context = setup(adb)
    const owner = new wire.OwnerMessage('ci@example.test', 'CI', 'ci-channel')
    await context.plugin.join(owner, 10, 'automation', undefined, 'lease-a', 'maestro')
    adb.packages.add('dev.mobile.maestro')
    adb.packages.add('dev.mobile.maestro.test')
    const left = new globalThis.Promise(resolve => context.plugin.once('leave', resolve))
    await clock.tickAsync(11)
    await left
    expect([...adb.packages]).to.eql([])
    expect(messages(context.push, wire.LeaveGroupMessage.$code)).to.have.length(1)
    let unowned = false
    try {
 await context.plugin.get()
}
    catch {
 unowned = true
}
    expect(unowned).to.equal(true)
    clock.restore()
  })
})
