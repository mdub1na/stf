import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const overlay = fileURLToPath(new URL('../../gitops/appium/', import.meta.url))
const documents = execFileSync('kubectl', ['kustomize', overlay], {
  encoding: 'utf8', timeout: 30000
}).split(/^---\s*$/m)
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const resource = (kind, name) => {
  const found = documents.filter(document =>
    new RegExp('^kind: ' + kind + '$', 'm').test(document) &&
    new RegExp('^  name: ' + name + '$', 'm').test(
      document.match(/^metadata:\n(?:  .*\n)*/m)?.[0] || ''))
  assert.equal(found.length, 1, kind + '/' + name)
  return found[0]
}

test('keeps both Grid ingress identities, routes and TLS certificates', () => {
  for (const [name, host, secret] of [
    ['appium-grid', 'appium-grid.putmyhexon.ru', 'appium-grid-putmyhexon-ru-tls'],
    ['appium-grid-finservice', 'appium-grid.finservice.tech', 'appium-grid-finservice-tech-tls']
  ]) {
    const ingress = resource('Ingress', name)
    assert.match(ingress, new RegExp('^  - host: ' + escape(host) + '$', 'm'))
    assert.match(ingress, new RegExp('^  tls:\\n  - hosts:\\n    - ' + escape(host) + '\\n    secretName: ' + escape(secret) + '$', 'm'))
    assert.match(ingress, /service:\n +name: appium-grid-router\n +port:\n +number: 4444\n +path: \/\n +pathType: Prefix/m)
  }
})

for (const [name, replicas, pool] of [
  ['android-appium-node-1', 4, 'adbd.stf.svc.cluster.local'],
  ['android-appium-node-2', 3, 'adbd-2.stf.svc.cluster.local']
]) {
  test(name + ' keeps its adopted size, log level and ADB pool', () => {
    const deployment = resource('Deployment', name)
    assert.match(deployment, new RegExp('^  replicas: ' + replicas + '$', 'm'))
    assert.match(deployment, /^        - --log-level\n        - warn$/m)
    assert.match(deployment, new RegExp('^        - name: ANDROID_ADB_SERVER_HOST\\n          value: ' + escape(pool) + '$', 'm'))
  })
}
