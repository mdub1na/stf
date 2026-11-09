import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash, randomBytes} from 'node:crypto'
import {execFile} from 'node:child_process'
import {parseArgs} from 'node:util'

export interface FleetDevice {
  udid: string
  node: string
  wdaBundleId: string
  marketName?: string
  legacy?: boolean
}

export interface FleetConfig {
  prototypeImage: string
  stfImage: string
  publicOrigin: string
  devices: FleetDevice[]
}

const namespace = 'stf-ios-prototype'
const image = /^ghcr\.io\/mdub1na\/stf(?::ios-(?:prototype|stf)-[a-f0-9]{40}|@sha256:[a-f0-9]{64})$/
const socketProbe = {
  exec: {command: ['node', '-e', 'const s=require("node:net").connect("/run/usbmuxd");' +
    's.setTimeout(2000,()=>process.exit(1));s.once("error",()=>process.exit(1));' +
    's.once("connect",()=>{s.destroy();process.exit(0)})']}
  , initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 2
}
const userSecurity = {runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false
  , capabilities: {drop: ['ALL']}}

export function deviceResources(device: FleetDevice) {
  const id = createHash('sha256').update(device.udid.toLowerCase()).digest('hex').slice(0, 12)
  return device.legacy ? {name: 'ios-prototype', config: 'ios-device', pvc: 'ios-state'
    , token: 'ios-api-token', service: 'ios-provider', proxy: 'stf-ios-provider'
    , labels: {app: 'stf-ios-prototype'}} : {
    name: 'ios-' + id, config: 'ios-' + id, pvc: 'ios-' + id, token: 'ios-' + id + '-token'
    , service: 'ios-' + id, proxy: 'stf-ios-' + id
    , labels: {app: 'stf-ios-device', 'stf-ios-instance': id}
  }
}

export function validateFleet(input: unknown): FleetConfig {
  const config = input as FleetConfig
  if (!config || !image.test(config.prototypeImage) || !image.test(config.stfImage) ||
      !Array.isArray(config.devices) || !config.devices.length || config.devices.length > 32) {
    throw new Error('Provide two published STF images and 1..32 explicitly selected devices')
  }
  const origin = new URL(config.publicOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) {
    throw new Error('publicOrigin must be an HTTPS origin without a path or credentials')
  }
  const udids = new Set<string>()
  let legacy = 0
  for (const device of config.devices) {
    if (!device || typeof device.udid !== 'string' ||
        !/^[A-Za-z0-9-]{8,80}$/.test(device.udid) || typeof device.node !== 'string' ||
        device.node.length > 253 || !device.node.split('.').every(label =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        typeof device.wdaBundleId !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,255}$/.test(device.wdaBundleId) ||
        ('marketName' in device && (typeof device.marketName !== 'string' ||
          device.marketName.length > 255)) ||
        ('legacy' in device && typeof device.legacy !== 'boolean') ||
        udids.has(device.udid.toLowerCase())) {
      throw new Error('Invalid or duplicate fleet device')
    }
    udids.add(device.udid.toLowerCase())
    legacy += Number(device.legacy === true)
  }
  if (legacy > 1) {
    throw new Error('Only the existing primary device may use legacy resource names')
  }
  return config
}

