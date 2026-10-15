import assert from 'node:assert/strict'
import http from 'node:http'
import {once} from 'node:events'
import {WebSocket} from 'ws'
import wire from '../../lib/wire/index.js'
import wireutil from '../../lib/wire/util.js'
import {IosBridge} from '../../lib/units/ios-provider/bridge.js'
import {PrototypeClient} from '../../lib/units/ios-provider/client.js'
import {MjpegDecoder} from '../../lib/units/ios-provider/mjpeg.js'
import {authorizeScreen, type IosOwner} from '../../lib/units/ios-provider/access.js'
import {createScreenServer} from '../../lib/units/ios-provider/screen.js'
import {allowIosPacket} from '../../lib/units/websocket/ios-access.js'

const serial = 'TEST-IPHONE'
const owner = {email: 'owner@example.test', name: 'Owner', group: 'owner-group'}
const origin = 'https://stf.example.test'

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as {port: number}
  return 'http://127.0.0.1:' + address.port
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for the expected operation')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('Linux iOS integration', function() {
  const servers: http.Server[] = []
  afterEach(function() {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      server.close()
    }
  })

  async function fixture() {
    const state = {
      udid: serial, state: 'ready', generation: 1
    , info: {ProductType: 'iPhone17,4', ProductVersion: '27.0.1'}
    }
    const requests: {path: string, body: any}[] = []
    const sent: {channel: string, envelope: ReturnType<typeof wire.Envelope.decode>}[] = []
    const png = Buffer.alloc(24)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
    png.writeUInt32BE(1290, 16)
    png.writeUInt32BE(2796, 20)
    const backend = http.createServer(async(req, res) => {
      assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(32))
      if (req.url === '/device') {
        res.end(JSON.stringify(state))
      }
      else if (req.url === '/screenshot') {
        res.setHeader('Content-Type', 'image/png')
        res.end(png)
      }
      else if (req.url === '/screen') {
        res.setHeader('Content-Type', 'multipart/x-mixed-replace;boundary=frame')
        res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n')
        res.write(Buffer.from('ffd80102ffd9', 'hex'))
      }
      else {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk)
        }
        requests.push({path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString())})
        res.end('{"success":true}')
      }
    })
    servers.push(backend)
    const client = new PrototypeClient(await listen(backend), 'a'.repeat(32))
    let disconnects = 0
    const bridge = new IosBridge({
      serial, name: 'Linux', marketName: 'iPhone 16 Plus', screenUrl: 'wss://stf/screen'
    , storageUrl: 'http://127.0.0.1:1', groupTimeout: 900
    }, client, (channel, data) => sent.push({channel, envelope: wire.Envelope.decode(data)}),
    () => {
 disconnects++
}, () => {})
    function send(message: wireutil.Message, transaction = false, channel = bridge.channel) {
      bridge.handle(channel, transaction ?
        wireutil.transaction('reply', message) : wireutil.envelope(message))
    }
    const join = async() => {
      await bridge.poll()
      send(new wire.DeviceRegisteredMessage(serial), false, bridge.solo)
      send(new wire.GroupMessage(owner, 900, [
        new wire.DeviceRequirement('serial', serial, wire.RequirementType.EXACT)
      ]), true)
      await until(() => bridge.owner !== null)
    }
    return {bridge, client, state, requests, sent, send, join, disconnects: () => disconnects}
  }

  it('registers iOS identity and translates STF input and transactions', async function() {
    const f = await fixture()
    await f.join()
    f.send(new wire.ProbeMessage())
    const message = f.sent.find(item => item.envelope.type === wire.DeviceIdentityMessage.$code)
    const identity = wire.DeviceIdentityMessage.decode(message!.envelope.message)
    assert.equal(identity.platform, 'iOS')
    assert.equal(identity.model, 'iPhone17,4')
    assert.equal(identity.display.width, 1290)
    f.send(new wire.TouchDownMessage(0, 0, 0.3, 0.4))
    f.send(new wire.TouchUpMessage(1, 0))
    f.send(new wire.PasteMessage('Hello iPhone'), true)
    f.send(new wire.KeyPressMessage('home'))
    await until(() => f.requests.length === 3)
    assert.deepEqual(f.requests.map(req => req.path), ['/tap', '/text', '/home'])
    assert.equal(f.requests[1]!.body.text, 'Hello iPhone')
    assert.ok(f.sent.some(item => item.channel === 'reply' &&
      item.envelope.type === wire.TransactionDoneMessage.$code &&
      wire.TransactionDoneMessage.decode(item.envelope.message).success))
  })

  it('rejects takeover, foreign channel prefixes and input without ownership', async function() {
    const f = await fixture()
    await f.join()
    f.send(new wire.GroupMessage({...owner, email: 'other@example.test'}, 900, []), true)
    await until(() => f.sent.some(item => item.channel === 'reply' &&
      !wire.TransactionDoneMessage.decode(item.envelope.message).success))
    assert.equal(f.bridge.owner?.email, owner.email)
    f.send(new wire.KeyPressMessage('home'), false, f.bridge.channel + '-forged')
    f.send(new wire.KeyPressMessage('home'), false, f.bridge.solo)
    f.send(new wire.UngroupMessage([]), true, f.bridge.solo)
    assert.equal(f.bridge.owner?.email, owner.email)
    f.bridge.leave('test')
    f.send(new wire.KeyPressMessage('home'))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.requests.length, 0)
  })

  it('invalidates commands on release and WDA recovery', async function() {
    const f = await fixture()
    await f.join()
    f.send(new wire.TypeMessage('stale'))
    f.bridge.leave('test')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.requests.length, 0)
    await f.join()
    f.state.generation++
    f.send(new wire.PasteMessage('also stale'), true)
    await until(() => f.sent.some(item => item.channel === 'reply' &&
      !wire.TransactionDoneMessage.decode(item.envelope.message).success))
    assert.equal(f.requests.length, 0)
    await f.bridge.poll()
    assert.equal(f.bridge.owner, null)
    assert.ok(f.disconnects() > 0)
  })

  it('does not turn a multi-finger gesture into an unintended tap', async function() {
    const f = await fixture()
    await f.join()
    f.send(new wire.TouchDownMessage(0, 0, 0.3, 0.4))
    f.send(new wire.TouchDownMessage(1, 1, 0.6, 0.4))
    f.send(new wire.TouchUpMessage(2, 0))
    f.send(new wire.GestureStopMessage(3))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.requests.length, 0)
  })

  it('checks iOS ownership and group access without changing Android', async function() {
    const user = {email: owner.email, groups: {subscribed: ['root']}}
    const device = {
      serial, platform: 'iOS', channel: 'ios:' + serial, present: true, ready: true
    , group: {id: 'root'}, owner: null as {email: string} | null
    }
    const load = async() => device
    assert.equal(await allowIosPacket('group.invite', device.channel, user, load), true)
    assert.equal(await allowIosPacket('input.keyPress', device.channel, user, load), false)
    device.owner = owner
    assert.equal(await allowIosPacket('input.keyPress', device.channel, user, load), true)
    assert.equal(await allowIosPacket('group.kick', device.channel,
      {...user, email: 'other@example.test'}, load), false)
    assert.equal(await allowIosPacket('group.invite', device.channel,
      {...user, groups: {subscribed: []}}, load), false)
    device.ready = false
    assert.equal(await allowIosPacket('input.keyPress', device.channel, user, load), false)
    assert.equal(await allowIosPacket('input.keyPress', 'android-channel', user,
      () => {
 throw new Error('Android must not query the iOS guard')
}), true)
  })

  it('reassembles split MJPEG frames and rejects missing or oversized lengths', function() {
    const decoder = new MjpegDecoder()
    const part = Buffer.concat([
      Buffer.from('--frame\r\nContent-Length: 6\r\n\r\n')
    , Buffer.from('ffd80102ffd9', 'hex'), Buffer.from('\r\n')
    ])
    const frames: Buffer[] = []
    const stream = Buffer.concat([part, part])
    for (let i = 0; i < stream.length; i++) {
      frames.push(...decoder.feed(stream.subarray(i, i + 1)))
    }
    assert.equal(frames.length, 2)
    assert.deepEqual(frames[0], Buffer.from('ffd80102ffd9', 'hex'))
    assert.throws(() => new MjpegDecoder().feed(Buffer.from('Content-Length: 99999999\r\n\r\n')))
    assert.throws(() => new MjpegDecoder().feed(Buffer.from('Content-Type: image/jpeg\r\n\r\n')))
  })

  it('authenticates the screen using STF ownership and streams the existing JPEG protocol',
    async function() {
      const f = await fixture()
      let allowed = true
      const api = http.createServer((req, res) => {
        assert.equal(req.url, '/api/v1/user/devices/' + serial)
        assert.equal(req.headers.cookie, 'session=signed')
        res.writeHead(allowed ? 200 : 403)
        res.end(JSON.stringify({success: allowed, device: {serial, owner}}))
      })
      servers.push(api)
      const apiUrl = await listen(api)
      const headers = {origin, cookie: 'session=signed'}
      assert.equal(await authorizeScreen(apiUrl, origin, serial, owner, headers), true)
      assert.equal(await authorizeScreen(apiUrl, origin, serial, owner,
        {...headers, origin: 'https://foreign.test'}), false)
      assert.equal(await authorizeScreen(apiUrl, origin, serial, null, headers), false)
      let currentOwner: IosOwner | null = owner
      const screen = createScreenServer({
        client: f.client, apiUrl, publicOrigin: origin, serial
      , owner: () => currentOwner, keepalive: () => {}
      })
      const url = (await listen(screen.server)).replace('http:', 'ws:')
      const ws = new WebSocket(url, {headers})
      const messages: {data: Buffer, binary: boolean}[] = []
      ws.on('message', (data, binary) => messages.push({data: data as Buffer, binary}))
      try {
        await once(ws, 'open')
        ws.send('on')
        await until(() => messages.some(message => message.binary))
        assert.ok(messages[0]!.data.toString().startsWith('start '))
        assert.deepEqual(messages.find(message => message.binary)!.data,
          Buffer.from('ffd80102ffd9', 'hex'))
        allowed = false
        assert.equal(await authorizeScreen(apiUrl, origin, serial, owner, headers), false)
        currentOwner = null
        const closed = once(ws, 'close')
        ws.send('ping')
        await closed
      }
      finally {
        ws.terminate()
        screen.close()
      }
    })
})
