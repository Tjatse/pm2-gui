var express = require('express'),
  session = require('express-session'),
  swig = require('swig'),
  path = require('path'),
  http = require('http'),
  Monitor = require('../lib/monitor'),
  router = require('../lib/util/router');

module.exports = runServer;

function runServer(options) {
  var app = express();
  app.set('view engine', 'html');
  app.set('views', path.join(__dirname, 'views'));
  app.engine('html', swig.renderFile);
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(session({
    secret: 'pm2@gui',
    resave: false,
    saveUninitialized: true
  }));
  if (options.middleware) {
    app.use(options.middleware);
  }
  router(app);

  var server = http.Server(app);
  server.listen(options.port);
  return server;
}
