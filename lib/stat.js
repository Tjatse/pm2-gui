var usage     = require('usage'),
    os        = require('os'),
    exec      = require('child_process').exec,
    winCPU    = require('windows-cpu'),
    isWindows = process.platform == 'win32';

/**
 * System states
 * @type {{hostname: *, platform: *, arch: *, release: *, cpus, uptime, memory}}
 */
var stat = module.exports = {
  /**
   * Hostname, e.g.: localhost, TjatseMacProBook.local...
   */
  hostname: os.hostname(),
  /**
   * Platform, e.g.: darwin, win32, linux...
   */
  platform: os.platform(),
  /**
   * Architecture, e.g.: 64, 32...
   */
  arch    : os.arch(),
  /**
   * Ver number of system.
   */
  release : os.release(),
  /**
   * List all CPUs.
   * @returns {*}
   */
  get cpus(){
    return os.cpus();
  },
  /**
   * Uptime.
   * @returns {*}
   */
  get uptime(){
    return os.uptime();
  },
  /**
   * System memory usage.
   * @returns {{free: *, total: *, percentage: number}}
   */
  get memory(){
    return {
      free      : os.freemem(),
      total     : os.totalmem(),
      percentage: Math.round(100 * (1 - os.freemem() / os.totalmem()))
    }
  }
};

/**
 * System CPU usage percentage (total).
 * @param fn
 */
stat.cpuUsage = function(fn){
  if (isWindows) {
    winCPU.totalLoad(function(err, results){
      fn(err, results.reduce(function(p1, p2){
        return (p1 + (p2 || p1)) / 2;
      }).toFixed(2));
    })
  } else {
    setTimeout(function(ctx, stat1){
      var stat2 = ctx.cpuInfo(),
          perc = 100 * (1 - (stat2.idle - stat1.idle) / (stat2.total - stat1.total));
      fn(null, perc.toFixed(2));
    }, 1000, this, this.cpuInfo());
  }
};

/**
 * System CPU usage detail information.
 * @param fn
 * @returns {{idle: number, total: number}}
 */
stat.cpuInfo = function(fn){
  var cpus = this.cpus, idle = 0, total = 0;
  for (var i in cpus) {
    idle += cpus[i].times.idle;
    for (var k in cpus[i].times) {
      total += cpus[i].times[k];
    }
  }
  return {
    'idle' : idle,
    'total': total
  };
};

/**
 * Get memory usage by process id.
 * @param {String} pid
 * @param {Function} cb
 */
stat.memoryUsage = function(pid, cb){
  if (isWindows) {
    exec('TaskList /fi "PID eq ' + pid + '" /fo CSV', function(err, stdout, stderr){
      if (err) {
        return cb(err);
      }
      var lines = stdout.split('\n');
      if (lines != 2) {
        return cb(null, '0');
      }
      var data = lines[1].split(',');
      cb(data.length == 0 ? '0' : data[data.length - 1].replace(/[\'\",\s]/g, ''));
    })
  } else {
    usage.lookup(pid, function(err, result){
      if (err) {
        return cb(err);
      }
      return cb(null, result.memory);
    });
  }
};