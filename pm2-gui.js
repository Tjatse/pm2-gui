var Monitor = require('./lib/monitor'),
  chalk = require('chalk'),
  path = require('path'),
  fs = require('fs'),
  _ = require('lodash'),
  Log = require('./lib/util/log');

exports.start = function (options) {
  process.title = 'pm2-gui slave';
  options = options || {};
  var confFile = options.confFile;
  if (!confFile) {
    confFile = './pm2-gui.ini';
    if (process.argv.length > 2) {
      confFile = process.argv[2];
    }
    confFile = path.resolve(__dirname, confFile);

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
    '█▀▀█ █▀▄▀█ █▀█ ░░ █▀▀▀ █░░█ ░▀░\n' +
    '█░░█ █░▀░█ ░▄▀ ▀▀ █░▀█ █░░█ ▀█▀\n' +
    '█▀▀▀ ▀░░░▀ █▄▄ ░░ ▀▀▀▀ ░▀▀▀ ▀▀▀\n'));
  monitor.run();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', restart);
  process.on('uncaughtException', caughtException);
  process.on('exit', exports.exitGraceful)

  function shutdown(code, signal) {
    console.info('Shutting down....');
    monitor.quit();
    console.info('Both', chalk.bold('pm2-emitter'), 'and', chalk.bold('statsd dgram'), 'sockets are closed.');
    console.info('Shutdown complete!');
    exports.exitGraceful(code, '-f');
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
};

exports.exitGraceful = function exit(code, signal) {
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
if (path.basename(process.mainModule.filename, '.js') == 'pm2-ant') {
  exports.start();
}
