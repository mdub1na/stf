import type {IncomingHttpHeaders} from 'node:http'

export interface IosOwner {
  email: string
  name: string
  group: string
}

export async function authorizeScreen(
  apiUrl: string
, publicOrigin: string
, serial: string
, owner: IosOwner | null
, headers: IncomingHttpHeaders
): Promise<boolean> {
  if (!owner || (headers.origin !== publicOrigin &&
      !(headers.origin === undefined && headers.authorization?.startsWith('Bearer ')))) {
    return false
  }
  const credentials: Record<string, string> = {}
  if (headers.cookie) {
    credentials.Cookie = headers.cookie
  }
  if (headers.authorization) {
    credentials.Authorization = headers.authorization
  }
  if (!Object.keys(credentials).length) {
    return false
  }
  try {
    const url = new URL('/api/v1/user/devices/' + encodeURIComponent(serial), apiUrl)
    const response = await fetch(url, {
      headers: credentials, signal: AbortSignal.timeout(5000), redirect: 'error'
    })
    if (!response.ok) {
      await response.body?.cancel()
      return false
    }
    const body = await response.json() as {
      success?: boolean, device?: {serial?: string, owner?: {email?: string}}
    }
    return body.success === true && body.device?.serial === serial &&
      body.device.owner?.email === owner.email
  }
  catch {
    return false
  }
}
