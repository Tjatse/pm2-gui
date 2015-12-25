var express = require('express'),
    swig    = require('swig'),
    path    = require('path'),
    chalk   = require('chalk'),
    Monitor = require('../lib/monitor'),
    Debug   = require('../lib/util/debug'),
    session = require('express-session');

module.exports = runServer;

function runServer(debug){
  var app = express();

  // all environments
  app.set('view engine', 'html');
  app.set('views', path.join(__dirname, 'views'));
  app.engine('html', swig.renderFile);
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(session({
    secret           : 'pm2@gui',
    resave           : false,
    saveUninitialized: true
  }));

  var log = Debug(({namespace: 'pm2-gui', debug: !!debug}));
  // router
  require('../lib/util/router')(app, log);

  var server = require('http').Server(app);
  var io = require('socket.io')(server);

  try {
    var mon = Monitor({
      sockio: io,
      debug : !!debug
    });
    var port = mon.config('port');
    server.listen(port);
    log.i('http', 'Web server of', chalk.bold.underline('Unitech/PM2'), 'is listening on port', chalk.bold(port));

    mon.run();
  }catch(err){
    log.e(chalk.red(err.message));
  }
}