var fs       = require('fs'),
    path     = require('path'),
    nconf    = require('nconf'),
    Debug    = require('./util/debug'),
    stat     = require('./stat'),
    _        = require('lodash'),
    chalk    = require('chalk'),
    ansiHTML = require('ansi-html'),
    //chokidar = require('chokidar'),
    pm       = require('./pm');

module.exports = Monitor;

/**
 * Monitor of project monitor web.
 * @param options
 * @returns {Monitor}
 * @constructor
 */
function Monitor(options){
  if (!(this instanceof Monitor)) {
    return new Monitor(options);
  }

  // Initialize...
  this._init(options);
};

/**
 * Initialize options and configurations.
 * @private
 */
Monitor.prototype._init = function(options){
  options = options || {};
  // bind default options.
  _.defaults(options, {
    refresh     : 5000,
    manipulation: true
  });

  // Get root directory of PM2.
  var pm2Root = process.env.PM2_HOME || p.resolve(process.env.HOME || process.env.HOMEPATH, '.pm2');

  // Make sure exist.
  if (!pm2Root || !fs.existsSync(pm2Root)) {
    throw new Error('PM2 root can not be located, try to set env by `export PM2_HOME=[ROOT]`.');
  }

  // Load PM2 config.
  var pm2ConfPath = path.join(pm2Root, 'conf.js');
  try {
    options.pm2Conf = require(pm2ConfPath)(pm2Root);
    if (!options.pm2Conf) {
      throw new Error(404);
    }
  } catch (err) {
    throw new Error('Can not load PM2 config, the file "' + pm2ConfPath + '" does not exist.');
  }

  options.pm2Root = pm2Root;

  // Bind socket.io server to context.
  if (options.sockio) {
    this._sockio = options.sockio;
    delete options.sockio;
  }

  // Bind to context.
  this.options = options;
  Object.freeze(this.options);

  // Initialize configurations.
  this._config = new nconf.File({file: path.resolve(this.options.pm2Root, 'pm2-gui.json')});

  // Set configurations.
  this.config('pm2', this._config.get('pm2') || this.options.pm2Root);
  this.config('refresh', this._config.get('refresh') || this.options.refresh);
  this.config('manipulation', this._config.get('manipulation') || this.options.manipulation || true);

  // Logger.
  this._log = Debug({
    namespace: 'monitor',
    debug    : !!this.options.debug
  });
};

/**
 * Operations of configuration.
 * @example:
 *    set config    : mon.config('key', 'value');
 *    clear config  : mon.config('key', null);
 *    get config    : mon.config('key');
 * @param {String} key
 * @param {Mixed} value
 * @returns {*}
 */
Monitor.prototype.config = function(key, value){
  if (!key) {
    return;
  }
  // Load config from File.
  this._config.loadSync();

  if (typeof value == 'undefined') {
    // Get config.
    return this._config.get(key);
  } else if (value == null) {
    // Clear config.
    this._config.clear(key);
    // Reset to default if necessary.
    if (key == 'refresh') {
      value = 5000;
    } else if (key == 'manipulation') {
      value = true;
    }
    value && this._config.set(key, value);
    return this._config.saveSync();
  }

  // Make sure value in a correct type.
  if (typeof value != 'boolean') {
    if (!isNaN(value)) {
      value = parseFloat(value);
    } else if (/^(true|false)$/.test(value)) {
      value = (value == 'true');
    }
  }
  this._config.set(key, value);
  // Save it.
  this._config.saveSync();
};

/**
 * Run socket.io server.
 */
Monitor.prototype.run = function(){
  if (!this._sockio) {
    return;
  }
  this._noClient = true;

  this._beats = {};

  // Watching PM2
  this._startWatching();

  // Listen connection event.
  this._sockio.on('connection', this._connectSock.bind(this));
}

/**
 * Connection event.
 * @param {Socket} socket
 * @private
 */
