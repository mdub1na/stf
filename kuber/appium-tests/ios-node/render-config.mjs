import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const namespace = process.argv[2]
if (!namespace || !/^[a-z0-9-]+$/.test(namespace)) throw new Error('Usage: node render-config.mjs NAMESPACE')
console.log(JSON.stringify({
  apiVersion: 'v1', kind: 'ConfigMap', metadata: {name: 'ios-appium-config', namespace},
  data: Object.fromEntries(['wda-session-proxy.mjs', 'start-appium.mjs'].map(name =>
    [name, readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')]))
}, null, 2))
