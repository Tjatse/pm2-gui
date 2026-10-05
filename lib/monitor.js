'use strict'

var ms = require('ms')
var fs = require('fs')
var path = require('path')
var _ = require('lodash')
var chalk = require('chalk')
var ansiHTML = require('ansi-html')
var totalmem = require('os').totalmem()
var pidusage = require('pidusage')
var url = require('url')
var socketIOClient = require('socket.io-client')

var pm = require('./pm')
var appVersion = require('./app-version')
var projectsStore = require('./projects-store')
var settings = require('./settings')
var telegram = require('./telegram')
var db = require('./db')
var stat = require('./stat')
var conf = require('./util/conf')
var Log = require('./util/log')

var defConf
var ignoredErrorKeys = ['namespace', 'keepANSI']
var msKeys = ['refresh', 'process_refresh']
var allowedSysStatsKeys = ['cpus', 'arch', 'hostname', 'platform', 'release', 'uptime', 'memory']

module.exports = Monitor

/**
 * Monitor of project monitor web.
 * @param options
 * @returns {Monitor}
 * @constructor
 */
function Monitor (options) {
  if (!(this instanceof Monitor)) {
    return new Monitor(options)
  }

  // Initialize...
  this._init(options)
}

Monitor.ACCEPT_KEYS = ['pm2', 'daemonize', 'readonly', 'max_restarts', 'port', 'log', 'agent', 'remotes', 'origins', 'web'].concat(msKeys)
Monitor.DEF_CONF_FILE = 'pm2-gui.ini'
Monitor.PM2_DAEMON_PROPS = ['DAEMON_RPC_PORT', 'DAEMON_PUB_PORT']

/**
 * Run socket.io server.
 */
Monitor.prototype.run = function () {
  this._observePM2()
  if (!this._cache.sockio || !this._cache.sockio._listening) {
    this._listeningSocketIO()
  }
}

/**
 * Hot-reload settings from the local SQLite database.
 */
Monitor.prototype.reloadSettings = function () {
  try {
    settings.applyToOptions(this.options)
    var msKeysLocal = ['refresh', 'process_refresh']
    msKeysLocal.forEach(function (timeKey) {
      var time = this.options[timeKey]
      if (_.isString(time)) {
        this.options[timeKey] = ms(time)
      }
    }, this)
  } catch (err) {
    console.warn('[settings] reload failed:', err.message)
  }
}

/**
 * Quit monitor.
 * @return {[type]} [description]
 */
Monitor.prototype.quit = function () {
  // close pm2 subscriber if necessary.
  if (this._cache.pm2Subscriber) {
    console.debug('Closing pm2 event bus.')
    this._deactivateLogListener()
    this._cache.pm2Subscriber.close()
    this._cache.pm2Subscriber = null
  }
  pm.disconnect()

  // close log subscriber if necessary.
  this._closeLogSubscribers()

  // close pm2 sockio if necessary.
  if (this._cache.sockio) {
    console.debug('Closing socket.io server.')
    this._cache.sockio.close()
    this._cache.sockio = null
  }
}

/**
 * Connect to socket.io server.
 * @param  {Object} options.
 * @param  {Function} fn
 */
Monitor.prototype.connect = function (options, fn) {
  if (!options.port) {
    throw new Error('Port is required!')
  }
  var serverUri = Monitor.toConnectionString(options)
  console.info('Connecting to', serverUri)

  fn = _.once(fn)

  var socket = socketIOClient(serverUri)
  socket.on(conf.SOCKET_EVENTS.CONNECT, function () {
    fn(null, socket)
  })

  socket.on(conf.SOCKET_EVENTS.ERROR, function (err) {
    fn(err, socket)
  })

  socket.on(conf.SOCKET_EVENTS.CONNECT_ERROR, function (err) {
    fn(err, socket)
  })
}

/**
 * List all available monitors.
 * @param  {Object} options
 * @return {Object}
 */
