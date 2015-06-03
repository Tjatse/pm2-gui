var spawn = require('child_process').spawn,
    fs    = require('fs'),
    path  = require('path'),
    _     = require('lodash'),
    async = require('async'),
    chalk = require('chalk'),
    stat  = require('./stat'),
    rpc   = require('pm2-axon-rpc'),
    axon  = require('pm2-axon');

/**
 * Forever lib.
 * @type {{}}
 */
var pm = module.exports = {};

var re_blank      = /^[\s\r\t]*$/,
    allowedEvents = ['start', 'restart', 'exit', 'online'];

/**
 * Subscribe event BUS.
 * @param {String} sockPath
 * @param {Function} cb
 */
pm.sub = function(sockPath, cb){
  var sub = axon.socket('sub-emitter');
  sub.connect(sockPath);

  // Once awake from sleeping.
  sub.on('log:*', function(e, d){
    // Do not subscribe it.
    sub.off('log:*');
    d.event = 'awake';
    cb(d);
  });

  // Process events.
  sub.on('process:*', function(e, d){
    if (d && !!~allowedEvents.indexOf(d.event)) {
      cb(d);
    }
  });
};

/**
 * Get PM2 version.
 * @param {String} sockPath
 * @param {Function} cb
 */
pm.version = function(sockPath, cb){
  pm._rpc({
    sockPath: sockPath,
    events  : [
      ['getVersion', {}, cb]
    ]
  });
};

/**
 * List available processes.
 * @param {String} sockPath
 * @param {Function} cb
 */
pm.list = function(sockPath, cb){
  if (!fs.existsSync(sockPath)) {
    return cb(null, []);
  }
  pm._rpc({
    sockPath: sockPath,
    events  : [
      ['getMonitorData', {}, cb]
    ]
  });
};

/**
 * Execute remote RPC events.
 * @param {Object} opts including:
 *  {String} sockPath
 *  {Object} args
 *  {Object} events
 *    key: event name
 *    value: callback function
 * @private
 */
pm._rpc = function(opts){
  var req = axon.socket("req"),
      rpc_sock = req.connect(opts.sockPath),
      rpc_client = new rpc.Client(req);

  // Connect RPC server.
  rpc_sock.on('connect', function(){
    // Execute request.
    var waterfalls = opts.events.map(function(event){
      return function(next){
        var cb = typeof event[event.length - 1] == 'function' ? event.pop() : null;
        if (cb) {
          event.push(function(){
            // Wrap arguments, no [].slice (avoid leak)!!!
            var args = new Array(arguments.length);
            for (var i = 0; i < args; i++) {
              args[i] = arguments[i];
            }
            cb.apply(null, arguments);
            next();
          });
        }
        rpc_client.call.apply(rpc_client, event);
        if (!cb) {
          next();
        }
      };
    });
    async.waterfall(waterfalls, function(err, res){
      rpc_sock.close();
    });
  });
};

/**
 * Find process by pm_id.
 * @param {String} sockPath
 * @param {String} id
 * @param {Function} cb
 * @private
 */
pm._findById = function(sockPath, id, cb){
  pm.list(sockPath, function(err, procs){
    if (err) {
      return cb(err);
    }
    if (!procs || procs.length == 0) {
      return cb(new Error('No PM2 process running, the sockPath is "' + sockPath + '", please make sure it is existing!'));
    }

    var proc = _.find(procs, function(p){
      return p && p.pm_id == id;
    });

    if (!proc) {
      return cb(new Error('Cannot find pm process by pm_id: ' + id));
    }

    cb(null, proc);
  }, true);
}

/**
 * Trigger actions of process by pm_id.
 * @param {String} sockPath
 * @param {String} id
 * @param {Function} cb
 */
