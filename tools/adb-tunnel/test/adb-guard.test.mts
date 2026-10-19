import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {Readable, Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {createAdbGuard} from '../adb-guard.mts'
import type {AdbGuardOptions} from '../adb-guard.mts'

// Encode independently of the guard, using the documented 24-byte ADB wire header.
function packet(command: string, arg0: number, arg1: number, payload = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(24 + payload.length)
  result.write(command, 0, 4, 'ascii')
  result.writeUInt32LE(arg0, 4)
  result.writeUInt32LE(arg1, 8)
  result.writeUInt32LE(payload.length, 12)
  result.writeUInt32LE(payload.reduce((sum, byte) => (sum + byte) >>> 0, 0), 16)
  result.writeUInt32LE((result.readUInt32LE(0) ^ 0xffffffff) >>> 0, 20)
  payload.copy(result, 24)
  return result
}

function open(service: string): Buffer {
  return packet('OPEN', 7, 0, Buffer.from(service + '\0'))
}

async function inspect(chunks: Buffer[], options?: AdbGuardOptions): Promise<Buffer> {
  const accepted: Buffer[] = []
  await pipeline(
    Readable.from(chunks),
    createAdbGuard(options),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        accepted.push(Buffer.from(chunk))
        callback()
      }
    })
  )
  return Buffer.concat(accepted)
}