Monitor.prototype._connectSock = function(socket){
  // Still has one client connects to server at least.
  this._noClient = false;

  socket.on('disconnect', function(){
    // Check connecting client.
    this._noClient = _.size(this._sockio.sockets.connected) <= 0;
  }.bind(this));

  // Tail logs
  socket.on('tail_beat', this._tailLogs.bind(this, socket));
  socket.on('tail_destroy', this._checkTailBeat.bind(this, socket.id))

  // Trigger actions of process.
  socket.on('action', function(action, id){
    this._log.i('action', chalk.magenta(action), 'received', id);
    pm.action(this.options.pm2Conf.DAEMON_RPC_PORT, action, id, function(err, forceRefresh){
      if (err) {
        this._log.e(action, err.message);
        return socket.emit('action', id, err.message);
      }
      this._log.i('action', chalk.magenta(action), 'finished', id);
      forceRefresh && this._throttleRefresh();
    }.bind(this));
  }.bind(this));

  // Get PM2 version and return it to client.
  this._pm2Ver(socket);

  // If processes have been fetched, emit the last to current client.
  this._procs && socket.emit(typeof this._procs == 'string' ? 'info' : 'procs', this._procs);
  // If sysStat have been fetched, emit the last to current client.
  this._sysStat && this._broadcast('system_stat', this._sysStat);

  // Grep system states once and again.
  (this._status != 'R') && this._nextTick(this.config('refresh') || 5000);
}

/**
 * Show logs by pm_id.
 * @param {socket.io} socket
 * @param {String} pm_id
 * @private
 */
Monitor.prototype._tailLogs = function(socket, pm_id){
  var beat;
  if ((beat = this._beats[pm_id])) {
    (!beat.sockets[socket.id]) && (beat.sockets[socket.id] = socket);
    beat.tick = Date.now();
    this._beats[pm_id] = beat;
    return;
  }

  this._log.i('tail', pm_id);

  this._beats[pm_id] = {
    tick   : Date.now(),
    sockets: {}
  };
  this._beats[pm_id].sockets[socket.id] = socket;

  function broadcast(data){
    var beat = this._beats[pm_id];
    if (!beat) {
      this._log.e('beat does not exist.');
      return;
    }
    for (var key in beat.sockets) {
      beat.sockets[key].emit('tail', data)
    }
  }

  function emitError(err){
    broadcast.call(this, {
      pm_id: pm_id,
      msg  : '<span style="color: #ff0000">Error: ' + err.message + '</span>'
    });
  }

  pm.tail({
    sockPath: this.options.pm2Conf.DAEMON_RPC_PORT,
    logPath : this.options.pm2Conf.PM2_LOG_FILE_PATH,
    pm_id   : pm_id
  }, function(err, lines){
    if (err) {
      return emitError.call(this, err);
    }
    // Emit tail to clients.
    broadcast.call(this, {
      pm_id: pm_id,
      msg  : lines.map(function(line){
        line = line.replace(/\s/, '&nbsp;');
        return '<span>' + ansiHTML(line) + '</span>';
      }).join('')
    });
  }.bind(this), function(err, tails){
    if (err) {
      return emitError.call(this, err);
    }

    this._log.d(chalk.magenta('tail'), 'tailing...');
    this._beats[pm_id].tails = tails;
    this._checkTailBeat();
  }.bind(this));
};

/**
 * Check beats.
 * @returns {number}
 * @private
 */
Monitor.prototype._checkTailBeat = function(socketId, uid){
  this._beatTimer && clearTimeout(this._beatTimer);

  function destroyTail(beat, key){
    beat.tails && beat.tails.forEach(function(tail){
      tail.kill('SIGTERM');
    });
    this._log.d(chalk.magenta('tail'), chalk.red('destroy'), key);
    delete this._beats[key];
  }

  if (socketId && uid) {
    this._log.i('tail', chalk.red('destroy'), uid, socketId);
    var beat = this._beats[uid];
    if (beat && beat.sockets) {
      delete beat.sockets[socketId];
    }
    if (Object.keys(beat.sockets).length == 0) {
      destroyTail.call(this, beat, uid);
    }
  } else {
    for (var key in this._beats) {
      var beat = this._beats[key];
      // Kill timeout beats.
      if (Date.now() - beat.tick > 4000) {
        destroyTail.call(this, beat, key);
      }
    }
  }

  // Loop
  if (Object.keys(this._beats).length > 0) {
    this._log.d(chalk.magenta('tail'), 4000);
    this._beatTimer = setTimeout(this._checkTailBeat.bind(this), 4000);
  }
};

