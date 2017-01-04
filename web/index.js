'use strict'

var path = require('path')
var http = require('http')
var express = require('express')
var compression = require('compression')
var session = require('express-session')
var bodyParser = require('body-parser')

var router = require('./router')

/**
 * Start the express server
 * @param  {Object} options:
 *         {Function} middleware
 *         {Number}   port
 * @return {Express}  server
 */
module.exports = function (options) {
  var app = express()
  // view engine
  app.set('view engine', 'jade')
  app.set('views', path.join(__dirname, 'templates/views'))
  // session
  app.use(express.static(path.join(__dirname, 'public')))
  app.use(session({
    secret: 'pm2@gui',
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 7 * 24 * 3600000
    }
  }))
  // body parser
  app.use(bodyParser.urlencoded({
    extended: true
  }))
  app.use(bodyParser.json())
  // compression
  app.use(compression())
  // middlewares
  if (options.middleware) {
    app.use(options.middleware)
  }
  // routers
  app.use('/', router)
  // app.get('*', function (req, res) {
  //   res.render('errors/404', {
  //     title: '404'
  //   })
  // })
  // server
  var server = http.Server(app)
  server.listen(options.port)
  server.on('listening', function () {
    let addr = server.address()
    console.info('Express server started on port %s at %s', addr.port, addr.address || 'localhost')
  })
  return server
}
