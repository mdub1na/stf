import * as chai from 'chai'
var expect = chai.expect

import getIdentity from '../../../lib/units/auth/oauth2/profile.js'

describe('auth-oauth2 profile', function() {
  var profile: Record<string, unknown>

  beforeEach(function() {
    profile = {email: 'alice@example.com', email_verified: true, name: 'Alice Example'}
  })

  it('should accept a verified email and the provider display name', function() {
    expect(getIdentity(profile, {})).to.deep.equal({
      email: 'alice@example.com', name: 'Alice Example'
    })
  })

  it('should allow verified users regardless of their email domain by default', function() {
    profile.email = 'alice@another.example'
    expect(getIdentity(profile, {})?.email).to.equal('alice@another.example')
  })

  ;[false, 'true', 1, null].forEach(function(verified) {
    it('should reject a non-boolean or false verified claim: ' + String(verified), function() {
      expect(getIdentity(Object.assign({}, profile, {email_verified: verified}), {})).to.equal(null)
    })
  })

  it('should reject a missing verified claim by default', function() {
    delete profile.email_verified
    expect(getIdentity(profile, {})).to.equal(null)
  })

  it('should allow a provider without the claim only when explicitly configured', function() {
    delete profile.email_verified
    expect(getIdentity(profile, {requireVerifiedEmail: false})?.email).to.equal(profile.email)
  })

  ;['', 'alice', '@example.com', 'alice@', 'alice@@example.com'
    , 'alice@exa mple.com', 7, null].forEach(function(email) {
    it('should reject an invalid email: ' + String(email), function() {
      expect(getIdentity(Object.assign({}, profile, {email: email}), {})).to.equal(null)
    })
  })

  it('should fall back to the email prefix for an absent display name', function() {
    delete profile.name
    expect(getIdentity(profile, {})?.name).to.equal('alice')
  })

  it('should match the optional domain exactly, ignoring domain case', function() {
    expect(getIdentity(profile, {domain: '@EXAMPLE.COM'})?.email).to.equal(profile.email)
    expect(getIdentity(profile, {domain: 'ample.com'})).to.equal(null)
    profile.email = 'alice@notexample.com'
    expect(getIdentity(profile, {domain: 'example.com'})).to.equal(null)
  })

  it('should reject malformed userinfo documents', function() {
    for (var value of [null, [], 'email', 1, {}]) {
      expect(getIdentity(value, {})).to.equal(null)
    }
  })
})