export function renderFleet(input: unknown) {
  const config = validateFleet(input)
  const items: any[] = [{apiVersion: 'v1', kind: 'Namespace', metadata: {name: namespace}}]
  const object = (apiVersion: string, kind: string, name: string, content: object) =>
    ({apiVersion, kind, metadata: {name, namespace}, ...content})
  for (const device of config.devices) {
    const r = deviceResources(device)
    const env = [
      {name: 'IOS_UDID', valueFrom: {configMapKeyRef: {name: r.config, key: 'udid'}}}
    , {name: 'WDA_BUNDLE_ID', valueFrom: {configMapKeyRef: {name: r.config, key: 'wda-bundle-id'}}}
    ]
    const state = {name: 'state', mountPath: '/state'}
    const usb = {name: 'usbmuxd', mountPath: '/run/usbmuxd', readOnly: true}
    const token = {name: 'token', mountPath: '/token', readOnly: true}
    items.push(object('v1', 'ConfigMap', r.config,
      {data: {udid: device.udid, 'wda-bundle-id': device.wdaBundleId}}))
    items.push(object('v1', 'PersistentVolumeClaim', r.pvc, {spec: {
      accessModes: ['ReadWriteOnce'], storageClassName: 'local-path'
    , resources: {requests: {storage: '5Gi'}}
    }}))
    items.push(object('apps/v1', 'Deployment', r.name, {spec: {
      replicas: 1, strategy: {type: 'Recreate'}, selector: {matchLabels: r.labels}
    , template: {metadata: {labels: r.labels}, spec: {
        nodeSelector: {'kubernetes.io/hostname': device.node}, automountServiceAccountToken: false
      , terminationGracePeriodSeconds: 30
      , initContainers: [{name: 'state', image: config.prototypeImage
        , command: ['sh', '-ec', 'mkdir -p /state/remotepairing /state/home; ' +
          'chmod 700 /state/remotepairing; chown 1000:1000 /state/home']
        , securityContext: {runAsUser: 0}, volumeMounts: [state]}]
      , containers: [
          {name: 'tunnel', image: config.prototypeImage, command: ['ios']
          , args: ['--udid=$(IOS_UDID)', '--tunnel-info-port=28100', 'tunnel', 'start'
            , '--pair-record-path=/state/remotepairing']
          , env: [env[0]], securityContext: {privileged: true, runAsUser: 0}
          , resources: {requests: {cpu: '50m', memory: '64Mi'}, limits: {cpu: '1', memory: '512Mi'}}
          , livenessProbe: socketProbe
          , volumeMounts: [usb, state, {name: 'tun', mountPath: '/dev/net/tun'}]}
        , {name: 'prototype', image: config.prototypeImage, securityContext: userSecurity, env
          , args: ['node', 'tools/ios-prototype/main.mts', '--udid=$(IOS_UDID)'
            , '--wda-bundle-id=$(WDA_BUNDLE_ID)', '--image-mounter=pymobiledevice3'
            , '--token-file=/token/token'
            , '--storage-url=http://stf-storage-temp.stf.svc.cluster.local:3000']
          , resources: {requests: {cpu: '100m', memory: '256Mi'}, limits: {cpu: '2', memory: '2Gi'}}
          , livenessProbe: socketProbe
          , readinessProbe: {exec: {command: ['node', '-e'
              , 'fetch("http://127.0.0.1:7400/device",{headers:{Authorization:"Bearer "+' +
              'require("node:fs").readFileSync("/token/token","utf8").trim()}})' +
              '.then(async r=>process.exit(r.ok&&(await r.json()).state==="ready"?0:1))' +
              '.catch(()=>process.exit(1))']}, periodSeconds: 10, initialDelaySeconds: 5}
          , volumeMounts: [usb, token, {name: 'state', mountPath: '/home/node', subPath: 'home'}]}
        , {name: 'stf-provider', image: config.stfImage, securityContext: userSecurity
          , command: ['node', 'lib/cli/index.js', 'ios-provider']
          , args: ['--serial=$(IOS_UDID)', '--token-file=/token/token'
            , '--api-url=http://stf-api.stf.svc.cluster.local:3000'
            , '--public-origin=' + config.publicOrigin
            , '--storage-url=http://stf-storage-temp.stf.svc.cluster.local:3000'
            , '--screen-url=' + config.publicOrigin.replace('https:', 'wss:') +
              '/d/' + r.proxy + '/17440/'
            , '--market-name=' + (device.marketName || '')
            , '--connect-push=tcp://stf-triproxy-dev.stf.svc.cluster.local:7270'
            , '--connect-sub=tcp://stf-triproxy-dev.stf.svc.cluster.local:7250']
          , env: [env[0]], ports: [{name: 'screen', containerPort: 17440}]
          , resources: {requests: {cpu: '100m', memory: '128Mi'}
            , limits: {cpu: '1', memory: '512Mi'}}
          , readinessProbe: {tcpSocket: {port: 'screen'}, periodSeconds: 5}
          , volumeMounts: [token]}
        ]
      , volumes: [{name: 'state', persistentVolumeClaim: {claimName: r.pvc}}
        , {name: 'token', secret: {secretName: r.token, defaultMode: 292}}
        , {name: 'usbmuxd', hostPath: {path: '/run/usbmuxd', type: 'Socket'}}
        , {name: 'tun', hostPath: {path: '/dev/net/tun', type: 'CharDevice'}}]
      }}
    }}))
    items.push(object('v1', 'Service', r.service,
      {spec: {selector: r.labels, ports: [{name: 'screen', port: 17440, targetPort: 'screen'}]}}))
    items.push({apiVersion: 'v1', kind: 'Service', metadata: {name: r.proxy, namespace: 'stf'}
      , spec: {type: 'ExternalName'
        , externalName: r.service + '.' + namespace + '.svc.cluster.local'}})
    items.push(object('networking.k8s.io/v1', 'NetworkPolicy', r.name + '-screen', {spec: {
      podSelector: {matchLabels: r.labels}, policyTypes: ['Ingress'], ingress: [{from: [{
        namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'stf'}}
      , podSelector: {matchLabels: {'app.kubernetes.io/name': 'stf-dynamic-proxy'}}
      }], ports: [{protocol: 'TCP', port: 17440}]}]
    }}))
  }
  return {apiVersion: 'v1', kind: 'List', items}
}

