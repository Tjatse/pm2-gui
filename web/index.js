var express = require('express'),
  session = require('express-session'),
  path = require('path'),
  http = require('http'),
  Monitor = require('../lib/monitor'),
  router = require('../lib/util/router');

module.exports = runServer;

function runServer(options) {
  var app = express();
  app.set('view engine', 'jade');
  app.set('views', path.join(__dirname, 'templates/views'));
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
