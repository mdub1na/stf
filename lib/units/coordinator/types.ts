export interface AdbPool {
  provider: string
  host: string
  port: number
  systemPorts: number[]
}

export interface CoordinatorOptions {
  host: string
  port: number
  publicUrl: string
  stfApiUrl: string
  stfTokenFile: string
  apiTokenFile: string
  appiumGridUrl: string
  stateFile: string
  adbPoolsFile: string
  leaseTtlSeconds: number
  heartbeatIntervalSeconds: number
  pollIntervalSeconds: number
  maxDurationSeconds: number
  maxParallel: number
  upstreamTimeoutSeconds: number
}

export type Platform = 'Android' | 'iOS'
export type RequestState = 'queued' | 'allocated' | 'cancelled' | 'expired' | 'failed'
export type LeaseState = 'allocating' | 'active' | 'cleaning' |
  'released' | 'expired' | 'quarantined'

export interface AllocationInput {
  runId: string
  platform: Platform
  serial?: string
  model?: string
  provider?: string
  queueTimeoutSeconds: number
  maxDurationSeconds: number
}

export interface AllocationRequest {
  id: string
  key: string
  fingerprint: string
  input: AllocationInput
  state: RequestState
  createdAt: number
  queueDeadlineAt: number
  leaseId?: string
  error?: string
}

export interface FarmDevice {
  serial: string
  model: string
  platform: Platform
  version: string
  provider: string
  present: boolean
  ready: boolean
  using?: boolean
  claimed?: boolean
  owner?: {email: string} | null
  usage?: string | null
  automationLeaseId?: string | null
}

export interface Lease {
  id: string
  requestId: string
  runId: string
  state: LeaseState
  device: FarmDevice
  capabilities: Record<string, unknown>
  expiresAt: number
  deadlineAt: number
  createdAt: number
  sessionId?: string
  creatingSession?: boolean
  commandInFlight?: boolean
  captureUncertain?: boolean
  captureConfirmed?: boolean
  finishState?: 'released' | 'expired'
  error?: string
}

export interface CoordinatorState {
  version: 1
  requests: AllocationRequest[]
  leases: Lease[]
}

export interface GridSlot {
  stereotype: Record<string, unknown>
  session: null | {sessionId: string, capabilities: Record<string, unknown>}
}

export interface GridStatus {
  ready: boolean
  nodes: {id: string, availability: string, slots: GridSlot[]}[]
}

export interface UpstreamResponse {
  status: number
  contentType: string
  body: Buffer
}

export interface FarmBackend {
  identity(): Promise<{email: string}>
  devices(): Promise<FarmDevice[]>
  grid(): Promise<GridStatus>
  capture(serial: string, leaseId: string, timeout: number): Promise<void>
  renew(serial: string, leaseId: string, timeout: number): Promise<void>
  release(serial: string, leaseId: string): Promise<void>
  webdriver(method: string, path: string, body?: unknown): Promise<UpstreamResponse>
}
