var chalk = require('chalk'),
  path = require('path'),
  fs = require('fs'),
  _ = require('lodash'),
  socketIO = require('socket.io'),
  Monitor = require('./lib/monitor'),
  Log = require('./lib/util/log'),
  Web = require('./web/index');

if (path.basename(process.mainModule.filename, '.js') == 'pm2-gui') {
  var cmd, file;
  if (process.argv.length > 2) {
    cmd = process.argv[2];
  }
  if (process.argv.length > 3) {
    file = process.argv[3];
  }
  cmd = cmd || 'start';

  switch (cmd) {
  case 'start':
    startWebServer(file);
    break;
  case 'mon':
    dashboard(file);
    break;
  default:
    break;
  }
}

exports.startWebServer = startWebServer;
exports.dashboard = dashboard;
exports.exitGraceful = exitGraceful;

function startWebServer(confFile) {
  var monitor = slave({
      confFile: confFile
    }),
    options = monitor.options;

  options.port = options.port || 8088;
  var server = Web({
    middleware: function (req, res, next) {
      req._config = options;
      next();
    },
    port: options.port
  });

  monitor._sockio = socketIO(server);
  monitor.run();
  console.info('Web server is listening on 0.0.0.0:' + options.port);
};

function dashboard(confFile) {
  var monitor = slave({
    confFile: confFile
  });
  monitor.dashboard();
};

function exitGraceful(code, signal) {
  code = code || 0;
  if (signal != '-f') {
    console.debug('Slave has exited, code: ' + code + ', signal: ' + (signal || 'NULL'));
  }
  var fds = 0;

  function tryToExit() {
    if ((fds & 1) && (fds & 2)) {
      process.exit(code);
    }
  }

  [process.stdout, process.stderr].forEach(function (std) {
    var fd = std.fd;
    if (!std.bufferSize) {
      fds = fds | fd;
    } else {
      std.write && std.write('', function () {
        fds = fds | fd;
        tryToExit();
      });
    }
  });
  tryToExit();
};

function slave(options) {
  process.title = 'pm2-gui slave';
  options = options || {};
  var confFile = options.confFile;
  if (!confFile) {
    confFile = path.resolve(__dirname, './pm2-gui.ini');

    if (!fs.existsSync(confFile)) {
      console.error(chalk.bold(confFile), 'does not exist!');
      return process.exit(0);
    }
  }
  var monitor = Monitor({
    confFile: confFile
  });

  Log(monitor.options.log);

  console.log(chalk.cyan(
    '\n' +
    '█▀▀█ █▀▄▀█ █▀█ ░░ ▒█▀▀█ ▒█░▒█ ▀█▀\n' +
    '█░░█ █░▀░█ ░▄▀ ▀▀ ▒█░▄▄ ▒█░▒█ ▒█░\n' +
    '█▀▀▀ ▀░░░▀ █▄▄ ░░ ▒█▄▄█ ░▀▄▄▀ ▄█▄\n'));

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', restart);
  process.on('uncaughtException', caughtException);
  process.on('exit', exitGraceful)

  function shutdown(code, signal) {
    console.info('Shutting down....');
    monitor.quit();
    console.info('Shutdown complete!');
    exitGraceful(code, '-f');
  }

  function restart() {
    if (process.send) {
      process.send({
        action: 'restart'
      });
    } else {
      console.error('No IPC found, could not restart monitor, shutting down.');
      shutdown(1);
    }
  }

  function caughtException(err) {
    console.error(err.stack);
    shutdown(1);
  }

  return monitor;
};