async function kubectl(kubeconfig: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('kubectl', ['--kubeconfig', kubeconfig, ...args],
      {timeout: 60000, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message))
        }
        else {
          resolve(stdout)
        }
      })
    child.stdin!.end(input)
  })
}

async function main() {
  const {values} = parseArgs({options: {config: {type: 'string'}, kubeconfig: {type: 'string'}
    , apply: {type: 'boolean'}, help: {type: 'boolean'}}})
  if (values.help) {
    process.stdout.write('Usage: node kuber/ios-prototype/fleet.mts --config PRIVATE.json ' +
      '[--apply --kubeconfig /private/k3s.yaml]\n' +
      'Render without --apply; no Secret data is printed.\n')
    return
  }
  if (!values.config) {
    throw new Error('Provide --config with the explicit device list')
  }
  const config = validateFleet(JSON.parse(await fs.readFile(values.config, 'utf8')))
  const manifest = renderFleet(config)
  if (!values.apply) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
    return
  }
  if (!values.kubeconfig) {
    throw new Error('--apply requires an explicit --kubeconfig')
  }
  await fs.access(values.kubeconfig)
  const kubeconfig = values.kubeconfig
  await kubectl(kubeconfig, ['apply', '-f', '-'], JSON.stringify({
    apiVersion: 'v1', kind: 'Namespace'
    , metadata: {name: namespace}}))
  for (const device of config.devices) {
    const r = deviceResources(device)
    const existing = await kubectl(kubeconfig,
      ['-n', namespace, 'get', 'secret', r.token, '--ignore-not-found', '-o', 'name'])
    if (!existing.trim()) {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stf-ios-token-'))
      try {
        const file = path.join(temporary, 'token')
        await fs.writeFile(file, randomBytes(32).toString('hex'), {mode: 0o600})
        await kubectl(kubeconfig, ['-n', namespace, 'create', 'secret', 'generic', r.token
          , '--from-file=token=' + file])
      }
      finally {
        await fs.rm(temporary, {recursive: true, force: true})
      }
    }
  }
  process.stdout.write(await kubectl(kubeconfig, ['apply', '-f', '-'], JSON.stringify(manifest)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
