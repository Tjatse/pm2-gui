'use strict'

var fs = require('fs')
var _ = require('lodash')
var async = require('async')
var rpc = require('pm2-axon-rpc')
var axon = require('pm2-axon')

/**
 * Process management lib.
 * @type {Object}
 */
var pm = module.exports = {}

var allowedEvents = ['start', 'restart', 'exit', 'online']

/**
 * Make options more safe.
 * @param  {Object} options
 * @param  {Mixed} context
 * @return {Object}
 */
function safeOptions (options, context) {
  if (_.isString(options)) {
    options = {
      socketPath: options
    }
  }
  if (!options.context && context) {
    options.context = context
  }
  return options
}
/**
 * Subscribe event BUS.
 * @param {Object} options:
 *        {String} socketPath
 *        {Object} context
 * @param {Function} fn
 */
pm.sub = function (options, fn) {
  var sub = axon.socket('sub-emitter')
  options = safeOptions(options, this)
  // Process events.
  sub.on('process:*', function (e, d) {
    if (d && !!~allowedEvents.indexOf(d.event)) {
      fn.call(options.context, d)
    }
  })
  sub.connect(options.socketPath)
  return sub
}

/**
 * Get PM2 version.
 * @param {String} socketPath
 * @param {Function} fn
 */
pm.version = function (socketPath, fn) {
  pm._rpc({
    socketPath: socketPath,
    events: [
      ['getVersion', {}, fn]
    ]
  })
}

/**
 * List available processes.
 * @param {Object} options:
 *        {String} socketPath
 *        {Object} context
 * @param {Function} fn
 */
pm.list = function (options, fn) {
  options = safeOptions(options, this)
  if (!fs.existsSync(options.socketPath)) {
    return fn.call(options.context, [])
  }
  pm._rpc({
    socketPath: options.socketPath,
    events: [
      ['getMonitorData', {}, fn]
    ],
    context: options.context
  })
}

/**
 * Execute remote RPC events.
 * @param {Object} opts including:
 *  {String} socketPath
 *  {Object} context
 *  {Object} args
 *  {Object} events
 *    key: event name
 *    value: callback function
 * @private
 */
pm._rpc = function (options) {
  options = safeOptions(options)
  var req = axon.socket('req')
  var rpcSock = req.connect(options.socketPath)
  var rpcClient = new rpc.Client(req)

  // Connect RPC server.
  rpcSock.on('connect', function () {
    // Execute request.
    var waterfalls = options.events.map(function (event) {
      return function (next) {
        var cb = _.isFunction(event[event.length - 1]) ? event.pop() : null
        if (cb) {
          event.push(function () {
            // Wrap arguments, no [].slice (avoid leak)!!!
            var argsLen = arguments.length
            var args = new Array(argsLen)
            for (var i = 0; i < argsLen; i++) {
              args[i] = arguments[i]
            }
            cb.apply(options.context, arguments)
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
  // ignore error
  rpcSock.on('error', function (err) {
    console.error('rpc error:', err.message)
    try {
      rpcSock.close()
    } catch (err) {}
  })
}

/**
 * Find process by pm_id.
 * @param {Object} options:
 *        {String} socketPath
 *        {String} id
 * @param {Function} fn
 * @private
 */
pm._findById = function (options, fn) {
  options = safeOptions(options)
  pm.list(options, function (err, procs) {
    if (err) {
      return fn(err)
    }
    if (!procs || procs.length === 0) {
      return fn(new Error('No PM2 process running, the socketPath is "' + options.socketPath + '", please make sure it is existing!'))
    }

    var proc = _.find(procs, function (p) {
      return p && p.pm_id === options.id
    })

    if (!proc) {
      return fn(new Error('Cannot find pm process by pm_id: ' + options.id))
    }

    fn(null, proc)
  })
}

/**
 * Trigger actions of process by pm_id.
 * @param {Object} options:
 *        {String} socketPath
 *        {String} action
 *        {String} id
 * @param {Function} fn
 */
pm.action = function (options, fn) {
  options = safeOptions(options)
  if (options.id === 'all') {
    return pm.list(options, function (err, procs) {
      if (err) {
        return fn(err)
      }

      if (!procs || procs.length === 0) {
        return fn(new Error('No PM2 process is running!'))
      }

      // Do the jobs without catching errors.
      async.map(procs, function (proc, next) {
        pm._actionByPMId({
          socketPath: options.socketPath,
          process: proc,
          action: options.action
        }, next.bind(null, null))
      }, fn)
    })
  }
  pm._findById(options, function (err, proc) {
    if (err) {
      return fn(err)
    }
    pm._actionByPMId({
      socketPath: options.socketPath,
      process: proc,
      action: options.action
    }, fn)
  })
}

/**
 * Trigger actions of process by pm_id.
 * @param {Object} options:
 *        {String} socketPath
 *        {Object} process
 *        {String} action
 * @param {Function} fn
 * @private
 */
pm._actionByPMId = function (options, fn) {
  var noBusEvent = action === 'delete' && options.process.pm2_env.status !== 'online'
  var pmId = options.process.pm_id
  var action = options.action
  //
  // event keys:
  // restartProcessId
  // deleteProcessId
  // stopProcessId
  // saveProcessId
  // stopWatch
  // restartWatch
  //
  action += 'ProcessId'
  // watch event
  var watchEvent = ['stopWatch', action, {
    id: pmId
  }, function () {}]
  if (!!~['restart'].indexOf(action)) { // eslint-disable-line no-extra-boolean-cast
    watchEvent.splice(0, 1, 'restartWatch')
    watchEvent.pop()
  }
  // wrap action event
  var actionEvent = [action, pmId, function (err, sock) {
    fn(err, noBusEvent)
  }]
  console.debug('[pm:' + pmId + ']', action)
  if (action === 'restartProcessId') {
    actionEvent.splice(1, 1, {
      id: pmId
    })
  }

  pm._rpc({
    socketPath: options.socketPath,
    events: [
      watchEvent,
      actionEvent
    ]
  })
}
