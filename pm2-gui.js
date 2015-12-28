var chalk = require('chalk'),
  path = require('path'),
  fs = require('fs'),
  _ = require('lodash'),
  socketIO = require('socket.io'),
  inquirer = require("inquirer"),
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
  case 'agent':
    startAgent(file);
    break;
  case 'mon':
    dashboard(file);
    break;
  default:
    Log({
      level: 0,
      prefix: true
    });
    console.error('Command', cmd, 'is not supported!')
    break;
  }
}

exports.startWebServer = startWebServer;
exports.startAgent = startAgent;
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

  monitor.sockio = socketIO(server);
  monitor.run();
  console.info('Web server is listening on 0.0.0.0:' + options.port);
}

function startAgent(confFile) {
  var monitor = slave({
    confFile: confFile
  });

  var options = monitor.options;
  options.agent = options.agent || {};
  if (options.agent.offline) {
    console.error('Agent is offline, can not start it.');
    return process.exit(0);
  }
  options.port = options.port || 8088;
  var sockio = socketIO();
  sockio.listen(options.port);
  monitor.sockio = sockio;
  console.info('Socket.io server is listening on 0.0.0.0:' + options.port);
}

function dashboard(confFile) {
  // restore cursor;
  process.on('exit', function () {
    process.stdout.write('\u001b[?25h');
  });
  var monitor = slave({
      confFile: confFile
    }),
    options = monitor.options;

  options.agent = options.agent || {};
  var remotable = options.remotes && _.keys(options.remotes).length > 0;

  if (options.agent.offline && remotable) {
    console.error('No agent is online, can not start it.');
    return process.exit(0);
  }

  options.port = options.port || 8088;

  if (!remotable) {
    return _connectToDashboard(monitor, options);
  }
  console.info('Remoting servers are online, choose one you are intrested in.')
  var q = {
      name: 'socket_server',
      message: 'Which socket server would you wanna connect to',
      type: 'list',
      choices: []
    },
    maxShortLength = 0;
  for (var remote in options.remotes) {
    var connectionString = options.remotes[remote];
    q.choices.push({
      value: connectionString,
      short: remote
    });
    maxShortLength = Math.max(maxShortLength, remote.length);
  }
  if (!options.agent.offline) {
    q.choices.push(new inquirer.Separator());
    var short = 'local',
      connectionString = (options.agent && options.agent.authorization ? options.agent.authorization + '@' : '') + 'localhost:' + options.port;
    q.choices.push({
      value: connectionString,
      short: short
    });
    maxShortLength = Math.max(maxShortLength, short.length);
  }

  q.choices.forEach(function (c) {
    if (c.type != 'separator') {
      c.name = '[' + c.short + Array(maxShortLength - c.short.length + 1).join(' ') + '] ' + c.value;
    }
  });

  console.log('');

  inquirer.prompt(q, function (answers) {
    var connectionString = answers.socket_server;
    console.log(connectionString);
    _connectToDashboard(monitor, options);
    // TODO:
  });
}

function _connectToDashboard(monitor, options) {
  var sockio = socketIO();
  sockio.listen(options.port);
  monitor.sockio = sockio;
  Log({
    level: 1000
  });
  monitor.run();
  monitor.dashboard(options);
}

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
}

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
}