Monitor.available = function (options) {
  options.agent = options.agent || {}
  var remotable = options.remotes && _.keys(options.remotes).length > 0

  if (options.agent.offline && !remotable) {
    return null
  }

  options.port = options.port || 8088

  var q = {
    name: 'socket_server',
    message: 'Which socket server would you wanna connect to',
    type: 'list',
    choices: []
  }
  var wrapLocal = function () {
    return {
      value: (options.agent && options.agent.authorization ? options.agent.authorization + '@' : '') + '127.0.0.1:' + options.port,
      short: 'localhost'
    }
  }
  if (!remotable) {
    q.choices = [wrapLocal()]
    return q
  }
  var maxShortLength = 0
  for (var remote in options.remotes) {
    var connectionString = options.remotes[remote]
    q.choices.push({
      value: connectionString,
      short: remote
    })
    maxShortLength = Math.max(maxShortLength, remote.length)
  }
  if (!options.agent.offline) {
    var conn = wrapLocal()
    q.choices.push(conn)
    maxShortLength = Math.max(maxShortLength, conn.short.length)
  }

  if (q.choices.length > 1) {
    q.choices.forEach(function (c) {
      c.name = '[' + c.short + Array(maxShortLength - c.short.length + 1).join(options.blank || ' ') + '] '
    })
  }

  return q
}

/**
 * Convert connection object to string.
 * @param  {Object} connection
 * @return {String}
 */
Monitor.toConnectionString = function (connection) {
  var uri = (connection.protocol || 'http:') + '//' + (connection.hostname || '127.0.0.1') + ':' + connection.port +
    (connection.path || '') + (connection.namespace || '')

  if (connection.authorization) {
    uri += (uri.indexOf('?') > 0 ? '&' : '?') + 'auth=' + connection.authorization
  }
  return uri
}

/**
 * Parse connection string to an uri object.
 * @param  {String} connectionString
 * @return {Object}
 */
Monitor.parseConnectionString = function (connectionString) {
  var connection = {
    port: 8088,
    hostname: '127.0.0.1',
    authorization: ''
  }
  var lastAt = connectionString.lastIndexOf('@')
  if (lastAt >= 0) {
    connection.authorization = connectionString.slice(0, lastAt)
    connectionString = connectionString.slice(lastAt + 1)
  }
  if (!/^https?:\/\//i.test(connectionString)) {
    connectionString = 'http://' + connectionString
  }

  if (connectionString) {
    connectionString = url.parse(connectionString)
    connection.hostname = connectionString.hostname
    connection.port = !isNaN(connectionString.port) ? parseFloat(connectionString.port) : connectionString.port
    connection.path = (connectionString.path || '').replace(/^\/+/, '')
    connection.protocol = connectionString.protocol
  }
  return connection
}

Object.defineProperty(Monitor.prototype, 'sockio', {
  set: function (io) {
    if (this._cache.sockio) {
      this._cache.sockio.close()
    }
    this._cache.sockio = io
    this._listeningSocketIO()
  },
  get: function () {
    return this._cache.sockio
  }
})

/**
 * Resolve home path of PM2.
 * @param {String} pm2Home
 * @returns {*}
 * @private
 */
Monitor.prototype._resolveHome = function (pm2Home) {
  if (pm2Home && pm2Home.indexOf('~/') === 0) {
    // Get root directory of PM2.
    pm2Home = process.env.PM2_HOME || path.resolve(process.env.HOME || process.env.HOMEPATH, pm2Home.substr(2))

    // Make sure exist.
    if (!pm2Home || !fs.existsSync(pm2Home)) {
      throw new Error('PM2 root can not be located, try to initialize PM2 by executing `pm2 ls` or set environment variable vi `export PM2_HOME=[ROOT]`.')
    }
  }
  return pm2Home
}

/**
 * Initialize options and configurations.
 * @param  {Object} options
 * @return {N/A}
 */
Monitor.prototype._init = function (options) {
  // mixing options & default settings.
  options = options || {}

  defConf = conf.File(options.confFile || path.resolve(__dirname, '..', Monitor.DEF_CONF_FILE)).loadSync().valueOf()
  defConf = _.pick.call(null, defConf, Monitor.ACCEPT_KEYS)

  options = _.pick.apply(options, Monitor.ACCEPT_KEYS).valueOf()
  options = _.defaults(options, defConf)
  // Merge user settings from local SQLite DB (overrides ini for portable settings).
  try {
    db.open()
    settings.applyToOptions(options)
  } catch (err) {
    console.warn('[settings] Could not load DB settings:', err.message)
  }
  // converts various time formats to milliseconds
  msKeys.forEach(function (timeKey) {
    var time
    if (_.isString(time = options[timeKey])) {
      options[timeKey] = ms(time)
    }
  })
  options.pm2 = this._resolveHome(options.pm2)
  options.pm2Home = options.pm2
  // init logger.
  Log(options.log)

  // Verify PM2 socket files exist (daemon may not be running yet).
  var rpcSock = path.resolve(options.pm2, 'rpc.sock')
  var pubSock = path.resolve(options.pm2, 'pub.sock')
  if (!fs.existsSync(rpcSock) || !fs.existsSync(pubSock)) {
    console.warn('PM2 daemon sockets not found at ' + options.pm2 + '. Start PM2 with `pm2 ls` first.')
  }

  // Bind socket.io server to context.
  if (options.sockio) {
    this._cache.sockio = options.sockio
    delete options.sockio
  }
  // Bind to context.
  this.options = options
  // Do not freeze — settings can be hot-reloaded from the DB.
  this._cache = {
    noClient: true,
    usages: {},
    logSubscribers: {},
    pm2Subscriber: null,
    sockio: null,
    processes: null,
    sysStat: null,
    throttle: null,
    awake: false
  }
}

