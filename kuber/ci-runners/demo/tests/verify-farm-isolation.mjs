import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import assert from 'node:assert/strict'

const coordinator = new URL(process.env.FARM_URL)
const targets = [
  ['coordinator', coordinator.hostname, Number(coordinator.port || (coordinator.protocol === 'https:' ? 443 : 80)), true],
  ['GitLab', 'gitlab.finservice.tech', 443, true],
  ['shared ADB', 'adbd.stf.svc.cluster.local', 5037, false],
  ['shared ADB 2', 'adbd-2.stf.svc.cluster.local', 5037, false],
  ['Grid', 'appium-grid-router.appium.svc.cluster.local', 4444, false],
  ['STF API', 'stf-api.stf.svc.cluster.local', 3000, false],
  ['Kubernetes API', 'kubernetes.default.svc.cluster.local', 443, false]
]
function connect(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (connected, error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ connected, error })
    }
    socket.setTimeout(2500, () => done(false, 'timeout'))
    socket.on('connect', () => done(true))
    socket.on('error', error => done(false, error.code))
  })
}
const results = await Promise.all(targets.map(async ([name, host, port, allowed]) => ({
  name, host, port, allowed, ...await connect(host, port)
})))
const kubernetesTokenPresent = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')
await mkdir('artifacts', { recursive: true })
await writeFile('artifacts/network-isolation.json', JSON.stringify({ kubernetesTokenPresent, results }, null, 2))
assert.equal(kubernetesTokenPresent, false, 'CI job must not have Kubernetes credentials')
for (const result of results) {
  assert.equal(result.connected, result.allowed, `${result.name}:${result.port} access must be ${result.allowed ? 'allowed' : 'blocked'}`)
}
console.log('Farm isolation passed: coordinator/GitLab reachable; shared ADB, Grid, STF API and Kubernetes blocked')
