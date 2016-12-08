'use strict'

var chalk = require('chalk')
var path = require('path')
var fs = require('fs')
var async = require('async')
var cp = require('child_process')
var fork = cp.fork
var spawn = cp.spawn
var Monitor = require('./monitor')
var Log = require('./util/log')

var processDirname = path.resolve(__dirname, '../')
var workDirname = process.cwd()

// default settings
var confFile = Monitor.DEF_CONF_FILE
var cmd = 'start'

// bind variables if necessary
var processArgLen = process.argv.length
if (processArgLen > 2) {
  cmd = process.argv[2]
}
if (processArgLen > 3) {
  confFile = process.argv[3]
}

// Find the config file from both process directory and work directory.
// inspired by @aeisenberg
var confFilePath = localeConfigFile(confFile)
// startup
build(confFilePath)

/**
 * Build daemon system.
 * @param  {String} filePath The full config file path.
 * @return {N/A}
 */
function build (filePath) {
  if (!filePath) {
    console.error(chalk.bold(confFile), chalk.red('does not exist in the following directories:'))
    console.error('∟ ' + processDirname)
    console.error('∟ ' + workDirname)
    process.exit(0)
    return
  }
  // initialize an instance of monitor.
  var monitor = Monitor({
    confFile: filePath
  })
  // *dashboard does not need daemonize-mode.
  var daemonize = monitor.options.daemonize && cmd !== 'mon'
  // initialize logger
  Log(monitor.options.log)
  // storage process id in pm2-gui.pid
  var pidfile = path.resolve(processDirname, './pm2-gui.pid')

  // Daemon instance
  var Daemon = {
    restarts: 0,
    timer: null,
    worker: null,
    init: function (next) {
      // listening on signal (CTRL+C...)
      process.on('SIGTERM', Daemon.stop)
      process.on('SIGINT', Daemon.stop)
      process.on('SIGHUP', Daemon.restart)
      next && next()
    },
    start: function (next) {
      // fork slave
      Daemon.worker = Daemon.fork()
      next && next()
    },
    restart: function () {
      console.info('Restarting...')
      Daemon.kill()
      Daemon.start()
    },
    stop: function () {
      console.info('Stopping...')
      Daemon.kill()
      daemonize && fs.existsSync(pidfile) && fs.unlinkSync(pidfile)
      process.exit(0)
    },
    kill: function () {
      if (Daemon.timer) {
        clearTimeout(Daemon.timer)
        Daemon.timer = null
      }
      if (Daemon.worker) {
        Daemon.worker.suicide = true
        Daemon.worker.kill()
      }
    },
    fork: function () {
      if (Daemon.worker) {
        return console.warn('A slave-worker is running...')
      }
      console.info('Forking slave...')
      Daemon.kill()
      // initialize a fork-mode worker.
      var worker = fork(path.resolve(processDirname, 'pm2-gui.js'), [cmd, filePath, '--color'], {
        silent: daemonize,
        env: process.env
      })
      // safe exit.
      worker.on('exit', function (code, signal) {
        if (code !== 0) {
          if (Daemon.restarts < 10) {
            Daemon.restarts++
            setTimeout(function () {
              Daemon.restarts--
            }, 20000)
          } else {
            console.error(Daemon.restarts + ' restarts in 20 seconds, view the logs to investigate the crash problem.')
            return process.exit(0)
          }
        }
        if (!worker.suicide && code !== 0) {
          Daemon.worker = null
          Daemon.timer = setTimeout(Daemon.fork, 3000)
        }
      })

      // listening process message.
      worker.on('message', function (message) {
        if (typeof message === 'object' && message.action) {
          if (message.action === 'restart') {
            Daemon.restart()
          }
        }
      })

      // daemon logs
      var logDir = monitor.options.log.dir
      var stdout = 'pm2-gui.out'
      var stderr = 'pm2-gui.err'

      if (!logDir) {
        logDir = './logs'
      }
      logDir = path.resolve(processDirname, logDir)
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir)
      }

      if (daemonize) {
        stdout = fs.createWriteStream(path.join(logDir, stdout))
        stderr = fs.createWriteStream(path.join(logDir, stderr))
        worker.stdout.pipe(stdout)
        worker.stderr.pipe(stderr)

        fs.writeFile(pidfile, worker.pid)
      }
      return worker
    },
    daemonize: function () {
      if (process.env.daemonized) {
        console.info('Daemonized with pid [' + process.pid + '].')
        return
      }
      console.info('Spawning daemon...')
      var args = [].concat(process.argv)
      args.shift()
      var env = process.env
      env.daemonized = true
      // spawn a child process.
      var child = spawn(process.execPath, args, {
        env: env,
        detached: false,
        cwd: processDirname,
        stdio: ['ignore', process.stdout, process.stderr]
      })
      child.unref()
      process.exit(0)
    }
  }

  if (daemonize) {
    Daemon.daemonize()
  }

  process.title = 'pm2-gui daemon ' + confFile
  async.series([
    Daemon.init,
    Daemon.start
  ], function (err) {
    if (err) {
      console.error(err.stack)
    } else {
      console.info('Ready!!!')
    }
  })
}

/**
 * Find the config file from both process directory and work directory.
 * @return {String} Returns full path if exists.
 */
function localeConfigFile (file) {
  var existingFilePath
  [processDirname, workDirname].some(function (dir) {
    var filePath = path.resolve(dir, file)
    if (fs.existsSync(filePath)) {
      existingFilePath = filePath
      return true
    }
    return false
  })
  return existingFilePath
}
