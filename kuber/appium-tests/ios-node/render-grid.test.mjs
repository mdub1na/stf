import {test} from 'node:test'
import assert from 'node:assert/strict'
import {gridResources} from './render-grid.mjs'
const target = {namespace: 'ios-runtime', deployment: 'phone-a', udid: 'test-device-id', platformVersion: '27.0.1', selector: {app: 'phone-a'}}
test('registers one UDID and preserves the explicit phone selector', () => {
  const {items} = gridResources(target)
  assert.deepEqual(items.find(x => x.kind === 'Service').spec.selector, target.selector)
  const config = items.find(x => x.kind === 'ConfigMap').data['node-ios.toml']
  assert.ok(config.includes('max-sessions = 1'))
  assert.ok(config.includes('test-device-id'))
  assert.ok(config.includes('27.0.1'))
  assert.ok(config.includes('ios-appium-phone-a.ios-runtime.svc.cluster.local:4723'))
})
test('only the selected relay can reach the Appium port', () => {
  const policy = gridResources(target).items.find(x => x.kind === 'NetworkPolicy').spec
  assert.deepEqual(policy.podSelector.matchLabels, target.selector)
  assert.equal(policy.ingress.length, 1)
  assert.deepEqual(policy.ingress[0].ports, [{protocol: 'TCP', port: 4723}])
  const from = policy.ingress[0].from[0]
  assert.equal(from.namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'appium')
  assert.equal(from.podSelector.matchLabels['app.kubernetes.io/name'], 'ios-appium-phone-a')
})
test('rejects missing identity or a selector that would expose other phones', () => {
  assert.throws(() => gridResources({...target, udid: ''}))
  assert.throws(() => gridResources({...target, selector: {}}))
  assert.throws(() => gridResources({...target, namespace: 'bad/namespace'}))
})
