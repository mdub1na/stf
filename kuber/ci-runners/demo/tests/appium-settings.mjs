import { readFile, writeFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const artifactDir = 'artifacts'
await mkdir(artifactDir, { recursive: true })
const connection = JSON.parse(await readFile(process.env.STF_CONNECTION_FILE, 'utf8'))
assert.equal(connection.runner, 'appium')
const baseUrl = connection.appium.url.replace(/\/$/, '')
const capabilities = { ...connection.appium.capabilities }
const platform = String(capabilities.platformName || connection.device.platform || '').toLowerCase()
const ios = platform === 'ios'
Object.assign(capabilities, ios
  ? { 'appium:bundleId': 'com.apple.Preferences', 'appium:noReset': true }
  : { 'appium:appPackage': 'com.android.settings', 'appium:appActivity': '.Settings', 'appium:noReset': true })

let sessionId
let failure
const started = Date.now()
const xmlEscape = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])
async function command(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  })
  const result = await response.json()
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${result.value?.message || response.status}`)
  return result.value
}
async function screenshot(name) {
  const encoded = await command('GET', `/session/${sessionId}/screenshot`)
  await writeFile(`${artifactDir}/${name}.png`, Buffer.from(encoded, 'base64'))
}
try {
  const session = await command('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } })
  sessionId = session.sessionId
  assert.ok(sessionId, 'W3C sessionId returned')
  await command('POST', `/session/${sessionId}/appium/device/activate_app`, {
    appId: ios ? 'com.apple.Preferences' : 'com.android.settings'
  })
  const source = await command('GET', `/session/${sessionId}/source`)
  assert.match(source, /Настройки|Settings/, 'Settings application is visible')
  await screenshot('appium-before')
  for (let index = 0; index < 3; index++) {
    await command('POST', `/session/${sessionId}/execute/sync`, {
      script: ios ? 'mobile: swipe' : 'mobile: swipeGesture',
      args: [ios ? { direction: 'up' } : { left: 100, top: 350, width: 500, height: 900, direction: 'up', percent: 0.6 }]
    })
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await screenshot('appium-after-scroll')
  const holdSeconds = Math.max(0, Math.min(60, Number(process.env.DEMO_HOLD_SECONDS || 0)))
  await new Promise(resolve => setTimeout(resolve, holdSeconds * 1000))
  console.log(`Settings smoke passed on ${connection.device.serial}; ${ios ? 'iOS' : 'Android'}`)
} catch (error) {
  failure = error
  if (sessionId) await screenshot('appium-failure').catch(() => {})
} finally {
  if (sessionId) {
    try { await command('DELETE', `/session/${sessionId}`) }
    catch (error) { failure ||= error }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(3)
  await writeFile(`${artifactDir}/junit.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="farm-appium-settings" tests="1" failures="${failure ? 1 : 0}" time="${seconds}"><testcase classname="farm.SettingsSmoke" name="${ios ? 'iOS' : 'Android'} Settings" time="${seconds}">${failure ? `<failure message="${xmlEscape(failure.message)}">${xmlEscape(failure.stack)}</failure>` : ''}</testcase></testsuite>\n`)
}
if (failure) throw failure