/**
 * Grep system state loop
 * @param {Number} tick
 * @private
 */
Monitor.prototype._nextTick = function(tick, continuously){
  // Return it if worker is running.
  if (this._status == 'R' && !continuously) {
    return;
  }
  // Running
  this._status = 'R';
  this._log.d(chalk.magenta('monitor'), tick);
  // Grep system state
  this._systemStat(function(){
    // If there still has any client, grep again after `tick` ms.
    if (!this._noClient) {
      return setTimeout(this._nextTick.bind(this, tick, true), tick);
    }
    // Stop
    delete this._status;
    this._log.d(chalk.magenta('monitor'), chalk.red('destroy'));
  }.bind(this));
}

/**
 * Grep system states.
 * @param {Function} cb
 * @private
 */
Monitor.prototype._systemStat = function(cb){
  stat.cpuUsage(function(err, cpu_usage){
    if (err) {
      // Log only.
      this._log.e('sockio', 'Can not load system/cpu/memory information: ' + err.message);
    } else {
      // System states.
      this._sysStat = _.defaults(_(stat).pick('cpus', 'arch', 'hostname', 'platform', 'release', 'uptime', 'memory').clone(), {
        cpu: cpu_usage
      });
      this._broadcast('system_stat', this._sysStat);
    }
    cb();
  }.bind(this));
}

/**
 * Watching PM2
 * @private
 */
Monitor.prototype._startWatching = function(){
  // Watching sub-emitter.
  pm.sub(this.options.pm2Conf.DAEMON_PUB_PORT, function(data){
    this._log.i('sub-emitter', chalk.magenta(data.event), data.process.name + '-' + data.process.pm_id);
    this._throttleRefresh();
  }.bind(this));

  // Enforce a refresh operation if RPC is not online.
  this._throttleRefresh();
};

/**
 * Throttle the refresh behavior to avoid refresh bomb
 * @private
 */
Monitor.prototype._throttleRefresh = function(){
  if (this._throttle) {
    clearTimeout(this._throttle);
  }
  this._throttle = setTimeout(function(ctx){
    ctx._throttle = null;
    ctx._refreshProcs();
  }, 500, this);
};
/**
 * Refresh processes
 * @private
 */
Monitor.prototype._refreshProcs = function(){
  pm.list(this.options.pm2Conf.DAEMON_RPC_PORT, function(err, procs){
    if (err) {
      return this._broadcast('info', 'Error: ' + err.message);
    }
    // Wrap processes and cache them.
    this._procs = procs.map(function(proc){
      proc.pm2_env = proc.pm2_env || {USER: 'UNKNOWN'};
      var pm2_env = {user: proc.pm2_env.USER};

      for (var key in proc.pm2_env) {
        // Ignore useless fields.
        if (key.slice(0, 1) == '_' ||
          key.indexOf('axm_') == 0 || !!~['versioning', 'command'].indexOf(key) ||
          key.charCodeAt(0) <= 90) {
          continue;
        }
        pm2_env[key] = proc.pm2_env[key];
      }
      proc.pm2_env = pm2_env;
      return proc;
    });
    // Emit to client.
    this._broadcast('procs', this._procs);
  }.bind(this))
};

/**
 * Get PM2 version and return it to client.
 * @private
 */
Monitor.prototype._pm2Ver = function(socket){
  pm.version(this.options.pm2Conf.DAEMON_RPC_PORT, function(err, version){
    socket.emit('pm2_ver', (err || !version) ? '0.0.0' : version);
  });
};

/**
 * Broadcast to all connected clients.
 * @param event
 * @param data
 * @private
 */
Monitor.prototype._broadcast = function(event, data){
  this._sockio.sockets.emit(event, data);
};