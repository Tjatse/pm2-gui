var spawn = require('child_process').spawn
var fs = require('fs')
var _ = require('lodash')
var async = require('async')
var rpc = require('pm2-axon-rpc')
var axon = require('pm2-axon')

/**
 * Forever lib.
 * @type {{}}
 */
var pm = module.exports = {}

var re_blank = /^[\s\r\t]*$/
var allowedEvents = ['start', 'restart', 'exit', 'online']

/**
 * Subscribe event BUS.
 * @param {String} sockPath
 * @param {Function} cb
 * @param {Object} context
 */
pm.sub = function (sockPath, cb, context) {
  var sub = axon.socket('sub-emitter')
  // Once awake from sleeping.
  sub.on('log:*', function (e, d) {
    // Do not subscribe it.
    sub.off('log:*')
    d.event = 'awake'
    cb.call(context, d)
  })

  // Process events.
  sub.on('process:*', function (e, d) {
    if (d && !!~allowedEvents.indexOf(d.event)) {
      cb.call(context, d)
    }
  })
  sub.connect(sockPath)
  return sub
}

/**
 * Get PM2 version.
 * @param {String} sockPath
 * @param {Function} cb
 */
pm.version = function (sockPath, cb) {
  pm._rpc({
    sockPath: sockPath,
    events: [
      ['getVersion', {}, cb]
    ]
  })
}

/**
 * List available processes.
 * @param {String} sockPath
 * @param {Function} cb
 * @param {Object} context
 */
pm.list = function (sockPath, cb, context) {
  if (!fs.existsSync(sockPath)) {
    return cb.call(context, [])
  }
  pm._rpc({
    sockPath: sockPath,
    events: [
      ['getMonitorData', {}, cb]
    ],
    context: context || this
  })
}

/**
 * Execute remote RPC events.
 * @param {Object} opts including:
 *  {String} sockPath
 *  {Object} context
 *  {Object} args
 *  {Object} events
 *    key: event name
 *    value: callback function
 * @private
 */
pm._rpc = function (opts) {
  var req = axon.socket('req')
  var rpcSock = req.connect(opts.sockPath)
  var rpcClient = new rpc.Client(req)

  // Connect RPC server.
  rpcSock.on('connect', function () {
    // Execute request.
    var waterfalls = opts.events.map(function (event) {
      return function (next) {
        var cb = typeof event[event.length - 1] === 'function' ? event.pop() : null
        if (cb) {
          event.push(function () {
            // Wrap arguments, no [].slice (avoid leak)!!!
            var args = new Array(arguments.length)
            for (var i = 0; i < args; i++) {
              args[i] = arguments[i]
            }
            cb.apply(opts.context, arguments)
            next()
          })
        }
        rpcClient.call.apply(rpcClient, event)
        if (!cb) {
          next()
        }
      }
    })
    async.waterfall(waterfalls, function () {
      rpcSock.close()
    })
  })
}

/**
 * Find process by pm_id.
 * @param {String} sockPath
 * @param {String} id
 * @param {Function} cb
 * @private
 */
pm._findById = function (sockPath, id, cb) {
  pm.list(sockPath, function (err, procs) {
    if (err) {
      return cb(err)
    }
    if (!procs || procs.length === 0) {
      return cb(new Error('No PM2 process running, the sockPath is "' + sockPath + '", please make sure it is existing!'))
    }

    var proc = _.find(procs, function (p) {
      return p && p.pm_id === id
    })

    if (!proc) {
      return cb(new Error('Cannot find pm process by pm_id: ' + id))
    }

    cb(null, proc)
  }, true)
}

/**
 * Trigger actions of process by pm_id.
 * @param {String} sockPath
 * @param {String} id
 * @param {Function} cb
 */
pm.action = function (sockPath, action, id, cb) {
  if (id === 'all') {
    pm.list(sockPath, function (err, procs) {
      if (err) {
        return cb(err)
      }
      if (!procs || procs.length === 0) {
        return cb(new Error('No PM2 process running, the sockPath is "' + sockPath + '", please make sure it is existing!'))
      }

      async.map(procs, function (proc, next) {
        pm._actionByPMId(sockPath, proc, action, next.bind(null, null))
      }, cb)
    })
  } else {
    pm._findById(sockPath, id, function (err, proc) {
      if (err) {
        return cb(err)
      }
      pm._actionByPMId(sockPath, proc, action, cb)
    })
  }
}

/**
 * Trigger actions of process by pm_id.
 * @param {String} sockPath
 * @param {Object} proc
 * @param {String} action
 * @param {Function} cb
 * @private
 */
pm._actionByPMId = function (sockPath, proc, action, cb) {
  var noBusEvent = action === 'delete' && proc.pm2_env.status !== 'online'
  var pmId = proc.pm_id

  action += 'ProcessId'
  var watchEvent = ['stopWatch', action, {
    id: pmId
  }, function () {}]

  if (!!~['restart'].indexOf(action)) { // eslint-disable-line no-extra-boolean-cast
    watchEvent.splice(0, 1, 'restartWatch')
    watchEvent.pop()
  }

  var actionEvent = [action, pmId, function (err, sock) {
    cb(err, noBusEvent)
  }]

  if (action === 'restartProcessId') {
    actionEvent.splice(1, 1, {
      id: pmId
    })
  }

  pm._rpc({
    sockPath: sockPath,
    events: [
      watchEvent,
      actionEvent
    ]
  })
}

/**
 * Tail logs.
 * @param {Object} opts
 * @param {Function} each Iterator
 * @param {Function} cb
 * @returns {*}
 */
pm.tail = function (opts, each, cb) {
  // Fetch the proccess that we need.
  pm._findById(opts.sockPath, opts.pm_id, function (err, proc) {
    if (err) {
      return cb(err)
    }
    proc.pm2_log = opts.logPath
    // Tail logs.
    cb(null, pm._tailLogs(proc, each))
  })
}
/**
 * Use linux `tail` command to grep logs.
 * @param {Object} proc
 * @param {Function} cb
 * @returns {*}
 * @private
 */
pm._tailLogs = function (proc, cb) {
  var logs = {
    'pm2': proc.pm2_log
  }
  if (proc.pm_log_path) {
    logs.entire = proc.pm2_env.pm_log_path
  } else {
    if (proc.pm2_env.pm_out_log_path) {
      logs.out = proc.pm2_env.pm_out_log_path
    }
    if (proc.pm2_env.pm_err_log_path) {
      logs.err = proc.pm2_env.pm_err_log_path
    }
  }

  var logFiles = []
  for (var key in logs) {
    var file = logs[key]
    if (fs.existsSync(file)) {
      logFiles.push(file)
    }
  }
  if (logFiles.length === 0) {
    return null
  }
  var tail = spawn('tail', ['-n', 20, '-f'].concat(logFiles), {
    killSignal: 'SIGTERM',
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Use utf8 encoding.
  tail.stdio.forEach(function (stdio) {
    stdio && stdio.setEncoding('utf8')
  })

  // stdout.
  tail.stdout.on('data', function (data) {
    var lines = []
    data.split(/\n/).forEach(function (line) {
      if (!re_blank.test(line)) {
        lines.push(line)
      }
    })
    if (lines.length > 0) {
      cb(null, lines)
    }
  })

  // handle error.
  tail.stderr.on('data', function (data) {
    console.error(data.toString())
    tail.disconnect()
    cb(new Error(data.toString().replace(/\n/, '')))
  })
  tail.unref()
  return tail
}
