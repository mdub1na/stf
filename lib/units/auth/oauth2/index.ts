/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

import http from 'http'

import express from 'express'
import cookieSession from 'cookie-session'
import passport from 'passport'

import logger from '../../../util/logger.js'
import urlutil from '../../../util/urlutil.js'
import jwtutil from '../../../util/jwtutil.js'
import pathutil from '../../../util/pathutil.js'
import Strategy from './strategy.js'
import getIdentity from './profile.js'

import dbapi from '../../../db/api.js'
import type {VerifyCallback} from 'passport-oauth2'

interface OAuth2AuthOptions {
  port: number
  secret: string
  ssid: string
  appUrl: string
  domain?: string
  requireVerifiedEmail?: boolean
  oauth: ConstructorParameters<typeof Strategy>[0]
}

export default function(options: OAuth2AuthOptions) {
  if (options.oauth.state !== true) {
    throw new Error('OAuth authentication requires state: true')
  }
  var log = logger.createLogger('auth-oauth2')
  var app = express()
  var server = http.createServer(app)
  var authentication = new passport.Passport()
  var stateMaxAge = 10 * 60 * 1000

  app.set('strict routing', true)
  app.set('case sensitive routing', true)
  app.set('trust proxy', 1)
  app.set('view engine', 'pug')
  app.set('views', pathutil.resource('auth/oauth2/views'))
  app.disable('x-powered-by')

  // Keep the short-lived OAuth state separate from the STF login cookie.
  app.use('/auth/oauth', cookieSession({
    name: options.ssid + '.oauth'
  , keys: [options.secret]
  , path: '/auth/oauth'
  , maxAge: stateMaxAge
  , httpOnly: true
  , sameSite: 'lax'
  , secure: new URL(options.oauth.callbackURL!).protocol === 'https:'
  }))
  app.use('/auth/oauth', function(req, res, next) {
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    next()
  })

  app.get('/auth/contact', function(req, res) {
    dbapi.getRootGroup().then(function(group) {
      res.status(200)
        .json({
          success: true
        , contact: group.owner
        })
    })
    .catch(function(err) {
      log.error('Unexpected error', err.stack)
      res.status(500)
        .json({
          success: false
        , error: 'ServerError'
        })
      })
  })

  function verify(
    accessToken: string
  , refreshToken: string
  , profile: Express.User
  , done: VerifyCallback
  ) {
    done(null, getIdentity(profile, options) ? profile : false)
  }

  authentication.use(new Strategy(options.oauth, verify))
  app.use(authentication.initialize())

  app.get('/', function(req, res) {
    res.redirect('/auth/oauth/')
  })
  app.get('/auth/oauth/', function(req, res) {
    res.render('index')
  })
  app.get('/auth/oauth/start', function(req, res, next) {
    req.session!.oauthStartedAt = Date.now()
    next()
  }, authentication.authenticate('oauth2', {session: false}))

  app.get(
    '/auth/oauth/callback'
  , function(req, res, next) {
      if (req.query.error) {
        req.session = null
        res.sendStatus(403)
        return
      }
      var startedAt = req.session?.oauthStartedAt
      if (typeof req.query.code !== 'string' || !req.query.code ||
          typeof req.query.state !== 'string' || !req.query.state ||
          typeof startedAt !== 'number' || startedAt > Date.now() ||
          Date.now() - startedAt > stateMaxAge) {
        req.session = null
        res.sendStatus(400)
        return
      }

      authentication.authenticate('oauth2', {session: false}, function(
        err: unknown
      , user: Express.User | false | undefined
      ) {
        req.session = null
        if (err) {
          log.error('OAuth provider authentication failed')
          res.sendStatus(502)
          return
        }
        const identity = getIdentity(user, options)
        if (!identity) {
          log.warn('OAuth authentication denied')
          res.sendStatus(403)
          return
        }
        dbapi.loadUser(identity.email).then(function(existing) {
          // STF rejects a changed name for an existing email at login.
          res.redirect(urlutil.addParams(options.appUrl, {
            jwt: jwtutil.encode({
              payload: {email: identity.email, name: existing?.name || identity.name}
            , secret: options.secret
            , header: {exp: Date.now() + 24 * 3600 * 1000}
            })
          }))
        }).catch(function() {
          log.error('Unable to look up the STF account for OAuth login')
          res.sendStatus(500)
        })
      })(req, res, next)
    }
  )

  app.use(function(err: unknown, req: express.Request, res: express.Response,
    next: express.NextFunction) {
    if (res.headersSent) {
      next(err)
      return
    }
    log.error('Unexpected OAuth authentication error')
    res.sendStatus(500)
  })

  server.listen(options.port)
  log.info('Listening on port %d', options.port)
  return server
}
