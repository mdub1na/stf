import fs from 'node:fs'
import http from 'node:http'
import {once} from 'node:events'
import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import sinon from 'sinon'

import type App from '../../../lib/units/app/index.js'
import jwtutil from '../../../lib/util/jwtutil.js'
import pathutil from '../../../lib/util/pathutil.js'
import {importFresh, mockModule} from '../../helpers/module-mock.mts'

describe('STF logout HTTP flow', function() {
  var createApp: typeof App, server: http.Server, origin: string
    , jar: Map<string, string>
  var ssid = 'logout-test'
  var secret = 'logout-test-secret'
  var identity = {email: 'alice@example.com', name: 'Alice'}

  before(async function() {
    var restoreDb = mockModule(new URL('../../../lib/db/api.js', import.meta.url), {default: {
      saveUserAfterLogin: function() {
        return Promise.resolve()
      }
    , loadUser: function(email: string) {
        return Promise.resolve(email === identity.email ? identity : null)
      }
    }})
    var restoreAuth = function() {}
    try {
      var authUrl = new URL('../../../lib/units/app/middleware/auth.js', import.meta.url)
      var auth = await importFresh(authUrl)
      restoreAuth = mockModule(authUrl, {
        default: auth.default
      })
      var appUrl = new URL('../../../lib/units/app/index.js', import.meta.url)
      createApp = (await importFresh(appUrl)).default
    }
    finally {
      restoreAuth()
      restoreDb()
    }
  })

  beforeEach(async function() {
    var hasBuild = sinon.stub(fs, 'existsSync').callThrough()
    hasBuild.withArgs(pathutil.resource('build')).returns(true)
    try {
      server = createApp({
        port: 0
      , ssid: ssid
      , secret: secret
      , authUrl: '/auth/oauth/'
      , websocketUrl: 'http://stf.example.com/socket.io/'
      })
    }
    finally {
      hasBuild.restore()
    }
    await once(server, 'listening')
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    jar = new Map()
  })

  afterEach(function(done) {
    server.close(done)
  })

  function storeCookies(response: Response) {
    for (var cookie of response.headers.getSetCookie()) {
      var pair = cookie.split(';', 1)[0]!
      var split = pair.indexOf('=')
      var name = pair.slice(0, split)
      if (/expires=Thu, 01 Jan 1970/i.test(cookie)) {
        jar.delete(name)
      }
      else {
        jar.set(name, pair.slice(split + 1))
      }
    }
  }

  async function request(path: string, method = 'GET', headers: Record<string, string> = {}) {
    var response = await fetch(origin + path, {
      redirect: 'manual'
    , method: method
    , headers: {
        cookie: Array.from(jar, function([name, value]) {
          return name + '=' + value
        }).join('; ')
      , ...headers
      }
    })
    storeCookies(response)
    return response
  }

  async function login(headers: Record<string, string> = {}) {
    var jwt = jwtutil.encode({
      payload: identity, secret: secret
    , header: {exp: Date.now() + 60 * 1000}
    })
    expect((await request('/?jwt=' + encodeURIComponent(jwt), 'GET', headers)).status).to.equal(302)
    expect((await request('/app/api/v1/state.js', 'GET', headers)).status).to.equal(200)
  }

  function csrfHeaders() {
    return {'X-XSRF-TOKEN': decodeURIComponent(jar.get('XSRF-TOKEN')!)}
  }

  it('should clear signed STF and pending OAuth cookies', async function() {
    await login()
    var response = await request('/app/logout', 'POST', csrfHeaders())
    expect(response.status).to.equal(200)
    expect(await response.json()).to.deep.equal({success: true, redirect: '/auth/oauth/'})
    expect(response.headers.get('cache-control')).to.equal('no-store')
    for (const name of [ssid, ssid + '.sig', 'XSRF-TOKEN', ssid + '.oauth', ssid + '.oauth.sig']) {
      var cleared = response.headers.getSetCookie().find(function(cookie) {
        return cookie.startsWith(name + '=')
      })
      expect(cleared!.toLowerCase(), name).to.include('expires=thu, 01 jan 1970')
      expect(cleared!.toLowerCase()).to.include('path=' +
        (name.includes('.oauth') ? '/auth/oauth' : '/'))
    }
    expect(jar.has(ssid)).to.equal(false)
    expect(jar.has(ssid + '.sig')).to.equal(false)
  })

  it('should require a new STF login after logout', async function() {
    await login()
    await request('/app/logout', 'POST', csrfHeaders())
    var response = await request('/')
    expect(response.status).to.equal(302)
    expect(response.headers.get('location')).to.equal('/auth/oauth/')
    var state = await request('/app/api/v1/state.js')
    expect(state.status).to.equal(302)
    expect(await state.text()).not.to.include('alice@example.com')
  })

  it('should reject logout without a CSRF token and preserve the session', async function() {
    await login()
    expect((await request('/app/logout', 'POST')).status).to.equal(403)
    expect((await request('/app/api/v1/state.js')).status).to.equal(200)
    expect(jar.has(ssid)).to.equal(true)
  })

  it('should reject logout with an invalid CSRF token', async function() {
    await login()
    expect((await request('/app/logout', 'POST', {'X-XSRF-TOKEN': 'invalid'})).status).to.equal(403)
    expect((await request('/app/api/v1/state.js')).status).to.equal(200)
  })

  it('should not allow a GET request to log the user out', async function() {
    await login()
    expect((await request('/app/logout')).status).to.equal(404)
    expect((await request('/app/api/v1/state.js')).status).to.equal(200)
  })

  it('should retain unrelated cookies instead of deleting every readable cookie', async function() {
    await login()
    jar.set('other-preference', 'keep')
    var response = await request('/app/logout', 'POST', csrfHeaders())
    expect(response.status).to.equal(200)
    expect(jar.get('other-preference')).to.equal('keep')
    expect(response.headers.getSetCookie().some(function(cookie) {
      return cookie.startsWith('other-preference=')
    })).to.equal(false)
  })

  it('should clear Secure STF cookies behind the HTTPS ingress', async function() {
    var proxy = {'X-Forwarded-Proto': 'https'}
    await login(proxy)
    var response = await request('/app/logout', 'POST', {...csrfHeaders(), ...proxy})
    expect(response.status).to.equal(200)
    expect(response.headers.getSetCookie().find(function(cookie) {
      return cookie.startsWith(ssid + '=')
    })).to.include('secure')
    expect((await request('/app/api/v1/state.js', 'GET', proxy)).status).to.equal(302)
  })
})
