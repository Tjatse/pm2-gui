'use strict'

var express = require('express')
var session = require('express-session')
var path = require('path')
var http = require('http')
var crypto = require('crypto')
var router = require('../lib/util/router')
var db = require('../lib/db')
var settings = require('../lib/settings')

function getSessionSecret () {
  try {
    db.open()
    var secret = settings.getSettings().session_secret
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex')
      db.setSetting('session_secret', secret)
    }
    return secret
  } catch (err) {
    return process.env.PM2_GUI_SESSION_SECRET || 'pm2@gui'
  }
}

module.exports = function (options) {
  var app = express()
  app.set('view engine', 'pug')
  app.set('views', path.join(__dirname, 'templates/views'))
  app.use(express.static(path.join(__dirname, 'public')))
  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: true }))

  var sessionMiddleware = session({
    name: 'pm2gui.sid',
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    }
  })
  app.use(sessionMiddleware)

  if (options.middleware) {
    app.use(options.middleware)
  }
  router(app)

  var server = http.createServer(app)
  // Project uploads run pnpm install on the NAS; keep sockets open.
  try { server.requestTimeout = 0 } catch (err) {}
  try { server.headersTimeout = 0 } catch (err) {}
  try { server.timeout = 0 } catch (err) {}
  server.listen(options.port)
  server.sessionMiddleware = sessionMiddleware
  return server
}
