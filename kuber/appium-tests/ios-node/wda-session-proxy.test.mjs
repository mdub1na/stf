import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {createWdaSessionProxy} from './wda-session-proxy.mjs'

async function fixture(t) {
  const calls = []
  let active = 'stf-session'
  const wda = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    calls.push({method: request.method, path: request.url, body})
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/status') return response.end(JSON.stringify({sessionId: active, value: {ready: true}}))
    if (request.url.includes('/session/') && !request.url.includes('/session/' + active)) {
      response.writeHead(404)
      return response.end(JSON.stringify({value: {error: 'invalid session id'}}))
    }
    if (request.url.endsWith('/appium/settings')) return response.end(JSON.stringify({value: {mjpegServerFramerate: 10}}))
    if (request.url.endsWith('/source')) return response.end(JSON.stringify({value: '<Application/>'}))
    response.end(JSON.stringify({value: {capabilities: {platformName: 'iOS'}}}))
  })
  await new Promise(resolve => wda.listen(0, '127.0.0.1', resolve))
  const proxy = createWdaSessionProxy({origin: 'http://127.0.0.1:' + wda.address().port, timeout: 1000})
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => {proxy.closeAllConnections(); proxy.close(); wda.closeAllConnections(); wda.close()})
  const call = async (method, path, body) => {
    const response = await fetch('http://127.0.0.1:' + proxy.address().port + path, {
      method, ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})
    })
    return {status: response.status, body: await response.json()}
  }
  return {calls, call, rotate: () => {active = 'replacement-session'}, clear: () => {active = null}}
}

test('attaches to the current STF session without creating a WDA session', async t => {
  const f = await fixture(t)
  const response = await f.call('POST', '/session', {capabilities: {alwaysMatch: {}}})
  assert.equal(response.status, 200)
  assert.equal(response.body.value.sessionId, 'stf-session')
  assert.equal(f.calls.some(c => c.method === 'POST'), false)
  assert.equal((await f.call('GET', '/session/stf-session/source')).body.value, '<Application/>')
})

test('Appium quit restores settings and never deletes the STF session', async t => {
  const f = await fixture(t)
  await f.call('POST', '/session', {})
  assert.equal((await f.call('DELETE', '/session/stf-session')).status, 200)
  assert.equal(f.calls.some(c => c.method === 'DELETE'), false)
  assert.deepEqual(f.calls.at(-1).body, {settings: {mjpegServerFramerate: 10}})
  assert.equal((await f.call('POST', '/session', {})).status, 200)
})

test('refuses a second Appium session until the first is closed', async t => {
  const f = await fixture(t)
  await f.call('POST', '/session', {})
  assert.equal((await f.call('POST', '/session', {})).status, 409)
})

test('does not forward commands or deletion for unborrowed sessions', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('GET', '/session/stf-session/source')).status, 404)
  assert.equal((await f.call('DELETE', '/session/stf-session')).status, 404)
  assert.equal(f.calls.length, 0)
})

test('does not silently retarget a session after WDA recovery', async t => {
  const f = await fixture(t)
  await f.call('POST', '/session', {})
  f.rotate()
  assert.equal((await f.call('GET', '/session/stf-session/source')).status, 404)
  assert.equal(f.calls.at(-1).path, '/session/stf-session/source')
})

test('rejects attachment when STF has no live WDA session', async t => {
  const f = await fixture(t)
  f.clear()
  assert.equal((await f.call('POST', '/session', {})).status, 503)
})

test('blocks requests to shut down WDA', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('POST', '/wda/shutdown', {})).status, 403)
  assert.equal(f.calls.length, 0)
})
