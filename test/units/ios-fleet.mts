import assert from 'node:assert/strict'
import {renderFleet, validateFleet, deviceResources} from '../../kuber/ios-prototype/fleet.mts'

const config = {
  prototypeImage: 'ghcr.io/mdub1na/stf@sha256:' + 'a'.repeat(64)
  , stfImage: 'ghcr.io/mdub1na/stf@sha256:' + 'b'.repeat(64)
  , publicOrigin: 'https://stf.example.test'
  , devices: [
    {udid: 'phone-00000001', node: 'usb-node', wdaBundleId: 'test.wda.xctrunner', legacy: true}
    , {udid: 'phone-00000002', node: 'usb-node', wdaBundleId: 'test.wda.xctrunner'}
    , {udid: 'phone-00000003', node: 'usb-node', wdaBundleId: 'test.wda.xctrunner'}
  ]
}

describe('iPhone fleet deployment', () => {
  it('isolates three phones while preserving existing primary resources', () => {
    const rendered = renderFleet(config)
    const deployments = rendered.items.filter(item => item.kind === 'Deployment')
    assert.equal(deployments.length, 3)
    const names = new Set<string>()
    const pvc = new Set<string>()
    const secrets = new Set<string>()
    for (const [index, deployment] of deployments.entries()) {
      names.add(deployment.metadata.name)
      const spec = deployment.spec.template.spec
      assert.equal(spec.automountServiceAccountToken, false)
      assert.equal(spec.nodeSelector['kubernetes.io/hostname'], 'usb-node')
      pvc.add(spec.volumes.find((volume: any) =>
        volume.name === 'state').persistentVolumeClaim.claimName)
      secrets.add(spec.volumes.find((volume: any) => volume.name === 'token').secret.secretName)
      const setting = rendered.items.find(item => item.kind === 'ConfigMap' &&
        item.metadata.name === deviceResources(config.devices[index]!).config)
      assert.equal(setting.data.udid, config.devices[index]!.udid)
      const tunnel = spec.containers.find((container: any) => container.name === 'tunnel')
      assert.ok(tunnel.args.includes('--udid=$(IOS_UDID)'))
      for (const container of spec.containers.filter((c: any) => c.name !== 'tunnel')) {
        assert.equal(container.securityContext.allowPrivilegeEscalation, false)
        assert.equal(container.securityContext.runAsUser, 1000)
      }
      assert.equal(spec.volumes.some((volume: any) => volume.hostPath?.path === '/run'), false)
    }
    assert.equal(names.size, 3)
    assert.equal(pvc.size, 3)
    assert.equal(secrets.size, 3)
    assert.ok(names.has('ios-prototype'))
    assert.ok(pvc.has('ios-state'))
  })

  it('routes each screen only to its phone and exposes no private API service', () => {
    const {items} = renderFleet(config)
    const services = items.filter(item =>
      item.kind === 'Service' && item.metadata.namespace !== 'stf')
    assert.equal(services.length, 3)
    for (const [index, service] of services.entries()) {
      const deployment = items.find(item => item.kind === 'Deployment' &&
        item.metadata.name === deviceResources(config.devices[index]!).name)
      assert.deepEqual(service.spec.selector, deployment.spec.template.metadata.labels)
      assert.deepEqual(service.spec.ports.map((port: any) => port.port), [17440])
      assert.equal(items.filter(item => item.kind === 'Deployment' &&
        Object.entries(service.spec.selector).every(([key, value]) =>
          item.spec.template.metadata.labels[key] === value)).length, 1)
    }
    const policies = items.filter(item => item.kind === 'NetworkPolicy')
    assert.equal(policies.length, 3)
    assert.ok(policies.every(p => p.spec.ingress[0].ports[0].port === 17440))
    assert.equal(items.some(item => item.kind === 'Secret'), false)
  })

  it('rejects device collisions, untrusted origins and shell-shaped input', () => {
    for (const bad of [
      {...config, devices: [config.devices[0], config.devices[0]]}
      , {...config, devices: config.devices.map(d => ({...d, legacy: true}))}
      , {...config, publicOrigin: 'https://user:password@stf.example.test'}
      , {...config, publicOrigin: 'http://stf.example.test'}
      , {...config, devices: [{...config.devices[0], udid: 'phone;touch /tmp/not-allowed'}]}
      , {...config, devices: [{...config.devices[0], node: 'node $(anything)'}]}
    ]) {
      assert.throws(() => validateFleet(bad))
    }
  })
})
