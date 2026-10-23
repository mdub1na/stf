import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'

const image = 'selenium/node-base:4.51.0-20261010@sha256:e582019bb0748d7b551ebd8d0aaeb0197531510683ccdf172a4b45087830dc9d'
export function gridResources(target) {
  const {namespace, deployment, udid, platformVersion, selector} = target
  for (const value of [namespace, deployment]) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) throw new Error('Invalid namespace or deployment')
  }
  if (typeof udid !== 'string' || !/^[A-Za-z0-9-]+$/.test(udid)) throw new Error('An explicit device UDID is required')
  if (typeof platformVersion !== 'string' || !/^\d+(\.\d+){0,2}$/.test(platformVersion)) throw new Error('An explicit iOS platformVersion is required')
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || !Object.keys(selector).length ||
      Object.values(selector).some(value => typeof value !== 'string' || !value)) throw new Error('An explicit pod selector is required')
  const name = 'ios-appium-' + deployment
  const labels = {'app.kubernetes.io/name': name}
  const stereotype = JSON.stringify({platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': udid, 'appium:platformVersion': platformVersion})
  const config = `[server]\nport = 6666\n\n[node]\ndetect-drivers = false\nmax-sessions = 1\n\n[relay]\nurl = "http://${name}.${namespace}.svc.cluster.local:4723"\nstatus-endpoint = "/status"\nconfigs = ["1", ${JSON.stringify(stereotype)}]\n`
  return {apiVersion: 'v1', kind: 'List', items: [
    {apiVersion: 'v1', kind: 'Service', metadata: {name, namespace}, spec: {
      selector, ports: [{name: 'appium', port: 4723, targetPort: 'appium'}]
    }},
    {apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: {name, namespace}, spec: {
      podSelector: {matchLabels: selector}, policyTypes: ['Ingress'], ingress: [{
        from: [{namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'appium'}}, podSelector: {matchLabels: labels}}],
        ports: [{protocol: 'TCP', port: 4723}]
      }]
    }},
    {apiVersion: 'v1', kind: 'ConfigMap', metadata: {name, namespace: 'appium'}, data: {'node-ios.toml': config}},
    {apiVersion: 'apps/v1', kind: 'Deployment', metadata: {name, namespace: 'appium'}, spec: {
      replicas: 1, selector: {matchLabels: labels}, template: {metadata: {labels, annotations: {'stf.appium/config-sha256': createHash('sha256').update(config).digest('hex')}}, spec: {
        automountServiceAccountToken: false,
        containers: [{name: 'relay', image, command: ['java', '-jar', '/opt/selenium/selenium-server.jar', 'node'],
          args: ['--publish-events', 'tcp://appium-grid-event-bus:4442', '--subscribe-events', 'tcp://appium-grid-event-bus:4443', '--config', '/opt/stf-ios-grid/node-ios.toml'],
          ports: [{name: 'relay', containerPort: 6666}],
          readinessProbe: {httpGet: {path: '/status', port: 'relay'}, periodSeconds: 10},
          resources: {requests: {cpu: '25m', memory: '128Mi'}, limits: {cpu: '500m', memory: '512Mi'}},
          volumeMounts: [{name: 'config', mountPath: '/opt/stf-ios-grid', readOnly: true}]
        }], volumes: [{name: 'config', configMap: {name}}]
      }}
    }}
  ]}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node render-grid.mjs PRIVATE_TARGET_JSON')
  console.log(JSON.stringify(gridResources(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2))
}