pm.action = function(sockPath, action, id, cb){
  if (id == 'all') {
    pm.list(sockPath, function(err, procs){
      if (err) {
        return cb(err);
      }
      if (!procs || procs.length == 0) {
        return cb(new Error('No PM2 process running, the sockPath is "' + sockPath + '", please make sure it is existing!'));
      }

      async.map(procs, function(proc, next){
        pm._actionByPMId(sockPath, proc, action, next.bind(null, null));
      }, cb);
    });
  } else {
    pm._findById(sockPath, id, function(err, proc){
      if (err) {
        return cb(err);
      }
      pm._actionByPMId(sockPath, proc, action, cb);
    });
  }
};

/**
 * Trigger actions of process by pm_id.
 * @param {String} sockPath
 * @param {Object} proc
 * @param {String} action
 * @param {Function} cb
 * @private
 */
pm._actionByPMId = function(sockPath, proc, action, cb){
  var noBusEvent = action == 'delete' && proc.pm2_env.status != 'online',
      pm_id = proc.pm_id;

  action += 'ProcessId';
  var watchEvent = ['stopWatch', action, {id: pm_id}, function(err, success){
  }];

  if (!!~['restart'].indexOf(action)) {
    watchEvent.splice(0, 1, 'restartWatch');
    watchEvent.pop();
  }

  var actionEvent = [action, pm_id, function(err, sock){
    cb(err, noBusEvent);
  }];

  if (action == 'restartProcessId') {
    actionEvent.splice(1, 1, {id: pm_id});
  }

  pm._rpc({
    sockPath: sockPath,
    events  : [
      watchEvent,
      actionEvent
    ]
  });
};

/**
 * Tail logs.
 * @param {Object} opts
 * @param {Function} each Iterator
 * @param {Function} cb
 * @returns {*}
 */
pm.tail = function(opts, each, cb){
  // Fetch the proccess that we need.
  pm._findById(opts.sockPath, opts.pm_id, function(err, proc){
    if (err) {
      return cb(err);
    }
    proc.pm2_log = opts.logPath;
    // Tail logs.
    var tails = pm._tailLogs(proc, each);
    cb(null, tails);
  });
};
/**
 * Use linux `tail` command to grep logs.
 * @param {Object} proc
 * @param {Function} cb
 * @returns {*}
 * @private
 */
pm._tailLogs = function(proc, cb){
  var logs = [['PM2', proc.pm2_log]];
  if (proc.pm_log_path) {
    logs.push(['entire', proc.pm2_env.pm_log_path]);
  } else {
    var paths = [];
    if (proc.pm2_env.pm_out_log_path) {
      paths.push(['out', proc.pm2_env.pm_out_log_path]);
    }
    if (proc.pm2_env.pm_err_log_path) {
      paths.push(['err', proc.pm2_env.pm_err_log_path]);
    }

    paths = paths.sort(function(a, b) {
      return (fs.existsSync(a[1]) ? fs.statSync(a[1]).mtime.valueOf() : 0) -
        (fs.existsSync(b[1]) ? fs.statSync(b[1]).mtime.valueOf() : 0);
    });
    logs = logs.concat(paths);
  }

  var tails = [];
  (function tailLog(ls){
    var log = ls.shift();
    if (!log) {
      return;
    }
    var logPath = log[1];
    if (!fs.existsSync(logPath)) {
      return;
    }
    var key = log[0],
        prefix = chalk[key == 'err' ? 'red' : 'green'].bold('[' + key + ']');

    var tail = spawn('tail', ['-f', '-n', 10, logPath], {
      killSignal: 'SIGTERM',
      stdio     : [null, 'pipe', 'pipe']
    });

    // Use utf8 encoding.
    tail.stdio.forEach(function(stdio){
      stdio.setEncoding('utf8');
    });

    // stdout.
    tail.stdout.on('data', function(data){
      var lines = [], _lines = data.split(/\n/);
      _lines.forEach(function(line){
        if (!re_blank.test(line)) {
          lines.push(prefix + ' ' + line);
        }
      });
      if (lines.length > 0) {
        cb(null, lines);
      }
    });

    // handle error.
    tail.stderr.on('data', function(data){
      tail.disconnect();
      cb(new Error(data.toString().replace(/\n/, '')));
    });
    tails.push(tail);
    tailLog(ls);
  })(logs);
  return tails;
};