/**
 * Emit error to clients.
 * @param  {Error} err
 * @param  {Object} options
 * @return {N/A}
 */
Monitor.prototype._emitError = function (err, options) {
  var data = _.extend({
    error: options.keepANSI ? chalk.red(err.message) : '<span style="color: #ff0000">Error: ' + err.message + '</span>'
  }, _.omit(options, ignoredErrorKeys))
  this._broadcast(conf.SOCKET_EVENTS.ERROR, data, conf.NSP[options.namespace])
}

/**
 * Connection event of `sys` namespace.
 * @param {Socket} socket
 * @private
 */
Monitor.prototype._connectSysSocket = function (socket) {
  var self = this

  self._cache.noClient = false
  console.info('Connected to ' + socket.nsp.name + '!')

  socket.on(conf.SOCKET_EVENTS.DISCONNECT, disconnect)
  socket.on(conf.SOCKET_EVENTS.PULL_ACTION, actions)

  // pm2 version
  self._pm2Ver(socket)
  // prefetch system status
  this._cache.sysStat && this._broadcast(conf.SOCKET_EVENTS.DATA_SYSTEM_STATS, this._cache.sysStat, conf.NSP.SYS)

  // Grep system states once and again.
  if (this._status !== 'R') {
    this._nextTick(this.options.refresh || 5000)
  }

  function disconnect () {
    // Check connecting client.
    self._cache.noClient = self._getSocketCount(conf.NSP.SYS) === 0
  }

  function actions (action, id) {
    var prefix = '[pm2:' + id + ']'
    console.debug(prefix, action, 'sending to pm2 daemon...')
    if (self.options.readonly) {
      console.warn(prefix, 'denied, readonly!!!')
      return socket.emit(conf.SOCKET_EVENTS.DATA_ACTION, {
        id: id,
        action: action,
        error: 'Fatal to execute the <' + action + '> operation due to denied by server, it is readonly!'
      })
    }

    function finishAction (err, forceRefresh) {
      if (err) {
        console.error(action, err.message)
        return socket.emit(conf.SOCKET_EVENTS.DATA_ACTION, {
          id: id,
          action: action,
          error: 'Fatal to execute the <' + action + '> operation due to ' + err.message
        })
      }
      console.debug(prefix, action, 'completed(' + (forceRefresh ? 'force refresh' : 'holding') + ')')
      socket.emit(conf.SOCKET_EVENTS.DATA_ACTION, {
        id: id,
        action: action,
        success: true
      })
      forceRefresh && self._throttleRefresh()
    }

    if (action === 'delete') {
      return pm.list({ pm2Home: self.options.pm2Home }, function (err, procs) {
        if (err) {
          return finishAction(err)
        }

        // Prefer live list; fall back to stale UI cache so we can still unlink saved projects.
        var source = (procs && procs.length) ? procs : (self._cache.processes || [])
        var pathsToRemove = []
        if (id === 'all') {
          pathsToRemove = source.map(function (proc) {
            return proc.pm2_env && proc.pm2_env.pm_cwd
          }).filter(Boolean)
        } else {
          var proc = _.find(source, function (p) {
            return p && p.pm_id === parseInt(id, 10)
          })
          if (proc && proc.pm2_env && proc.pm2_env.pm_cwd) {
            pathsToRemove.push(proc.pm2_env.pm_cwd)
          }
        }

        pm.action({
          pm2Home: self.options.pm2Home,
          action: action,
          id: id
        }, function (actionErr, forceRefresh) {
          if (!actionErr && pathsToRemove.length) {
            try {
              projectsStore.removeProjectsByPaths(pathsToRemove)
            } catch (storeErr) {
              console.warn('[projects] Could not remove saved project(s):', storeErr.message)
            }
          }
          // Always refresh after delete so a stale row cannot stick in the UI.
          finishAction(actionErr, true)
        })
      })
    }

    pm.action({
      pm2Home: self.options.pm2Home,
      action: action,
      id: id
    }, finishAction)
  }
}

