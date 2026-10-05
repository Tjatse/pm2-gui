'use strict'

var pm2 = require('pm2')
var _ = require('lodash')
var async = require('async')
var execFile = require('child_process').execFile

var pm = module.exports = {}

var allowedEvents = ['start', 'restart', 'exit', 'online', 'stop']
var connected = false
var connectOptions = null

function ensureConnected (options, fn) {
  if (connected) {
    return fn(null)
  }

  var opts = {}
  if (options && options.pm2Home) {
    opts.pm2_home = options.pm2Home
  }

  connectOptions = opts
  pm2.connect(Object.keys(opts).length ? opts : undefined, function (err) {
    if (err) {
      return fn(err)
    }
    connected = true
    fn(null)
  })
}

/**
 * Subscribe to PM2 event bus.
 * @param {Object} options
 * @param {Function} fn process event callback
 * @returns {Object} bus handle with close()
 */
pm.sub = function (options, fn) {
  options = options || {}
  var bus = null
  var closed = false

  ensureConnected(options, function (err) {
    if (err) {
      console.error('pm2 connect error:', err.message)
      return
    }

    pm2.launchBus(function (err, launchedBus) {
      if (err) {
        console.error('pm2 bus error:', err.message)
        return
      }

      bus = launchedBus

      bus.on('process:event', function (data) {
        if (data && data.event && allowedEvents.indexOf(data.event) >= 0) {
          fn.call(options.context, data)
        }
      })
    })
  })

  return {
    close: function () {
      if (closed || !bus) {
        return
      }
      closed = true
      try {
        bus.close()
      } catch (err) {}
    },
    on: function (event, handler) {
      if (!bus) {
        var self = this
        setTimeout(function retry () {
          if (bus) {
            bus.on(event, handler)
          } else if (!closed) {
            setTimeout(retry, 50)
          }
        }, 50)
        return
      }
      bus.on(event, handler)
    },
    off: function (event, handler) {
      if (bus) {
        bus.off(event, handler)
      }
    }
  }
}

/**
 * Disconnect from PM2 daemon.
 */
pm.disconnect = function () {
  if (connected) {
    pm2.disconnect()
    connected = false
    connectOptions = null
  }
}

/**
 * Get PM2 version.
 * @param {Object|String} options pm2Home or socketPath (legacy)
 * @param {Function} fn
 */
function readPackageVersion (moduleName) {
  try {
    return require(moduleName + '/package.json').version
  } catch (err) {
    return null
  }
}

function compareVersions (a, b) {
  var pa = String(a || '0').split('.').map(Number)
  var pb = String(b || '0').split('.').map(Number)
  var len = Math.max(pa.length, pb.length)

  for (var i = 0; i < len; i++) {
    var na = pa[i] || 0
    var nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

function maxVersion () {
  var best = null
  for (var i = 0; i < arguments.length; i++) {
    var version = arguments[i]
    if (!version) continue
    if (!best || compareVersions(version, best) > 0) {
      best = version
    }
  }
  return best
}

/**
 * Resolve daemon, bundled library, and CLI PM2 versions.
 * @param {Object} options
 * @param {Function} fn
 */
pm.getVersionInfo = function (options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }
  options = options || {}

  var libraryVersion = readPackageVersion('pm2')

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err)
    }

    pm2.getVersion(function (verErr, daemonVersion) {
      if (verErr) {
        return fn(verErr)
      }

      execFile('pm2', ['-v'], {
        timeout: 5000,
        env: process.env
      }, function (cliErr, stdout) {
        var cliVersion = cliErr ? null : String(stdout || '').trim()
        var displayVersion = maxVersion(daemonVersion, libraryVersion, cliVersion)

        fn(null, {
          version: displayVersion || daemonVersion || libraryVersion || cliVersion || '0.0.0',
          daemon: daemonVersion || null,
          library: libraryVersion,
          cli: cliVersion,
          updateRecommended: !!(daemonVersion && displayVersion && compareVersions(daemonVersion, displayVersion) < 0)
        })
      })
    })
  })
}

pm.version = function (options, fn) {
  if (_.isString(options) || _.isFunction(options)) {
    fn = options
    options = {}
  }
  if (_.isFunction(fn) && !options) {
    var tmp = fn
    fn = tmp
    options = {}
  }

  pm.getVersionInfo(options, function (err, info) {
    if (err) {
      return fn(err)
    }
    fn(null, info.version)
  })
}

