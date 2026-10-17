import assert from 'node:assert/strict'
import {DevicePacketAccess, isDeviceCommand} from '../../lib/units/websocket/device-access.js'

describe('manual device packets during automation', function() {
  for (const platform of ['Android', 'iOS']) {
    it(`rejects ${platform} input during automation until release`, async function() {
      let device = {serial: 'PHONE', platform
      , channel: platform === 'iOS' ? 'ios:PHONE' : 'private-channel'
        , present: true, ready: true, group: {id: 'shared'}, owner: {email: 'runner@example.test'}
        , usage: 'automation' as string | null}
      const access = new DevicePacketAccess(async() => [device], async() => device)
      assert.equal(await access.allows(device.channel, ['shared']), false)
      device = {...device, usage: null}
      assert.equal(await access.allows(device.channel, ['shared']), true)
      assert.equal(await access.allows(device.channel, ['foreign']), false)
      device = {...device, channel: 'replacement-channel'}
      const previous = platform === 'iOS' ? 'ios:PHONE' : 'private-channel'
      assert.equal(await access.allows(previous, ['shared']), false)
    })
  }

  it('blocks the join persistence gap and clears the released state', async function() {
    const device = {serial: 'PHONE', channel: 'private', present: true, ready: true
    , group: {id: 'shared'}}
    const access = new DevicePacketAccess(async() => [device], async() => device)
    access.joined('PHONE', 'automation')
    assert.equal(await access.allows('private', ['shared']), false)
    access.released('PHONE')
    assert.equal(await access.allows('private', ['shared']), true)
    assert.equal(await access.allows('unknown', ['shared']), false)
  })

  it('covers controls while allowing subscriptions and metadata', function() {
    for (const event of ['input.touchDown', 'input.keyPress', 'clipboard.paste', 'device.reboot'
      , 'device.unlock', 'device.install', 'device.iosPower', 'group.invite', 'group.kick'
      , 'shell.command', 'connect.start', 'browser.open', 'account.add', 'wifi.set'
      , 'display.rotate'
      , 'forward.create', 'screen.capture', 'fs.list', 'logcat.start']) {
      assert.equal(isDeviceCommand(event), true, event)
    }
    for (const event of ['tx.cleanup', 'tx.punch', 'user.settings.update', 'device.note']) {
      assert.equal(isDeviceCommand(event), false, event)
    }
  })
})