/**
 * Connection event of `log` namespace.
 * @param {socket.io} socket
 * @private
 */
Monitor.prototype._connectLogSocket = function (socket) {
  var self = this

  socket.on(conf.SOCKET_EVENTS.DISCONNECT, self._closeLogSubscribers.bind(self))
  socket.on(conf.SOCKET_EVENTS.PULL_LOGS_END, self._closeLogSubscribers.bind(self))
  socket.on(conf.SOCKET_EVENTS.PULL_LOGS, subscribeLog)
  console.info('Connected to ' + socket.nsp.name + '!')

  function subscribeLog (pmId, keepANSI) {
    var idKey = String(pmId)
    console.info('[pm2:' + idKey + ']', 'subscribing...')
    socket._pm_id = idKey
    socket._ansi = !!keepANSI

    if (self._cache.logSubscribers[idKey]) {
      console.warn('[pm2:' + idKey + ']', 'subscribed!!!')
      // Still refresh history so reopening Logs shows recent error output.
      self._emitRecentLogs(idKey, socket)
      return
    }
    self._cache.logSubscribers[idKey] = socket
    self._logSubscriberChanged()
    socket.emit(conf.SOCKET_EVENTS.DATA, {
      id: idKey,
      text: '[' + (new Date()).toLocaleString() + '] waiting for logs...'
    })
    self._emitRecentLogs(idKey, socket)
    console.info('[pm2:' + idKey + ']', 'subscribed!!!')
  }
}

/**
 * Connection event of `proc` namespace.
 * @param {socket.io} socket
 * @private
 */
Monitor.prototype._connectProcessSocket = function (socket) {
  var self = this

  socket.on(conf.SOCKET_EVENTS.DISCONNECT, stopMonitorUsage)
  socket.on(conf.SOCKET_EVENTS.PULL_USAGE, monitorUsage)
  socket.on(conf.SOCKET_EVENTS.PULL_PROCESSES, sendProcs)
  console.info('Connected to ' + socket.nsp.name + '!')

  // send prefetch processes to client.
  sendProcs()

  function sendProcs () {
    // Always re-fetch from the daemon so the UI cannot stick on a stale cache
    // (e.g. after `pm2 delete` / daemon restart while the dashboard stayed open).
    self._refreshProcs()
  }

  function monitorUsage (pid) {
    socket._pid = pid

    var pidStr = String(pid)
    if (self._cache.usages[pidStr]) {
      console.debug('[pid:' + pidStr + ']', 'observed!!!')
      return
    }

    console.debug('[pid:' + pidStr + ']', 'cpu and memory observer is running...')

    function runTimer () {
      pidusage(pid, function (err, stat) {
        if (err) {
          clearInterval(self._cache.usages[pidStr])
          delete self._cache.usages[pidStr]
          return self._emitError(err, {
            id: pid,
            namespace: conf.NSP.PROCESS
          })
        }
        stat.memory = stat.memory * 100 / totalmem

        var data = {
          pid: pid,
          time: Date.now(),
          usage: stat
        }
        self._broadcast.call(self, conf.SOCKET_EVENTS.DATA_USAGE, data, conf.NSP.PROCESS) // eslint-disable-line no-useless-call
      })
    }

    self._cache.usages[pidStr] = setInterval(runTimer, self.options.process_refresh)
    runTimer()
  }

  function stopMonitorUsage () {
    var socks = self._getNamespaceSockets(conf.NSP.PROCESS)
    var canNotBeDeleted = {}

    // delete usage observer in a safe & heavy way.
    socks.forEach(function (sock) {
      if (sock._pid) {
        canNotBeDeleted[sock._pid.toString()] = 1
      }
    })

    for (var pid in self._cache.usages) {
      var timer
      if (!canNotBeDeleted[pid] && (timer = self._cache.usages[pid])) {
        clearInterval(timer)
        delete self._cache.usages[pid]
        console.debug('[pid:' + pid + ']', 'cpu and memory observer has been destroyed!')
      }
    }
  }
}