/**
 * List available processes.
 * @param {Object} options
 * @param {Function} fn
 */
pm.list = function (options, fn) {
  if (_.isFunction(options)) {
    fn = options
    options = {}
  }
  options = options || {}

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err, [])
    }
    pm2.list(function (err, procs) {
      fn(err, procs || [])
    })
  })
}

/**
 * Trigger actions on process by pm_id.
 * @param {Object} options
 * @param {Function} fn
 */
pm.action = function (options, fn) {
  options = options || {}
  if (options.pm2 && !options.pm2Home) {
    options.pm2Home = options.pm2
  }
  var action = options.action

  if (options.id === 'all') {
    return pm.list(options, function (err, procs) {
      if (err) {
        return fn(err)
      }
      if (!procs || procs.length === 0) {
        // Nothing to act on — still force UI refresh for delete.
        if (action === 'delete') {
          return fn(null, true)
        }
        return fn(new Error('No PM2 process is running!'))
      }

      if (action === 'save') {
        return pm2.dump(fn)
      }

      async.map(procs, function (proc, next) {
        pm._actionByPMId({
          process: proc,
          action: action
        }, next.bind(null, null))
      }, fn)
    })
  }

  // Pass action so _findById can treat missing targets as success on delete.
  pm._findById(_.extend({}, options, { action: action }), function (err, proc) {
    if (err) {
      return fn(err)
    }
    // Already gone — treat delete as success and force UI refresh.
    if (!proc && action === 'delete') {
      return fn(null, true)
    }
    if (!proc) {
      return fn(new Error('Cannot find pm process by pm_id: ' + options.id))
    }
    pm._actionByPMId({
      process: proc,
      action: action
    }, fn)
  })
}

/**
 * Find process by pm_id.
 * @private
 */
pm._findById = function (options, fn) {
  pm.list(options, function (err, procs) {
    if (err) {
      return fn(err)
    }

    var id = parseInt(options.id, 10)
    var proc = _.find(procs || [], function (p) {
      return p && p.pm_id === id
    })

    if (!proc) {
      // Process already gone (stale UI cache, or daemon was restarted empty).
      if (options.action === 'delete') {
        return fn(null, null)
      }
      if (!procs || procs.length === 0) {
        return fn(new Error('No PM2 process running. Make sure PM2 is running (`pm2 ls`).'))
      }
      return fn(new Error('Cannot find pm process by pm_id: ' + options.id))
    }

    fn(null, proc)
  })
}

/**
 * Execute action on a single process.
 * @private
 */
pm._actionByPMId = function (options, fn) {
  options = options || {}
  if (!options.process) {
    return fn(new Error('Process is required'))
  }
  var pmId = options.process.pm_id
  var action = options.action
  var noBusEvent = action === 'delete' &&
    !(options.process.pm2_env && options.process.pm2_env.status === 'online')

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err)
    }

    console.debug('[pm:' + pmId + ']', action)

    if (action === 'start') {
      var status = options.process.pm2_env && options.process.pm2_env.status
      if (status === 'online') {
        return fn(new Error('Process is already running'))
      }
      action = 'restart'
    }

    if (action === 'save') {
      return pm2.dump(function (err) {
        fn(err, noBusEvent)
      })
    }

    var handler = pm2[action]
    if (!handler) {
      return fn(new Error('Unsupported action: ' + action))
    }

    handler.call(pm2, pmId, function (err) {
      fn(err, noBusEvent)
    })
  })
}

/**
 * Start a saved project folder with PM2.
 * @param {Object} options
 * @param {Object} options.project saved project descriptor
 * @param {Function} fn
 */
pm.startProject = function (options, fn) {
  options = options || {}
  var project = options.project
  if (!project || !project.path) {
    return fn(new Error('Project path is required'))
  }

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err)
    }

    if (project.type === 'ecosystem' && project.configFile) {
      return pm2.start(project.configFile, function (err, proc) {
        fn(err, proc)
      })
    }

    var script = project.script || 'index.js'
    pm2.start({
      script: script,
      cwd: project.path,
      name: project.name
    }, function (err, proc) {
      fn(err, proc)
    })
  })
}
