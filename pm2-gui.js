'use strict'

var chalk = require('chalk')
var path = require('path')
var fs = require('fs')
var _ = require('lodash')
var socketIO = require('socket.io')
var inquirer = require('inquirer')

var Monitor = require('./lib/monitor')
var Log = require('./lib/util/log')
var Web = require('./web/index')
var Layout = require('./lib/blessed-widget/layout')

var regLocal = /^(127\.0\.0\.1|0\.0\.0\.0|localhost)$/i

// cli
if (path.basename(process.mainModule.filename, '.js') === 'pm2-gui') {
  var cmd = 'start'
  var file
  var processArgvLen = process.argv.length

  if (processArgvLen > 2) {
    cmd = process.argv[2]
  }
  if (processArgvLen > 3) {
    file = process.argv[3]
  }

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

/**
 * Strat the web server by a configured file.
 * @param  {String} confFile full path of config file
 * @return {N/A}
 */
function startWebServer (confFile) {
  var monitor = slave({
    confFile: confFile
  })
  var options = monitor.options
  // express server
  var server = Web({
    middleware: function (req, res, next) {
      req._config = options
      next()
    },
    port: options.port
  })
  // socket.io server
  monitor.sockio = socketIO(server, {
    origins: options.origins || '*:*'
  })
  monitor.run()
  console.info(`Web server is listening on ${options.origins}:` + options.port)
}

/**
 * Simply start the agent
 * @param  {String} confFile full path of config file
 * @return {N/A}
 */
function startAgent (confFile) {
  var monitor = slave({
    confFile: confFile
  })
  // check agent status
  var options = monitor.options
  if (options.agent && options.agent.offline) {
    console.error('Agent is offline, fatal to start it.')
    return process.exit(0)
  }
  // socket.io server
  var sockio = socketIO()
  sockio.listen(options.port, {
    origins: options.origins || '*:*'
  })
  monitor.sockio = sockio
  monitor.run()
  console.info('Socket.io server is listening on 0.0.0.0:' + options.port)
}

/**
 * Curses like dashboard
 * @param  {String} confFile full path of config file
 * @return {N/A}
 */
function dashboard (confFile) {
  // restore cursor
  // process.on('exit', function () {
  //   process.stderr.write('\u001b[?25h')
  // })
  // which server would you like to connect to.
  var monitor = slave({
    confFile: confFile
  })

  var options = _.clone(monitor.options)
  var q = Monitor.available(options)
  if (!q) {
    console.error('No agent is online, fatal to start it.')
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
    // connecting...
    _connectToDashboard(monitor, options, Monitor.parseConnectionString(answers.socket_server))
  })
}

/**
 * Exit process graceful
 * @param  {Number} code
 * @param  {String} signal
 * @return {N/A}
 */
function exitGraceful (code, signal) {
  code = code || 0
  if (signal !== '-f') {
    console.debug('Slave has exited, code: ' + code + ', signal: ' + (signal || 'N/A'))
  }
  // exit process after std flushed
  var fds = 0
  var stds = [process.stdout, process.stderr]
  stds.forEach(function (std) {
    var fd = std.fd
    if (!std.bufferSize) {
      fds = fds | fd
      return
    }
    std.write && std.write('', function () {
      fds = fds | fd
      tryToExit()
    })
  })
  tryToExit()

  function tryToExit () {
    if ((fds & 1) && (fds & 2)) {
      process.exit(code)
    }
  }
}

/**
 * Spawn a slave-worker
 * @param  {Object} options
 * @return {N/A}
 */
function slave (options) {
  process.title = 'pm2-gui slave'
  options = options || {}
  // check config file.
  var confFile = options.confFile
  if (!confFile) {
    confFile = path.resolve(__dirname, './pm2-gui.ini')

    if (!fs.existsSync(confFile)) {
      console.error(chalk.bold(confFile), 'does not exist!')
      return process.exit(0)
    }
  }

  // initialize monitor.
  var monitor = Monitor({
    confFile: confFile
  })
  // initialize logger.
  Log(monitor.options.log)
  // logo
  console.log(chalk.cyan(
    '\n' +
    '█▀▀█ █▀▄▀█ █▀█ ░░ ▒█▀▀█ ▒█░▒█ ▀█▀\n' +
    '█░░█ █░▀░█ ░▄▀ ▀▀ ▒█░▄▄ ▒█░▒█ ▒█░\n' +
    '█▀▀▀ ▀░░░▀ █▄▄ ░░ ▒█▄▄█ ░▀▄▄▀ ▄█▄\n'))
  // listening signal (CTRL+C...)
  process.on('uncaughtException', caughtException)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', restart)
  process.on('exit', exitGraceful)

  return monitor

  function shutdown (signal) {
    console.info('Shutting down....')
    monitor.quit()
    console.info('Completed!')
    exitGraceful(0, '-f')
  }

  function restart () {
    if (process.send) {
      process.send({
        action: 'restart'
      })
    } else {
      console.error('No IPC found, fatal to restart monitor')
      shutdown(1)
    }
  }

  function caughtException (err) {
    process.stderr.write(chalk.red.bold('[PROCESS EXCEPTION]') + ' ' + err.stack + '\n')
    shutdown(1)
  }
}

/**
 * Connect to socket.io server and render the curses dashboard
 * @param  {Monitor} monitor
 * @param  {Object} options
 * @param  {Object} connection
 * @return {N/A}
 */
function _connectToDashboard (monitor, options, connection) {
  connection = _.extend({}, options, connection)
  if (regLocal.test(connection.hostname)) {
    console.info('Connecting to local dashboard')
    return monitor.connect(connection, function (err, socket) {
      if (err) {
        if (err === 'unauthorized') {
          console.error('There was an error caught when verifying the auth-code:', err.message)
          return process.exit(0)
        }
        console.warn('Fatal to connect to monitor:', err.message)
        console.warn('Agent is offline, try to start it:', '127.0.0.1:' + connection.port)
        // start socket.io server.
        var sockio = socketIO()
        sockio.listen(connection.port, {
          origins: options.origins || '*:*'
        })
        // run monitor
        monitor.sockio = sockio
        monitor.run()
        // render dashboard
        Layout(connection).render(monitor)
        return
      }
      // render dashboard
      console.info('Agent is online, try to connect it in dashboard directly.')
      Layout(connection).render(monitor)
    })
  }

  console.info('Connecting to remote dashboard')
  Layout(connection).render(monitor)
}