/**
 * Grep system state loop
 * @param {Number} tick
 * @private
 */
Monitor.prototype._nextTick = function (tick, continuously) {
  // Return it if worker is running.
  if (this._status === 'R' && !continuously) {
    return
  }
  // Running
  this._status = 'R'
  console.debug('monitor heartbeat per', tick + 'ms')
  // Grep system state
  this._systemStat(function () {
    // If there still has any client, grep again after `tick` ms.
    if (!this._cache.noClient) {
      return setTimeout(function (that) {
        that._nextTick(tick, true)
      }, tick, this)
    }
    // Stop
    delete this._status
    console.debug('monitor heartbeat destroyed!')
  })
}

/**
 * Grep system states.
 * @param {Function} fn
 * @private
 */
Monitor.prototype._systemStat = function (fn) {
  stat.cpuUsage(function (err, cpuUsage) {
    if (err) {
      // Log only.
      console.error('Can not load system/cpu/memory informations: ', err.message)
    } else {
      // System states.
      this._cache.sysStat = _.defaults(_(stat).pick(allowedSysStatsKeys).clone(), {
        cpu: cpuUsage
      })
      this._broadcast(conf.SOCKET_EVENTS.DATA_SYSTEM_STATS, this._cache.sysStat, conf.NSP.SYS)
    }
    fn.call(this)
  }, this)
}

/**
 * Observe PM2
 * @private
 */
Monitor.prototype._observePM2 = function () {
  var self = this
  console.info('Connecting to pm2 daemon:', self.options.pm2Home)

  self._cache.pm2Subscriber = pm.sub({
    pm2Home: self.options.pm2Home,
    context: self
  }, function (data) {
    self._cache.awake = true
    console.info(chalk.magenta(data.event), data.process.name + '-' + data.process.pm_id)
    try {
      telegram.notifyProcessEvent(data.event, data.process)
    } catch (err) {
      console.warn('[telegram] notify failed:', err.message)
    }
    self._throttleRefresh()
  })
  // awake from log
  this._logSubscriberChanged()
  // Enforce a refresh operation if RPC is not online.
  this._throttleRefresh()
}

/**
 * Throttle the refresh behavior to avoid refresh bomb
 * @private
 */
Monitor.prototype._throttleRefresh = function () {
  if (this._cache.throttle) {
    clearTimeout(this._cache.throttle)
  }
  this._cache.throttle = setTimeout(function (that) {
    that._cache.throttle = null
    that._refreshProcs()
  }, 500, this)
}

/**
 * Refresh processes
 * @private
 */
Monitor.prototype._refreshProcs = function () {
  var self = this
  pm.list({
    pm2Home: self.options.pm2Home
  }, function (err, procs) {
    if (err) {
      err = new Error('Fatal to connect to pm2 daemon due to ' + err.message)
      return self._emitError(err, {
        namespace: conf.NSP.PROCESS
      })
    }
    // Wrap processes and cache them.
    self._cache.processes = procs.map(function (proc) {
      proc.pm2_env = proc.pm2_env || {
        USER: 'UNKNOWN'
      }
      var pm2Env = {
        user: proc.pm2_env.USER
      }

      for (var key in proc.pm2_env) {
        // Ignore useless fields.
        if (/^(_|axm_)+/.test(key) || /versioning|command/i.test(key) || key.charCodeAt(0) <= 90) {
          continue
        }
        pm2Env[key] = proc.pm2_env[key]
      }
      proc.pm2_env = pm2Env
      var cwd = pm2Env.pm_cwd || (proc.pm2_env && proc.pm2_env.pm_cwd)
      proc.appVersion = appVersion.readAppVersion(cwd)
      return proc
    })
    // Emit to client.
    self._broadcast(conf.SOCKET_EVENTS.DATA_PROCESSES, self._cache.processes, conf.NSP.PROCESS)
  })
}

/**
 * Get PM2 version and return it to client.
 * @private
 */
Monitor.prototype._pm2Ver = function (socket) {
  console.info('Fetching pm2 version from', this.options.pm2Home)
  pm.getVersionInfo({
    pm2Home: this.options.pm2Home
  }, function (err, info) {
    if (err || !info) {
      return socket.emit(conf.SOCKET_EVENTS.DATA_PM2_VERSION, '0.0.0', conf.NSP.SYS)
    }
    if (info.updateRecommended) {
      console.warn(
        'PM2 daemon is outdated (daemon v' + info.daemon + ', local v' + info.version + '). Run: pm2 update'
      )
    }
    socket.emit(conf.SOCKET_EVENTS.DATA_PM2_VERSION, info, conf.NSP.SYS)
  })
}

