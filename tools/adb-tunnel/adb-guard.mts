import {Transform} from 'node:stream'
import type {TransformCallback} from 'node:stream'

const HEADER_LENGTH = 24
const MAX_PAYLOAD = 1024 * 1024
const CLIENT_COMMANDS = new Set(['CNXN', 'AUTH', 'OPEN', 'OKAY', 'WRTE', 'CLSE'])
const utf8 = new TextDecoder('utf-8', {fatal: true})

export interface AdbGuardOptions {
  maxPayload?: number
}

function checkHeader(header: Buffer, maxPayload: number): {command: string, length: number} {
  const commandNumber = header.readUInt32LE(0)
  const command = header.toString('latin1', 0, 4)
  const arg0 = header.readUInt32LE(4)
  const arg1 = header.readUInt32LE(8)
  const length = header.readUInt32LE(12)

  if (header.readUInt32LE(20) !== ((commandNumber ^ 0xffffffff) >>> 0)) {
    throw new Error('Invalid ADB packet magic')
  }
  if (!CLIENT_COMMANDS.has(command)) {
    throw new Error('Unsupported ADB packet command')
  }
  if (length > maxPayload) {
    throw new Error('ADB packet exceeds the payload limit')
  }

  switch (command) {
    case 'CNXN':
      if (!arg0 || !arg1 || !length) {
        throw new Error('Invalid ADB connection packet')
      }
      break
    case 'AUTH':
      if ((arg0 !== 2 && arg0 !== 3) || arg1 !== 0 || !length) {
        throw new Error('Invalid ADB client authentication packet')
      }
      break
    case 'OPEN':
      if (!arg0 || arg1 !== 0 || length < 2) {
        throw new Error('Invalid ADB service open packet')
      }
      break
    case 'OKAY':
      if (!arg0 || !arg1 || length !== 0) {
        throw new Error('Invalid ADB acknowledgement packet')
      }
      break
    case 'WRTE':
      if (!arg0 || !arg1) {
        throw new Error('Invalid ADB data packet identifiers')
      }
      break
    case 'CLSE':
      // A zero sender identifier is permitted for a rejected OPEN.
      if (!arg1 || length !== 0) {
        throw new Error('Invalid ADB close packet')
      }
      break
  }

  return {command, length}
}

function checkService(payload: Buffer): void {
  // adbkit strips the last byte unconditionally. Validate the complete name before
  // letting its smart-socket client see any part of this packet.
  if (payload[payload.length - 1] !== 0 || payload.indexOf(0) !== payload.length - 1) {
    throw new Error('ADB service names must have one terminating NUL')
  }

  let service: string
  try {
    service = utf8.decode(payload.subarray(0, -1))
  }
  catch {
    throw new Error('ADB service name is not valid UTF-8')
  }

  if (service.startsWith('host:') || service.startsWith('host-') || service === 'host') {
    throw new Error('ADB server commands are forbidden in a device tunnel')
  }
  if (service.startsWith('reverse:')) {
    throw new Error('ADB reverse is unsupported: this bridge connects to the farm, not the developer computer')
  }

  if (/^shell(?:,[A-Za-z0-9_=./-]+(?:,[A-Za-z0-9_=./-]+)*)?:/.test(service)
      || service.startsWith('exec:')
      || service === 'sync:'
      || service === 'jdwp'
      || service === 'track-jdwp'
      || service === 'track-app'
      || /^log:[A-Za-z0-9_-]+$/.test(service)
      || /^(?:localabstract|localreserved|localfilesystem):[^\x00-\x1f\x7f]+$/.test(service)
      || /^(?:root|unroot|framebuffer):$/.test(service)
      || /^(?:reboot|remount):[A-Za-z0-9_,=-]*$/.test(service)) {
    return
  }

  const endpoint = /^(tcp|jdwp):([1-9][0-9]*)$/.exec(service)
  if (endpoint) {
    const number = Number(endpoint[2])
    const limit = endpoint[1] === 'tcp' ? 65535 : 0x7fffffff
    if (Number.isSafeInteger(number) && number <= limit) {
      return
    }
  }

  throw new Error('ADB service is not permitted in a device tunnel')
}

class AdbGuard extends Transform {
  private readonly header = Buffer.alloc(HEADER_LENGTH)
  private readonly maxPayload: number
  private headerBytes = 0
  private packet: Buffer | null = null
  private packetBytes = 0
  private command = ''

  constructor(maxPayload: number) {
    super()
    this.maxPayload = maxPayload
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (!this.packet) {
          const length = Math.min(HEADER_LENGTH - this.headerBytes, chunk.length - offset)
          chunk.copy(this.header, this.headerBytes, offset, offset + length)
          this.headerBytes += length
          offset += length
          if (this.headerBytes !== HEADER_LENGTH) {
            continue
          }

          const header = checkHeader(this.header, this.maxPayload)
          this.command = header.command
          // Allocate once per validated packet, never from an unchecked wire length.
          this.packet = Buffer.allocUnsafe(HEADER_LENGTH + header.length)
          this.header.copy(this.packet)
          this.packetBytes = HEADER_LENGTH
        }

        const length = Math.min(this.packet.length - this.packetBytes, chunk.length - offset)
        chunk.copy(this.packet, this.packetBytes, offset, offset + length)
        this.packetBytes += length
        offset += length
        if (this.packetBytes === this.packet.length) {
          this.finishPacket()
        }
      }
      callback()
    }
    catch (error) {
      callback(error instanceof Error ? error : new Error('Invalid ADB packet'))
    }
  }

  private finishPacket(): void {
    const packet = this.packet!
    const payload = packet.subarray(HEADER_LENGTH)
    const expectedChecksum = packet.readUInt32LE(16)
    // ADB 0x01000001 permits a zero checksum. Legacy peers still send a sum.
    if (expectedChecksum !== 0) {
      let checksum = 0
      for (const byte of payload) {
        checksum = (checksum + byte) >>> 0
      }
      if (checksum !== expectedChecksum) {
        throw new Error('Invalid ADB packet checksum')
      }
    }
    if (this.command === 'OPEN') {
      checkService(payload)
    }

    this.packet = null
    this.packetBytes = 0
    this.headerBytes = 0
    this.push(packet)
  }

  override _flush(callback: TransformCallback): void {
    callback(this.headerBytes || this.packet ? new Error('Truncated ADB packet') : undefined)
  }
}

/** Validate complete client packets before exposing them to the legacy ADB smart-socket bridge. */
export function createAdbGuard({maxPayload = MAX_PAYLOAD}: AdbGuardOptions = {}): Transform {
  if (!Number.isSafeInteger(maxPayload) || maxPayload < 1 || maxPayload > MAX_PAYLOAD) {
    throw new RangeError('ADB payload limit must be an integer from 1 to 1048576 bytes')
  }
  return new AdbGuard(maxPayload)
}
