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
var confFile = './pm2-gui.ini'
var cmd = 'start'

if (process.argv.length > 2) {
  cmd = process.argv[2]
}

if (process.argv.length > 3) {
  confFile = process.argv[3]
}

confFile = path.resolve(processDirname, confFile)

if (!fs.existsSync(confFile)) {
  console.error(chalk.bold(confFile), chalk.red('does not exist!'))
  process.exit(0)
} else {
  var monitor = Monitor({
    confFile: confFile
  })
  var daemonize = monitor.options.daemonize && cmd !== 'mon'

  Log(monitor.options.log)

  var pidfile = path.resolve(processDirname, './pm2-gui.pid')

  var Daemon = {
    restarts: 0,
    init: function (next) {
      process.on('SIGTERM', Daemon.stop)
      process.on('SIGINT', Daemon.stop)
      process.on('SIGHUP', Daemon.restart)
      next && next()
    },
    start: function (next) {
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
      console.info('Forking slave...')
      Daemon.timer = null
      var worker = fork(path.resolve(processDirname, 'pm2-gui.js'), [cmd, confFile, '--color'], {
        silent: daemonize,
        env: process.env
      })
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
          Daemon.timer = setTimeout(Daemon.fork, 3000)
        }
      })

      worker.on('message', function (message) {
        if (typeof message === 'object' && message.action) {
          if (message.action === 'restart') {
            Daemon.restart()
          }
        }
      })

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
      var child = spawn(process.execPath, args, {
        env: env,
        detached: false,
        cwd: processDirname,
        stdio: ['ignore', process.stdout, process.stderr]
      })
      child.unref()
      process.exit()
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
    }
  })
}