/**
 * Broadcast to all connected clients.
 * @param {String} event
 * @param {Object} data
 * @param {String} nsp
 * @private
 */
Monitor.prototype._broadcast = function (event, data, nsp) {
  if (this._getSocketCount(nsp) === 0) {
    return console.debug('No client on', nsp, '- ignore broadcasting', event)
  }

  console.debug('Broadcasting', event, 'to', nsp)
  this._cache.sockio.of(nsp).emit(event, data)
}

/**
 * Destroy tails.
 * @param  {Number} pm_id
 * @return {[type]}
 */
Monitor.prototype._closeLogSubscribers = function (pmId) {
  var self = this
  // close as specific log subscriber
  if (!isNaN(pmId)) {
    self._logSubscriberChanged()
    return unsubscribe(String(pmId))
  }
  if (_.keys(self._cache.logSubscribers).length === 0) {
    return
  }

  // unbsusbribe all in a safe & heavy way.
  var socks = self._getNamespaceSockets(conf.NSP.LOG)
  var canNotBeDeleted = {}
  socks.forEach(function (sock) {
    canNotBeDeleted[String(sock._pm_id)] = 1
  })

  var changed = false
  for (var subId in self._cache.logSubscribers) {
    subId = String(subId)
    if (!canNotBeDeleted[subId]) {
      changed = true
      unsubscribe(subId)
    }
  }
  if (changed) {
    self._logSubscriberChanged()
  }

  function unsubscribe (id) {
    console.info('[pm2:' + id + ']', 'unsubscribed!!!')
    delete self._cache.logSubscribers[id]
  }
}

/**
 * Toggle listening on log:* events
 * @return {N/A}
 */
Monitor.prototype._emitRecentLogs = function (pmId, socket) {
  var self = this
  var idKey = String(pmId)
  var proc = (self._cache.processes || []).find(function (p) {
    return p && String(p.pm_id) === idKey
  })
  if (!proc || !proc.pm2_env) {
    socket.emit(conf.SOCKET_EVENTS.DATA, {
      id: idKey,
      text: '[info] No cached process metadata yet — waiting for live logs...'
    })
    return
  }

  var env = proc.pm2_env
  var paths = [
    { label: 'err', file: env.pm_err_log_path },
    { label: 'out', file: env.pm_out_log_path }
  ]
  var sent = 0

  paths.forEach(function (entry) {
    if (!entry.file || !fs.existsSync(entry.file)) {
      return
    }
    try {
      var lines = readLastLines(entry.file, 80)
      if (!lines.length) return
      socket.emit(conf.SOCKET_EVENTS.DATA, {
        id: idKey,
        text: '[info] --- last ' + lines.length + ' line(s) from ' + entry.label + ' log ---'
      })
      lines.forEach(function (line) {
        if (!line) return
        socket.emit(conf.SOCKET_EVENTS.DATA, {
          id: idKey,
          text: '[' + entry.label + '] ' + (socket._ansi ? line : ansiHTML(line))
        })
        sent += 1
      })
    } catch (err) {
      socket.emit(conf.SOCKET_EVENTS.DATA, {
        id: idKey,
        text: '[info] Could not read ' + entry.label + ' log: ' + err.message
      })
    }
  })

  if (!sent) {
    socket.emit(conf.SOCKET_EVENTS.DATA, {
      id: idKey,
      text: '[info] No historical log lines found (status: ' + (env.status || 'unknown') + '). Waiting for live output...'
    })
  }
}

function readLastLines (filePath, maxLines) {
  maxLines = Math.max(1, Math.min(500, parseInt(maxLines, 10) || 80))
  var text = fs.readFileSync(filePath, 'utf8')
  if (!text) return []
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.slice(-maxLines)
}

/**
 * Toggle listening on log:* events
 * @return {N/A}
 */
