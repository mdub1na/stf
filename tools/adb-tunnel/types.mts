export interface Target {
  serial: string
  email: string
  host: string
  port: number
  provider: string
  binding: string
}

export interface Access {
  open(token: string, serial: string, signal?: AbortSignal): Promise<Target>
  check(token: string, target: Target, signal?: AbortSignal): Promise<void>
}

export interface GatewaySession {
  id: string
  serial: string
  websocketUrl: string
  ticket: string
  controlToken: string
  expiresAt: string
  sessionExpiresAt: string
}

export class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export function originUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new Error(`${label} must be an absolute HTTPS origin`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an HTTPS origin (HTTP is allowed only on loopback)`)
  }
  return url
}
