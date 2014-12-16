var express = require('express'),
    swig    = require('swig'),
    path    = require('path'),
    chalk   = require('chalk'),
    Monitor = require('../lib/mon'),
    Debug   = require('../lib/util/debug');

module.exports = runServer;

function runServer(port, debug){
  var app = express();

  // all environments
  app.set('view engine', 'html');
  app.set('views', path.join(__dirname, 'views'));
  app.engine('html', swig.renderFile);
  app.use(express.static(path.join(__dirname, 'public')));

  var log = Debug(({namespace: 'pm2-gui', debug: !!debug}));
  // router
  require('../lib/util/router')(app, log);

  if (!port || isNaN(port)) {
    port = 8088;
  }

  var server = require('http').Server(app);
  var io = require('socket.io')(server);
  server.listen(port);
  log.i('http', 'Web server of', chalk.bold.underline('Unitech/PM2'), 'is listening on port', chalk.bold(port));

  var mon = Monitor({
    sockio: io,
    debug : !!debug
  });

  mon.run();
}