Monitor.prototype._logSubscriberChanged = function () {
  if (!this._cache.pm2Subscriber) {
    console.warn('PM2 subscriber does not exist')
    return
  }
  if (!this._cache.awake || _.keys(this._cache.logSubscribers).length > 0) {
    var self = this
    var sock
    if (self._cache.pm2SubscriberIsLogging) {
      console.warn('[pm2:log] activated')
      return
    }
    self._cache.pm2SubscriberIsLogging = true

    function onLog (eventName, d) {
      if (!d || !d.process) {
        return
      }
      var pmId = String(d.process.pm_id)
      if (!self._cache.awake) {
        self._cache.awake = true
        console.info(chalk.magenta('awake:1st'), d.process.name + '-' + pmId)
        self._throttleRefresh()
        if (_.keys(self._cache.logSubscribers).length === 0) {
          self._deactivateLogListener()
        }
      } else if ((sock = self._cache.logSubscribers[pmId])) {
        var text = d.data
        if (text) {
          console.info('[pm2:' + pmId + '] sent log')
          text = text.replace(/[\r\n\t]+$/, '')
          sock.emit(conf.SOCKET_EVENTS.DATA, {
            id: pmId,
            text: '[' + eventName + '] ' + (sock._ansi ? text : ansiHTML(text))
          })
        }
      }
    }

    self._cache._logOutHandler = onLog.bind(null, 'out')
    self._cache._logErrHandler = onLog.bind(null, 'err')
    self._cache.pm2Subscriber.on('log:out', self._cache._logOutHandler)
    self._cache.pm2Subscriber.on('log:err', self._cache._logErrHandler)
    console.info('[pm2:log]', chalk.green('Activate'))
  } else if (this._cache.pm2SubscriberIsLogging) {
    this._deactivateLogListener()
  } else {
    console.warn('[pm2:log]', 'deactivated')
  }
}

Monitor.prototype._deactivateLogListener = function () {
  if (!this._cache.pm2SubscriberIsLogging) {
    return
  }
  this._cache.pm2SubscriberIsLogging = false
  if (this._cache._logOutHandler) {
    this._cache.pm2Subscriber.off('log:out', this._cache._logOutHandler)
    this._cache._logOutHandler = null
  }
  if (this._cache._logErrHandler) {
    this._cache.pm2Subscriber.off('log:err', this._cache._logErrHandler)
    this._cache._logErrHandler = null
  }
  console.info('[pm2:log]', chalk.red('deactivate'))
}

/**
 * Get connected socket count for a namespace (Socket.IO v4 compatible).
 * @private
 */
Monitor.prototype._getSocketCount = function (nsp) {
  if (!this._cache.sockio) {
    return 0
  }
  var sockets = this._cache.sockio.of(nsp).sockets
  return sockets instanceof Map ? sockets.size : (sockets ? sockets.length : 0)
}

/**
 * Get connected sockets as array (Socket.IO v4 compatible).
 * @private
 */
Monitor.prototype._getNamespaceSockets = function (nsp) {
  if (!this._cache.sockio) {
    return []
  }
  var sockets = this._cache.sockio.of(nsp).sockets
  if (sockets instanceof Map) {
    return Array.from(sockets.values())
  }
  return sockets || []
}

/**
 * Listening all the nsp.
 */
Monitor.prototype._listeningSocketIO = function () {
  if (!this._cache.sockio || this._cache.sockio._listening) {
    console.warn('Avoid duplicated listening!')
    return
  }

  this._cache.sockio._listening = true
  for (var nsp in conf.NSP) {
    var fnName = '_connect' + (nsp[0] + nsp.slice(1).toLowerCase()) + 'Socket'
    console.info('Listening connection event on', nsp.toLowerCase(), 'by func:' + fnName)
    this._cache.sockio.of(conf.NSP[nsp]).on(conf.SOCKET_EVENTS.CONNECTION, this[fnName].bind(this))
  }

  var auth
  var authService = null
  try {
    authService = require('./auth-service')
  } catch (err) {}

  if (authService && authService.getAuthConfig().enabled) {
    console.debug('* socket.io session auth *')
    this._cache.sockio.use(function (socket, next) {
      var sess = socket.request && socket.request.session
      if (sess && (sess.userId || sess.authorization)) {
        return next()
      }
      return next(new Error('unauthorized'))
    })
    return
  }

  if (!(this.options.agent && (auth = this.options.agent.authorization))) {
    console.debug('* No passwd *')
    return
  }
  console.debug('* socket.io handshake *')
  this._cache.sockio.use(function (socket, next) {
    if (auth !== socket.handshake.query.auth) {
      return next(new Error('unauthorized'))
    }
    next()
  })
}
