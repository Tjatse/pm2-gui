var chalk = require('chalk')
var path = require('path')
var fs = require('fs')
var _ = require('lodash')
var socketIO = require('socket.io')
var inquirer = require('inquirer')
var Monitor = require('./lib/monitor')
var Log = require('./lib/util/log')
var Web = require('./web/index')
var layout = require('./lib/blessed-widget/layout')

if (path.basename(process.mainModule.filename, '.js') === 'pm2-gui') {
  var cmd, file
  if (process.argv.length > 2) {
    cmd = process.argv[2]
  }
  if (process.argv.length > 3) {
    file = process.argv[3]
  }
  cmd = cmd || 'start'

  switch (cmd) {
    case 'start':
      startWebServer(file)
      break
    case 'agent':
      startAgent(file)
      break
    case 'mon':
      dashboard(file)
      break
    default:
      Log({
        level: 0,
        prefix: true
      })
      console.error('Command', cmd, 'is not supported!')
      break
  }
}

exports.startWebServer = startWebServer
exports.startAgent = startAgent
exports.dashboard = dashboard
exports.exitGraceful = exitGraceful

function startWebServer (confFile) {
  var monitor = slave({
    confFile: confFile
  })
  var options = monitor.options

  options.port = options.port || 8088
  var server = Web({
    middleware: function (req, res, next) {
      req._config = options
      next()
    },
    port: options.port
  })

  monitor.sockio = socketIO(server, {
    origins: options.origins || '*:*'
  })
  monitor.run()
  console.info('Web server is listening on 127.0.0.1:' + options.port)
}

function startAgent (confFile) {
  var monitor = slave({
    confFile: confFile
  })

  var options = monitor.options
  options.agent = options.agent || {}
  if (options.agent.offline) {
    console.error('Agent is offline, can not start it.')
    return process.exit(0)
  }
  options.port = options.port || 8088
  var sockio = socketIO()
  sockio.listen(options.port, {
    origins: options.origins || '*:*'
  })
  monitor.sockio = sockio
  monitor.run()
  console.info('Socket.io server is listening on 0.0.0.0:' + options.port)
}

function dashboard (confFile) {
  // restore cursor
  process.on('exit', function () {
    process.stdout.write('\u001b[?25h')
  })
  var monitor = slave({
    confFile: confFile
  })
  var options = _.clone(monitor.options)
  var q = Monitor.available(options)

  if (!q) {
    console.error('No agent is online, can not start it.')
    return process.exit(0)
  }
  var ql = q.choices.length
  if (ql === 1) {
    if (q.choices[0].short !== 'localhost') {
      console.info('There is just one remoting server online, try to connect it.')
    }
    return _connectToDashboard(monitor, options, Monitor.parseConnectionString(q.choices[0].value))
  }
  if (!options.agent || !options.agent.offline) {
    q.choices.splice(ql - 1, 0, new inquirer.Separator())
  }

  console.info('Remoting servers are online, choose one you are intrested in.')
  console.log('')
  inquirer.prompt(q).then(function (answers) {
    console.log('')
    _connectToDashboard(monitor, options, Monitor.parseConnectionString(answers.socket_server))
  })
}

function exitGraceful (code, signal) {
  code = code || 0
  if (signal !== '-f') {
    console.debug('Slave has exited, code: ' + code + ', signal: ' + (signal || 'NULL'))
  }
  var fds = 0

  function tryToExit () {
    if ((fds & 1) && (fds & 2)) {
      process.exit(code)
    }
  }

  [process.stdout, process.stderr].forEach(function (std) {
    var fd = std.fd
    if (!std.bufferSize) {
      fds = fds | fd
    } else {
      std.write && std.write('', function () {
        fds = fds | fd
        tryToExit()
      })
    }
  })
  tryToExit()
}

function slave (options) {
  process.title = 'pm2-gui slave'
  options = options || {}
  var confFile = options.confFile
  if (!confFile) {
    confFile = path.resolve(__dirname, './pm2-gui.ini')

    if (!fs.existsSync(confFile)) {
      console.error(chalk.bold(confFile), 'does not exist!')
      return process.exit(0)
    }
  }
  var monitor = Monitor({
    confFile: confFile
  })

  Log(monitor.options.log)

  console.log(chalk.cyan(
    '\n' +
    '█▀▀█ █▀▄▀█ █▀█ ░░ ▒█▀▀█ ▒█░▒█ ▀█▀\n' +
    '█░░█ █░▀░█ ░▄▀ ▀▀ ▒█░▄▄ ▒█░▒█ ▒█░\n' +
    '█▀▀▀ ▀░░░▀ █▄▄ ░░ ▒█▄▄█ ░▀▄▄▀ ▄█▄\n'))

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', restart)
  process.on('uncaughtException', caughtException)
  process.on('exit', exitGraceful)

  function shutdown (code, signal) {
    console.info('Shutting down....')
    monitor.quit()
    console.info('Shutdown complete!')
    exitGraceful(code, '-f')
  }

  function restart () {
    if (process.send) {
      process.send({
        action: 'restart'
      })
    } else {
      console.error('No IPC found, could not restart monitor, shutting down.')
      shutdown(1)
    }
  }

  function caughtException (err) {
    console.error(err.stack)
    shutdown(1)
  }

  return monitor
}

function _connectToDashboard (monitor, options, connection) {
  connection = _.extend({}, options, connection)
  if (!!~['127.0.0.1', '0.0.0.0', 'localhost'].indexOf(connection.hostname)) { // eslint-disable-line no-extra-boolean-cast
    return monitor.connect(connection, function (socket) {
      console.info('Agent is online, try to connect it in dashboard directly.')
      layout(connection).render(monitor)
    }, function (err, socket) {
      if (err === 'unauthorized') {
        console.error('There was an error with the authentication:', err)
        return process.exit(0)
      }
      console.warn('Agent is offline, try to start it.')
      var sockio = socketIO()
      sockio.listen(connection.port, {
        origins: options.origins || '*:*'
      })
      monitor.sockio = sockio
      monitor.run()
      layout(connection).render(monitor)
    })
  }

  layout(connection).render(monitor)
}
