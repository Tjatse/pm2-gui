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

Monitor.ACCEPT_KEYS = ['pm2', 'daemonize', 'readonly', 'max_restarts', 'port', 'log', 'agent', 'remotes', 'origins'].concat(msKeys)
Monitor.DEF_CONF_FILE = 'pm2-gui.ini'
Monitor.PM2_DAEMON_PROPS = ['DAEMON_RPC_PORT', 'DAEMON_PUB_PORT']

/**
 * Run socket.io server.
 */
Monitor.prototype.run = function () {
  this._observePM2()
  this._listeningSocketIO()
}

/**
 * Quit monitor.
 * @return {[type]} [description]
 */
Monitor.prototype.quit = function () {
  // close pm2 subscriber if necessary.
  if (this._cache.pm2Subscriber) {
    console.debug('Closing pm2 pub emitter socket.')
    this._cache.pm2Subscriber.close()
    this._cache.pm2Subscriber = null
  }

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
  // converts various time formats to milliseconds
  msKeys.forEach(function (timeKey) {
    var time
    if (_.isString(time = options[timeKey])) {
      options[timeKey] = ms(time)
    }
  })
  options.pm2 = this._resolveHome(options.pm2)
  // init logger.
  Log(options.log)

  // load PM2 config.
  var pm2ConfPath = path.join(options.pm2, 'conf.js')
  var fbMsg = ''
  try {
    options.pm2Conf = require(pm2ConfPath)(options.pm2)
    if (!options.pm2Conf) {
      throw new Error(404)
    }
  } catch (err) {
    fbMsg = 'Can not load PM2 config, the file "' + pm2ConfPath + '" does not exist or empty, fallback to auto-load by pm2 home. '
    console.warn(fbMsg)
    options.pm2Conf = {
      DAEMON_RPC_PORT: path.resolve(options.pm2, 'rpc.sock'),
      DAEMON_PUB_PORT: path.resolve(options.pm2, 'pub.sock')
    }
  }

  Monitor.PM2_DAEMON_PROPS.forEach(function (prop) {
    var val = options.pm2Conf[prop]
    if (!val || !fs.existsSync(val)) {
      throw new Error(fbMsg + 'Unfortunately ' + (val || prop) + ' can not found, please makesure that your pm2 is running and the home path is correct.')
    }
  })

  // Bind socket.io server to context.
  if (options.sockio) {
    this._cache.sockio = options.sockio
    delete options.sockio
  }
  // Bind to context.
  this.options = options
  Object.freeze(this.options)

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
    self._cache.noClient = self._cache.sockio.of(conf.NSP.SYS).sockets.length === 0
  }

  function actions (action, id) {
    var prefix = '[pm2:' + id + ']'
    console.debug(prefix, action, 'sending to pm2 daemon...')
    if (self.options.readonly) {
      console.warn(prefix, 'denied, readonly!!!')
      return socket.emit(conf.SOCKET_EVENTS.DATA_ACTION, {
        id: id,
        error: 'Fatal to execute the <' + action + '> operation due to denied by server, it is readonly!'
      })
    }
    pm.action({
      socketPath: self.options.pm2Conf.DAEMON_RPC_PORT,
      action: action,
      id: id
    }, function (err, forceRefresh) {
      if (err) {
        console.error(action, err.message)
        return socket.emit(conf.SOCKET_EVENTS.DATA_ACTION, {
          id: id,
          error: 'Fatal to execute the <' + action + '> operation due to ' + err.message
        })
      }
      console.debug(prefix, action, 'completed(' + (forceRefresh ? 'force refresh' : 'holding') + ')')
      forceRefresh && self._throttleRefresh()
    })
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
    console.info('[pm2:' + pmId + ']', 'subscribing...')
    socket._pm_id = pmId
    socket._ansi = !!keepANSI

    if (self._cache.logSubscribers[pmId]) {
      console.warn('[pm2:' + pmId + ']', 'subscribed!!!')
      return
    }
    self._cache.logSubscribers[pmId] = socket
    self._logSubscriberChanged()
    socket.emit(conf.SOCKET_EVENTS.DATA, {
      id: pmId,
      text: '[' + (new Date()).toLocaleString() + '] waiting for logs...'
    })
    console.info('[pm2:' + pmId + ']', 'subscribed!!!')
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
    self._cache.processes && socket.emit(conf.SOCKET_EVENTS.DATA_PROCESSES, self._cache.processes, conf.NSP.PROCESS)
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
      pidusage.stat(pid, function (err, stat) {
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
    var socks = self._cache.sockio.of(conf.NSP.PROCESS).sockets
    var canNotBeDeleted = {}

    // delete usage observer in a safe & heavy way.
    if (Array.isArray(socks) && socks.length > 0) {
      socks.forEach(function (sock) {
        if (sock._pid) {
          canNotBeDeleted[sock._pid.toString()] = 1
        }
      })
    }

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
  var pm2Daemon = this.options.pm2Conf.DAEMON_PUB_PORT
  console.info('Connecting to pm2 daemon:', pm2Daemon)

  this._cache.pm2Subscriber = pm.sub({
    socketPath: pm2Daemon,
    context: this
  }, function (data) {
    this._cache.awake = true
    console.info(chalk.magenta(data.event), data.process.name + '-' + data.process.pm_id)
    this._throttleRefresh()
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
  pm.list({
    socketPath: this.options.pm2Conf.DAEMON_RPC_PORT,
    context: this
  }, function (err, procs) {
    if (err) {
      err = new Error('Fatal to connect to pm2 daemon due to ' + err.message)
      return this._emitError(err, {
        namespace: conf.NSP.PROCESS
      })
    }
    // Wrap processes and cache them.
    this._cache.processes = procs.map(function (proc) {
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
      return proc
    })
    // Emit to client.
    this._broadcast(conf.SOCKET_EVENTS.DATA_PROCESSES, this._cache.processes, conf.NSP.PROCESS)
  })
}

/**
 * Get PM2 version and return it to client.
 * @private
 */
Monitor.prototype._pm2Ver = function (socket) {
  var pm2RPC = this.options.pm2Conf.DAEMON_RPC_PORT
  console.info('Fetching pm2 version:', pm2RPC)
  pm.version(pm2RPC, function (err, version) {
    socket.emit(conf.SOCKET_EVENTS.DATA_PM2_VERSION, (err || !version) ? '0.0.0' : version, conf.NSP.SYS)
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
  if (this._cache.noClient) {
    return console.debug('No client is connecting, ignore broadcasting', event, 'to', nsp)
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
  var socks = self._cache.sockio.of(conf.NSP.LOG).sockets
  var canNotBeDeleted = {}
  if (socks && socks.length > 0) {
    socks.forEach(function (sock) {
      canNotBeDeleted[String(sock._pm_id)] = 1
    })
  }

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
    self._cache.pm2Subscriber.on('log:*', function (e, d) {
      var pmId = d.process.pm_id
      if (!self._cache.awake) {
        self._cache.awake = true
        console.info(chalk.magenta('awake:1st'), d.process.name + '-' + pmId)
        self._throttleRefresh()
        if (_.keys(self._cache.logSubscribers).length === 0) {
          self._cache.pm2SubscriberIsLogging = false
          self._cache.pm2Subscriber.off('log:*')
          console.info('[pm2:log]', chalk.red('deactivate'), '\'cause no subscriber')
        }
      } else if ((sock = self._cache.logSubscribers[pmId])) {
        var text = d.data
        if (text) {
          console.info('[pm2:' + pmId + '] sent log')
          text = text.replace(/[\r\n\t]+$/, '')
          sock.emit(conf.SOCKET_EVENTS.DATA, {
            id: pmId,
            text: '[' + e + ']' + (sock._ansi ? text : ansiHTML(text))
          })
        }
      }
    })
    console.info('[pm2:log]', chalk.green('Activate'))
  } else if (this._cache.pm2SubscriberIsLogging) {
    this._cache.pm2SubscriberIsLogging = false
    this._cache.pm2Subscriber.off('log:*')
    console.info('[pm2:log]', chalk.red('deactivate'))
  } else {
    console.warn('[pm2:log]', 'deactivated')
  }
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
