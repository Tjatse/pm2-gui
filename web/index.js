var express = require('express')
var session = require('express-session')
var path = require('path')
var http = require('http')
var router = require('../lib/util/router')

module.exports = runServer

function runServer (options) {
  var app = express()
  app.set('view engine', 'jade')
  app.set('views', path.join(__dirname, 'templates/views'))
  app.use(express.static(path.join(__dirname, 'public')))
  app.use(session({
    secret: 'pm2@gui',
    resave: false,
    saveUninitialized: true
  }))
  if (options.middleware) {
    app.use(options.middleware)
  }
  router(app)

  var server = http.Server(app)
  server.listen(options.port)
  return server
}
