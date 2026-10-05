import http from 'node:http'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import type {AddressInfo} from 'node:net'

import * as chai from 'chai'
import sinon from 'sinon'
var expect = chai.expect

import type AuthOAuth2 from '../../../lib/units/auth/oauth2/index.js'
import jwtutil from '../../../lib/util/jwtutil.js'
import {importFresh, mockModule} from '../../helpers/module-mock.mts'

var existing: {name: string} | null = null
var databaseFailure = false
var accountLookups = 0
var restoreDatabase = mockModule(new URL('../../../lib/db/api.js', import.meta.url), {default: {
  getRootGroup: function() {
    return Promise.resolve({owner: {email: 'admin@example.com'}})
  }
, loadUser: function() {
    accountLookups++
    return databaseFailure ? Promise.reject(new Error('private database detail')) :
      Promise.resolve(existing)
  }
}})
var authOAuth2: typeof AuthOAuth2 =
  (await importFresh(new URL('../../../lib/units/auth/oauth2/index.js', import.meta.url))).default
restoreDatabase()

type AuthOptions = Parameters<typeof authOAuth2>[0]

function address(server: http.Server) {
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map(function(cookie) {
    return cookie.split(';', 1)[0]
  }).join('; ')
}

describe('auth-oauth2 HTTP flow', function() {
  var provider: http.Server, auth: http.Server, options: AuthOptions
   , profile: Record<string, unknown>, challenge: string, tokenRequests: number
   , verifierMatched: boolean, providerFailure: boolean, invalidUserinfo: boolean
   , consumed: boolean

  beforeEach(async function() {
    profile = {email: 'alice@example.com', email_verified: true, name: 'Alice Example'}
    existing = null
    databaseFailure = false
    accountLookups = 0
    tokenRequests = 0
    verifierMatched = false
    providerFailure = false
    invalidUserinfo = false
    consumed = false
    provider = http.createServer(async function(req, res) {
      if (req.url === '/oauth/token') {
        tokenRequests++
        var body = ''
        for await (var chunk of req) {
          body += chunk
        }
        var params = new URLSearchParams(body)
        verifierMatched = createHash('sha256').update(params.get('code_verifier') || '')
          .digest('base64url') === challenge
        if (providerFailure || consumed || !verifierMatched ||
            params.get('code') !== 'test-code' ||
            params.get('client_id') !== 'test-client' ||
            params.get('client_secret') !== 'test-client-secret') {
          res.writeHead(400, {'Content-Type': 'application/json'})
          res.end(JSON.stringify({
            error: 'invalid_grant', error_description: 'private token detail'
          }))
          return
        }
        consumed = true
        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({access_token: 'test-token', token_type: 'Bearer'}))
        return
      }
      if (req.url === '/oauth/userinfo' && req.headers.authorization === 'Bearer test-token') {
        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(invalidUserinfo ? 'not-json' : JSON.stringify(profile))
        return
      }
      res.writeHead(404)
      res.end()
    }).listen(0, '127.0.0.1')
    await once(provider, 'listening')

    options = {
      port: 0
    , secret: 'test-session-secret'
    , ssid: 'test-ssid'
    , appUrl: 'http://stf.example.com/'
    , requireVerifiedEmail: true
    , oauth: {
        authorizationURL: address(provider) + '/oauth/authorize'
      , tokenURL: address(provider) + '/oauth/token'
      , userinfoURL: address(provider) + '/oauth/userinfo'
      , clientID: 'test-client'
      , clientSecret: 'test-client-secret'
      , callbackURL: 'http://stf.example.com/auth/oauth/callback'
      , scope: ['openid', 'profile', 'email']
      , state: true
      , pkce: true
      }
    }
    auth = authOAuth2(options)
    await once(auth, 'listening')
  })

  afterEach(async function() {
    sinon.restore()
    await new Promise<void>(function(resolve) {
      auth.close(function() {
        resolve()
      })
    })
    await new Promise<void>(function(resolve) {
      provider.close(function() {
        resolve()
      })
    })
  })

  async function start(headers: Record<string, string> = {}) {
    var response = await fetch(address(auth) + '/auth/oauth/start', {
      redirect: 'manual', headers: headers
    })
    var location = new URL(response.headers.get('location')!)
    challenge = location.searchParams.get('code_challenge')!
    return {response: response, location: location, cookie: cookies(response)}
  }

  async function completeLogin(cookie: string, state: string, code = 'test-code') {
    return fetch(address(auth) + '/auth/oauth/callback?' + new URLSearchParams({
      code: code, state: state
    }), {redirect: 'manual', headers: {cookie: cookie}})
  }

  it('should show the STF login page without starting provider authentication', async function() {
    var response = await fetch(address(auth) + '/auth/oauth/', {redirect: 'manual'})
    expect(response.status).to.equal(200)
    expect(response.headers.get('content-type')).to.match(/^text\/html/)
    expect(response.headers.get('location')).to.equal(null)
    expect(response.headers.getSetCookie()).to.deep.equal([])
    expect(response.headers.get('cache-control')).to.equal('no-store')
    expect(await response.text()).to.include('authoauth.entry.js')
    expect(tokenRequests).to.equal(0)
  })

  it('should keep the landing page available with an OAuth state cookie', async function() {
    var login = await start()
    var response = await fetch(address(auth) + '/auth/oauth/', {
      redirect: 'manual', headers: {cookie: login.cookie}
    })
    expect(response.status).to.equal(200)
    expect(response.headers.get('location')).to.equal(null)
    expect(response.headers.getSetCookie()).to.deep.equal([])
    expect((await completeLogin(login.cookie, login.location.searchParams.get('state')!)).status)
      .to.equal(302)
  })

  it('should initiate state and S256 PKCE without exposing the client secret', async function() {
    var login = await start()
    expect(login.response.status).to.equal(302)
    expect(login.location.searchParams.get('state')).to.have.length.greaterThan(16)
    expect(login.location.searchParams.get('code_challenge_method')).to.equal('S256')
    expect(challenge).to.have.length(43)
    expect(login.location.searchParams.get('scope')).to.equal('openid profile email')
    expect(login.location.href).not.to.include('test-client-secret')
    expect(login.cookie).to.include('test-ssid.oauth=')
    expect(login.cookie).not.to.include('test-ssid=')
    expect(login.response.headers.get('cache-control')).to.equal('no-store')
    expect(login.response.headers.getSetCookie()[0]!.toLowerCase()).to.include('httponly')
    expect(login.response.headers.getSetCookie()[0]!.toLowerCase()).to.include('samesite=lax')
    expect(login.response.headers.getSetCookie()[0]).to.include('path=/auth/oauth')
  })

  it('should complete a verified login and exchange the matching PKCE verifier', async function() {
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    expect(response.status).to.equal(302)
    var redirect = new URL(response.headers.get('location')!)
    expect(redirect.origin).to.equal('http://stf.example.com')
    expect(jwtutil.decode(redirect.searchParams.get('jwt')!, options.secret)).to.deep.equal({
      email: 'alice@example.com', name: 'Alice Example'
    })
    expect(verifierMatched).to.equal(true)
    expect(accountLookups).to.equal(1)
    expect(response.headers.getSetCookie()[0]).to.include('expires=Thu, 01 Jan 1970')
  })

  it('should preserve the existing STF name for the same email', async function() {
    existing = {name: 'Existing LDAP Name'}
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    var redirect = new URL(response.headers.get('location')!)
    expect(jwtutil.decode(redirect.searchParams.get('jwt')!, options.secret)?.name)
      .to.equal('Existing LDAP Name')
  })

  it('should reject an unverified email without issuing a login token', async function() {
    profile.email_verified = false
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    expect(response.status).to.equal(403)
    expect(response.headers.get('location')).to.equal(null)
    expect(accountLookups).to.equal(0)
  })

  it('should reject missing email claims', async function() {
    delete profile.email
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    expect(response.status).to.equal(403)
    expect(accountLookups).to.equal(0)
  })

  it('should reject an invalid state before accessing the token endpoint', async function() {
    var login = await start()
    expect((await completeLogin(login.cookie, 'wrong-state')).status).to.equal(403)
    expect(tokenRequests).to.equal(0)
  })

  it('should reject a callback without the state cookie', async function() {
    expect((await completeLogin('', 'unsolicited-state')).status).to.equal(400)
    expect(tokenRequests).to.equal(0)
  })

  it('should reject a callback without a state value', async function() {
    var login = await start()
    expect((await completeLogin(login.cookie, '')).status).to.equal(400)
    expect(tokenRequests).to.equal(0)
  })

  it('should reject a tampered state cookie', async function() {
    var login = await start()
    var cookie = login.cookie.replace('test-ssid.oauth.sig=', 'test-ssid.oauth.sig=invalid')
    expect((await completeLogin(cookie, login.location.searchParams.get('state')!)).status)
      .to.equal(400)
    expect(tokenRequests).to.equal(0)
  })

  it('should enforce the state lifetime on the server', async function() {
    var clock = sinon.useFakeTimers({toFake: ['Date']})
    var login = await start()
    clock.tick(10 * 60 * 1000 + 1)
    expect((await completeLogin(login.cookie, login.location.searchParams.get('state')!)).status)
      .to.equal(400)
    expect(tokenRequests).to.equal(0)
  })

  it('should not accept a replayed authorization code', async function() {
    var login = await start()
    var state = login.location.searchParams.get('state')!
    expect((await completeLogin(login.cookie, state)).status).to.equal(302)
    expect((await completeLogin(login.cookie, state)).status).to.equal(502)
    expect(accountLookups).to.equal(1)
  })

  it('should handle provider rejection without reflecting its error description', async function() {
    var response = await fetch(address(auth) +
      '/auth/oauth/callback?error=access_denied&error_description=private-detail')
    expect(response.status).to.equal(403)
    expect(await response.text()).not.to.include('private-detail')
  })

  it('should handle a token endpoint failure without exposing details', async function() {
    providerFailure = true
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    expect(response.status).to.equal(502)
    expect(await response.text()).not.to.include('private token detail')
    expect(accountLookups).to.equal(0)
  })

  it('should handle malformed userinfo without issuing a login token', async function() {
    invalidUserinfo = true
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    expect(response.status).to.equal(502)
    expect(response.headers.get('location')).to.equal(null)
  })

  it('should fail closed when the STF account lookup fails', async function() {
    databaseFailure = true
    var login = await start()
    var response = await completeLogin(login.cookie, login.location.searchParams.get('state')!)
    expect(response.status).to.equal(500)
    expect(await response.text()).not.to.include('private database detail')
    expect(response.headers.get('location')).to.equal(null)
  })

  it('should leave contact and unknown routes outside the OAuth redirect flow', async function() {
    var response = await fetch(address(auth) + '/auth/contact', {redirect: 'manual'})
    expect(response.status).to.equal(200)
    var body = await response.json() as {contact: {email: string}}
    expect(body.contact.email).to.equal('admin@example.com')
    expect((await fetch(address(auth) + '/unknown', {redirect: 'manual'})).status).to.equal(404)
    expect(tokenRequests).to.equal(0)
  })

  it('should require state protection at startup', function() {
    expect(function() {
      authOAuth2(Object.assign({}, options, {
        oauth: Object.assign({}, options.oauth, {state: false})
      }))
    }).to.throw('OAuth authentication requires state: true')
  })

  it('should set Secure state cookies behind the HTTPS ingress', async function() {
    await new Promise<void>(function(resolve) {
      auth.close(function() {
        resolve()
      })
    })
    auth = authOAuth2(Object.assign({}, options, {oauth: Object.assign({}, options.oauth, {
      callbackURL: 'https://stf.example.com/auth/oauth/callback'
    })}))
    await once(auth, 'listening')
    var login = await start({'X-Forwarded-Proto': 'https'})
    expect(login.response.headers.getSetCookie()[0]).to.include('secure')
  })
})