describe('ADB device tunnel guard', () => {
  it('preserves common client packets byte for byte across single-byte chunks', async() => {
    const input = Buffer.concat([
      packet('CNXN', 0x01000001, 1024 * 1024, Buffer.from('host::features=shell_v2;\0')),
      packet('AUTH', 2, 0, Buffer.alloc(256, 0xa5)),
      packet('AUTH', 3, 0, Buffer.from('public-key test-key\0')),
      open('sync:'),
      packet('OKAY', 7, 9),
      packet('WRTE', 7, 9, Buffer.from('host:devices\0arbitrary binary\xff')),
      packet('CLSE', 7, 9),
      packet('CLSE', 0, 9)
    ])
    const chunks = Array.from(input, (_byte, index) => input.subarray(index, index + 1))
    assert.deepEqual(await inspect(chunks), input)
  })

  it('accepts fragmented and coalesced packets with empty payloads', async() => {
    const input = Buffer.concat([
      open('shell:logcat -v threadtime'),
      packet('OKAY', 1, 2),
      packet('CLSE', 1, 2),
      open('jdwp:123')
    ])
    assert.deepEqual(await inspect([
      input.subarray(0, 23), input.subarray(23, 25), input.subarray(25, 55), input.subarray(55)
    ]), input)
  })

  const services = [
    'shell:',
    'shell:echo host:devices; echo host-serial:another:transport',
    'shell,v2,raw:cmd package install -S 1000',
    'shell,v2,TERM=xterm-256color,pty:logcat',
    'exec:cmd package install-write -S 1000 session base.apk -',
    'exec:screencap -p',
    'sync:',
    'jdwp',
    'jdwp:2147483647',
    'track-jdwp',
    'track-app',
    'tcp:1',
    'tcp:65535',
    'localabstract:chrome_devtools_remote',
    'localreserved:some_device_socket',
    'localfilesystem:/data/local/tmp/device.sock',
    'log:main',
    'reboot:',
    'reboot:bootloader',
    'root:',
    'unroot:',
    'remount:',
    'remount:-R',
    'framebuffer:'
  ]
  for (const service of services) {
    it(`accepts device service ${service}`, async() => {
      const input = open(service)
      assert.deepEqual(await inspect([input]), input)
    })
  }

  const forbidden = [
    'host',
    'host:devices',
    'host:transport:other-device',
    'host-serial:other-device:shell:id',
    'host-transport-id:42:features',
    'host-usb:transport-any',
    'host-local:features',
    'host:forward:tcp:1234;tcp:1234',
    'reverse:forward:tcp:8080;tcp:8080',
    'reverse:list-forward',
    'tcp:8080:example.com',
    'tcp:0',
    'tcp:65536',
    'tcp:-1',
    'jdwp:0',
    'jdwp:2147483648',
    'localabstract:',
    'sync:host:devices',
    'abb:package',
    'abb_exec:package',
    ' shell:echo test',
    'unknown:service'
  ]
  for (const service of forbidden) {
    it(`rejects forbidden or unsupported service ${service}`, async() => {
      await assert.rejects(inspect([open(service)]), /forbidden|unsupported|not permitted/)
    })
  }

  it('gives a useful reverse error without exposing the requested service', async() => {
    await assert.rejects(inspect([open('reverse:forward:tcp:12345;tcp:54321')]), error => {
      assert.match((error as Error).message, /reverse is unsupported/)
      assert.doesNotMatch((error as Error).message, /12345|54321/)
      return true
    })
  })

  it('does not pass any bytes of a forbidden packet to the bridge', async() => {
    const guard = createAdbGuard()
    const forwarded: Buffer[] = []
    guard.on('data', chunk => forwarded.push(chunk))
    await assert.rejects(pipeline(Readable.from([open('host:devices')]), guard), /forbidden/)
    assert.equal(forwarded.length, 0)
  })

  it('rejects missing and embedded NUL bytes rather than inspecting only a prefix', async() => {
    for (const payload of [
      Buffer.from('shell:id'),
      Buffer.from('shell:id\0host:devices\0'),
      Buffer.from('shell:id\0\0'),
      Buffer.from('shell:\xff\0', 'latin1')
    ]) {
      await assert.rejects(inspect([packet('OPEN', 1, 0, payload)]), /terminating NUL|UTF-8/)
    }
  })

  it('accepts a zero checksum as used by modern ADB', async() => {
    const input = open('shell:logcat')
    input.writeUInt32LE(0, 16)
    assert.deepEqual(await inspect([input]), input)
  })

  it('rejects an incorrect nonzero checksum before forwarding the packet', async() => {
    const input = open('shell:logcat')
    input.writeUInt32LE(0xdeadbeef, 16)
    await assert.rejects(inspect([input]), /checksum/)
  })

  it('rejects a nonzero checksum on an empty payload', async() => {
    const input = packet('OKAY', 1, 2)
    input.writeUInt32LE(1, 16)
    await assert.rejects(inspect([input]), /checksum/)
  })

  it('rejects a corrupted command magic', async() => {
    const input = open('sync:')
    input.writeUInt32LE(0, 20)
    await assert.rejects(inspect([input]), /magic/)
  })

  it('rejects unknown commands including unsupported TLS negotiation', async() => {
    for (const command of ['STLS', 'SYNC', 'FAIL', 'HTTP']) {
      await assert.rejects(inspect([packet(command, 1, 0)]), /Unsupported ADB packet command/)
    }
  })

  it('does not treat high-bit command bytes as their ASCII counterparts', async() => {
    const input = packet('OPEN', 1, 0, Buffer.from('sync:\0'))
    input[0] = input[0]! | 0x80
    input.writeUInt32LE((input.readUInt32LE(0) ^ 0xffffffff) >>> 0, 20)
    await assert.rejects(inspect([input]), /Unsupported ADB packet command/)
  })

  const badPackets: Array<[string, Buffer]> = [
    ['CNXN zero version', packet('CNXN', 0, 4096, Buffer.from('host::\0'))],
    ['CNXN zero capacity', packet('CNXN', 0x01000001, 0, Buffer.from('host::\0'))],
    ['CNXN empty banner', packet('CNXN', 0x01000001, 4096)],
    ['AUTH server challenge', packet('AUTH', 1, 0, Buffer.alloc(20))],
    ['AUTH extra argument', packet('AUTH', 2, 1, Buffer.alloc(256))],
    ['AUTH empty signature', packet('AUTH', 2, 0)],
    ['OPEN zero sender', packet('OPEN', 0, 0, Buffer.from('sync:\0'))],
    ['OPEN nonzero receiver', packet('OPEN', 1, 2, Buffer.from('sync:\0'))],
    ['OPEN empty service', packet('OPEN', 1, 0, Buffer.from('\0'))],
    ['OKAY zero sender', packet('OKAY', 0, 1)],
    ['OKAY zero receiver', packet('OKAY', 1, 0)],
    ['OKAY payload', packet('OKAY', 1, 2, Buffer.from('unexpected'))],
    ['WRTE zero sender', packet('WRTE', 0, 1, Buffer.from('data'))],
    ['WRTE zero receiver', packet('WRTE', 1, 0, Buffer.from('data'))],
    ['CLSE zero receiver', packet('CLSE', 1, 0)],
    ['CLSE payload', packet('CLSE', 1, 2, Buffer.from('unexpected'))]
  ]
  for (const [name, input] of badPackets) {
    it(`rejects invalid fields: ${name}`, async() => {
      await assert.rejects(inspect([input]), /Invalid ADB/)
    })
  }

  it('rejects an oversized declared payload from the header alone', async() => {
    const input = packet('WRTE', 1, 2)
    input.writeUInt32LE(0xffffffff, 12)
    await assert.rejects(inspect([input]), /payload limit/)
  })

  it('respects a lower configured payload limit', async() => {
    const input = packet('WRTE', 1, 2, Buffer.alloc(64))
    assert.deepEqual(await inspect([input], {maxPayload: 64}), input)
    await assert.rejects(inspect([input], {maxPayload: 63}), /payload limit/)
  })

  it('accepts the bounded maximum packet split across many chunks', async() => {
    const input = packet('WRTE', 1, 2, Buffer.alloc(1024 * 1024, 0xff))
    const chunks: Buffer[] = []
    for (let offset = 0; offset < input.length; offset += 1023) {
      chunks.push(input.subarray(offset, offset + 1023))
    }
    assert.deepEqual(await inspect(chunks), input)
  })

  it('rejects truncated final headers and payloads', async() => {
    const input = open('shell:logcat')
    for (const length of [1, 23, 24, input.length - 1]) {
      await assert.rejects(inspect([input.subarray(0, length)]), /Truncated ADB packet/)
    }
    await assert.rejects(inspect([input, input.subarray(0, 8)]), /Truncated ADB packet/)
  })

  it('accepts an empty stream', async() => {
    assert.deepEqual(await inspect([]), Buffer.alloc(0))
  })

  it('refuses invalid limits that could disable the memory bound', () => {
    for (const maxPayload of [0, -1, 1.5, NaN, Infinity, 1024 * 1024 + 1]) {
      assert.throws(() => createAdbGuard({maxPayload}), /payload limit/)
    }
  })
})
