import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import {Readable} from 'node:stream'

export interface IpaSignerOptions {
  url: URL
  token: string
  targetBundleId?: string
}

const signingErrors: Record<number, string> = {
  '403': 'IOS_IPA_SIGNING_NOT_ALLOWED'
, '413': 'IOS_IPA_TOO_LARGE'
, '422': 'IOS_IPA_SIGNING_FAILED'
, '429': 'IOS_IPA_SIGNING_BUSY'
, '502': 'IOS_IPA_SIGNING_FAILED'
}

export class IpaSigningError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export function ipaSignerOptions(
  origin: string, token: string, targetBundleId?: string
): IpaSignerOptions {
  const url = new URL(origin)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('IPA signing requires an HTTPS or loopback origin and a dedicated bearer token')
  }
  if (typeof targetBundleId === 'string' &&
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(targetBundleId)) {
    throw new Error('The IPA signer target Bundle ID is invalid')
  }
  return {url: new URL('/sign', url), token, ...(targetBundleId ? {targetBundleId} : {})}
}

export async function signIpa(
  options: IpaSignerOptions, inputPath: string, outputPath: string,
  device: {udid: string, iosVersion: string}, maxBytes: number, owner: AbortSignal
): Promise<void> {
  const signal = AbortSignal.any([owner, AbortSignal.timeout(180000)])
  try {
    const inputHash = createHash('sha256')
    let inputLength = 0
    for await (const chunk of createReadStream(inputPath, {signal})) {
      inputLength += chunk.length
      inputHash.update(chunk)
    }
    const input = createReadStream(inputPath, {signal})
    const request: RequestInit & {duplex: 'half'} = {
      method: 'POST'
    , redirect: 'error'
    , signal
    , duplex: 'half'
    , headers: {
        Authorization: 'Bearer ' + options.token
      , 'Content-Type': 'application/octet-stream'
      , 'Content-Length': String(inputLength)
      , 'X-STF-IPA-UDID': device.udid
      , 'X-STF-IPA-IOS-Version': device.iosVersion
      , 'X-STF-IPA-SHA256': inputHash.digest('hex')
      }
    , body: Readable.toWeb(input)
    }
    const response = await fetch(options.url, request).catch(error => {
      input.destroy()
      throw error
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new IpaSigningError(signingErrors[response.status] || 'IOS_IPA_SIGNING_UNAVAILABLE')
    }
    const lengthHeader = response.headers.get('content-length')
    const length = Number(lengthHeader)
    const digest = response.headers.get('x-stf-ipa-sha256')
    if (response.status !== 200 || !response.body ||
        response.headers.get('content-type') !== 'application/octet-stream' ||
        !lengthHeader || !/^\d+$/.test(lengthHeader) || length < 1 || length > maxBytes ||
        !digest || !/^[a-f0-9]{64}$/.test(digest)) {
      await response.body?.cancel()
      throw new IpaSigningError('IOS_IPA_SIGNING_FAILED')
    }
    const output = await fs.open(outputPath, 'wx', 0o600)
    const outputHash = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        bytes += chunk.length
        if (bytes > length) {
          throw new IpaSigningError('IOS_IPA_SIGNING_FAILED')
        }
        outputHash.update(chunk)
        await output.writeFile(chunk)
      }
    }
    finally {
      await output.close()
    }
    if (bytes !== length || outputHash.digest('hex') !== digest) {
      throw new IpaSigningError('IOS_IPA_SIGNING_FAILED')
    }
  }
  catch (error) {
    owner.throwIfAborted()
    if (error instanceof IpaSigningError) {
      throw error
    }
    throw new IpaSigningError('IOS_IPA_SIGNING_UNAVAILABLE')
  }
}
