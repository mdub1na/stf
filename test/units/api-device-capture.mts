import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import Bluebird from 'bluebird'
import sinon from 'sinon'
import type {Response} from 'express'
import type {AddUserDeviceBody, ApiRequest} from '../../lib/types/units-api.js'
import wire from '../../lib/wire/index.js'
import wireutil from '../../lib/wire/util.js'
import {importFresh, mockModule} from '../helpers/module-mock.mts'

const unlockDevice = sinon.spy()
const restoreDb = mockModule(new URL('../../lib/db/api.js', import.meta.url), {default: {}})
const restoreAdb = mockModule(new URL('../../lib/util/adbutil.js', import.meta.url), {
  default: () => ({})
})
const restoreLocks = mockModule(new URL('../../lib/util/lockutil.js', import.meta.url), {
  default: {
    lockGenericDevice(_req: unknown, _res: unknown, lock: any) {
      lock.device = {serial: 'device', channel: 'runtime-one', present: true, ready: true
        , owner: null}
      return Bluebird.resolve(true)
    }
    , unlockDevice
  }
})
let addUserDevice: (req: ApiRequest<AddUserDeviceBody>, res: Response) => void
try {
  const controller = await importFresh(
    new URL('../../lib/units/api/controllers/user.js', import.meta.url)
  )
  addUserDevice = controller.addUserDevice
}
finally {
  restoreLocks()
  restoreAdb()
  restoreDb()
}

function fixture(leaseId: string | null = 'new-lease') {
  unlockDevice.resetHistory()
  const channelRouter = new EventEmitter()
  const push = {send: sinon.spy()}
  const req = {body: {serial: 'device', timeout: 42000, ...(leaseId ? {leaseId} : {})}
    , user: {email: 'runner@example.test', name: 'Runner', group: 'runner-group'
      , privilege: 'user', groups: {subscribed: ['visible-group']}}
    , options: {channelRouter, push}}
  let body: any = null
  const response = {status: () => response, json(value: unknown) {
    body = JSON.parse(JSON.stringify(value))
    return response
  }}
  function joined(id: string | null, reservationId: string) {
    channelRouter.emit(wireutil.global, Buffer.from(wireutil.global), wireutil.envelope(
      new wire.JoinGroupMessage('device', {
        email: req.user.email, name: req.user.name, group: req.user.group, reservationId
      }, 'automation', id)
    ))
  }
  return {req, response, channelRouter, push, joined, body: () => body
    , capture: () => addUserDevice(req as unknown as ApiRequest<AddUserDeviceBody>,
      response as unknown as Response)}
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); ++i) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(check(), 'Expected request to progress')
}

describe('device capture acknowledgment API', function() {
  it('returns reservation identity for legacy capture without adding a lease', async function() {
    const f = fixture(null)
    f.capture()
    await until(() => f.push.send.calledOnce)
    const [channel, bytes] = f.push.send.firstCall.args[0]
    assert.equal(channel, 'runtime-one')
    const envelope = wire.Envelope.decode(bytes)
    assert.equal(wire.GroupMessage.decode(envelope.message).leaseId, null)
    f.joined('older-managed-lease', 'old-reservation')
    assert.equal(f.body(), null, 'A managed capture cannot acknowledge a legacy request')
    f.joined(null, 'legacy-provider-reservation')
    assert.deepEqual(f.body(), {success: true, description: 'Device successfully added'
      , owner: {email: 'runner@example.test', name: 'Runner', group: 'runner-group'
        , reservationId: 'legacy-provider-reservation'}
      , deviceChannel: 'runtime-one'})
    assert.equal(f.channelRouter.listenerCount(wireutil.global), 0)
    assert.equal(unlockDevice.callCount, 1)
  })

  it('returns the provider reservation and exact lease after acknowledgment', async function() {
    const f = fixture()
    f.capture()
    await until(() => f.push.send.calledOnce)
    const [channel, bytes] = f.push.send.firstCall.args[0]
    assert.equal(channel, 'runtime-one')
    const envelope = wire.Envelope.decode(bytes)
    const message = wire.GroupMessage.decode(envelope.message)
    assert.equal(message.leaseId, 'new-lease')
    assert.equal(message.timeout, 42000, 'Direct capture has a bounded lease without renewal')
    assert.equal(f.body(), null)
    f.joined('old-lease', 'old-reservation')
    assert.equal(f.body(), null, 'An older same-account capture must not acknowledge this request')
    f.joined('new-lease', 'provider-reservation')
    assert.deepEqual(f.body(), {success: true, description: 'Device successfully added'
      , owner: {email: 'runner@example.test', name: 'Runner', group: 'runner-group'
        , reservationId: 'provider-reservation'}
      , deviceChannel: 'runtime-one', leaseId: 'new-lease'})
    assert.equal(f.channelRouter.listenerCount(wireutil.global), 0)
    assert.equal(unlockDevice.callCount, 1)
  })
})
