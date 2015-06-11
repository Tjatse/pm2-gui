var blessed      = require('blessed'),
    chalk        = require('chalk'),
    widgets      = require('./widgets'),
    conf         = require('../util/conf'),
    async        = require('async'),
    _            = require('lodash'),
    stats        = require('../stat'),
    io           = require('socket.io-client');

module.exports = Layout;

var prefix = chalk.white.bgBlack('monitor'),
    exiting = false;
/**
 * Create layout.
 * @param {Object} options
 */
function Layout(options){
  if (!(this instanceof Layout)) {
    return new Layout(options);
  }
  this.options = options;
  this._eles = {};
  this._procCount = 0;
};

/**
 * Render GUI.
 * @return {[type]} [description]
 */
Layout.prototype.render = function(){
  var self = this,
      jobs = {};

  // Preparing all socket.io clients.
  Object.keys(conf.NSP).forEach(function(ns){
    jobs[ns.toLowerCase()] = function(next){
      console.log(prefix, (new Array(5 - ns.length).join(' ')) + chalk.bgGreen.white(ns), 'connecting');
      self._connectSocketIO(conf.NSP[ns], function(err, socket){
        if (err) {
          console.log(prefix, chalk.bgRed.white('ERR!'), err.message);
        } else {
          console.log(prefix, (new Array(5 - ns.length).join(' ')) + chalk.bgGreen.white(ns), 'connected');
        }
        next(err, socket);
      });
    }
  });
  async.parallel(jobs, function(err, res){
    if (err) {
      console.log(prefix, chalk.bgRed.white('ERR!'), err.message);
      return process.exit(8);
    }
    self.sockets = res;
    console.log(prefix, 'All channels are online, now rendering GUI...');
    self._draw();
    self._observe();

    setInterval(function(){
      self._bindProcesses();
    }, 1000);
  });
}

/**
 * Observe socket.io channels.
 * @return {[type]} [description]
 */
Layout.prototype._observe = function(){
  var self = this;
  this.sockets.sys.on('procs', function(procs){
    self._procs = {data: procs, tick: Date.now()};
    (typeof self._procs == 'undefined') && self._bindProcesses();
  });

  this.sockets.proc.on('proc', function(proc){
    if (!self._usages || proc.pid != self._usages.pid || self._usages.time == proc.time) {
      return;
    }
    self._usages.time = proc.time;
    self._usages.cpu.shift();
    self._usages.cpu.push(Math.min(100, Math.max(proc.usage.cpu, 1)));
    self._usages.mem.shift();
    self._usages.mem.push(Math.min(100, Math.max(proc.usage.memory, 1)));
  });

  this.sockets.log.on('log', function(log){
    if(!self._eles.logs || self._lastLogPMId != log.pm_id){
      return;
    }
    self._eles.logs.log(log.msg);
  });
};

/**
 * Bind processes to table.
 * @return {[type]} [description]
 */
Layout.prototype._bindProcesses = function(){
  if (exiting || !this._eles.processes || !this._procs) {
    return;
  }
  if (this._procs.tick == this._procsLastTick) {
    // Update tick only.
    return setRows.call(this, true);
  }

  if (typeof this._procsLastTick == 'undefined') {
    this._describeInfo(0);
    this._eles.processes.rows.on('select', onSelect.bind(this));
  }

  this._procsLastTick = this._procs.tick;

  setRows.call(this, true);

  function setRows(forceRefresh){
    var rows = [],
        selectedIndex = this._eles.processes.rows.selected,
        len = this._procs.data.length;

    this._procs.data.forEach(function(p, i) {
      var pm2 = p.pm2_env,
          index = '[' + i + '/' + len + ']';
      rows.push([
        ' ' + chalk.grey((index + Array(8 - index.length).join(' '))) + ' ' + p.name,
        pm2.restart_time,
        pm2.status != 'online' ? '0s' : _fromNow(Math.ceil((Date.now() - pm2.pm_uptime) / 1000), true),
        pm2.status == 'online' ? chalk.green('✔') : chalk.red('✘')
      ]);
    });
    this._eles.processes.setData({
      headers: [' Name', 'Restarts', 'Uptime', ''],
      rows: rows
    });

    selectedIndex = typeof selectedIndex != 'undefined' ? selectedIndex : 0;
    var maxIndex = this._eles.processes.rows.items.length - 1;
    if (selectedIndex > maxIndex) {
      selectedIndex = maxIndex;
    }
    this._eles.processes.rows.select(selectedIndex);

    if (forceRefresh) {
      onSelect.call(this);
    }
  }

  function onSelect(item, selectedIndex) {
    if (!!item) {
      var lastIndex = this._lastSelectedIndex;

      this._lastSelectedIndex = selectedIndex;
      if (selectedIndex != lastIndex) {
        this._describeInfo(selectedIndex);
      }
    }
    this._cpuAndMemUsage(this._lastSelectedIndex || 0);
    this._displayLogs(this._lastSelectedIndex || 0);
    this.screen.render();
  }
};

/**
 * Get description of a specified process.
 * @param  {Number} index the selected row index.
 * @return {[type]}       [description]
 */
Layout.prototype._describeInfo = function(index){
  var jsonData = this._procs.data[index];
  if (jsonData.pm2_env && jsonData.pm2_env.env) {
    // Remove useless large-bytes attributes.
    delete jsonData.pm2_env.env['LS_COLORS'];
  }
  delete jsonData.monit;
  this._eles.json.setContent(_formatJSON(jsonData));
};

/**
 * CPU and Memory usage of a specific process
 * @param  {Number} index the selected row index.
 * @return {[type]}       [description]
 */
Layout.prototype._cpuAndMemUsage = function(index){
  var pm2 = this._procs.data[index];
  if (!this._usages) {
    this._usages = {mem: [], cpu: []};
    var len = this._eles.cpu.width - 4;
    for (var i = 0; i < len; i++) {
      this._usages.cpu.push(1);
      this._usages.mem.push(1);
    }
  }
  if (pm2.pid != 0 && this._procCount == 2) {
    this._procCount = -1;
    this.sockets.proc.emit('proc', pm2.pid);
  }
  this._procCount++;
  this._usages.pid = pm2.pid;

  this._eles.cpu.setData(this._usages.cpu, 0, 100);
  this._eles.cpu.setLabel('CPU Usage (' + (this._usages.cpu[this._usages.cpu.length - 1]).toFixed(2) + '%)');

  this._eles.mem.setData(this._usages.mem, 0, 100);
  this._eles.mem.setLabel('Memory Usage (' + (this._usages.mem[this._usages.mem.length - 1]).toFixed(2) + '%)');
};

/**
 * Display logs.
 * @param  {Number} index [description]
 * @return {[type]}       [description]
 */
Layout.prototype._displayLogs = function(index){
  var pm2 = this._procs.data[index];
  if(this._lastLogPMId == pm2.pm_id){
    return;
  }
  this._killLogs();
  this.sockets.log.emit('tail', this._lastLogPMId = pm2.pm_id, true);
};

/**
 * Kill `tail` process
 * @return {[type]}         [description]
 */
Layout.prototype._killLogs = function(){
  if (typeof this._lastLogPMId == 'undefined') {
    return;
  }
  this.sockets.log.emit('tail_kill', this._lastLogPMId);
};

/**
 * Draw elements.
 * @return {[type]} [description]
 */
Layout.prototype._draw = function(){
  var self = this;
  var screen = blessed.Screen();
  screen.title = 'PM2 Monitor';

  var grid = _grid(screen);

  // Processes.
  this._eles.processes = grid.get(0, 0);
  this._bindProcesses();

  this._eles.cpu = grid.get(1, 0);
  this._eles.mem = grid.get(1, 1);

  // Logs.
  this._eles.logs = grid.get(2, 0);

  // Detail.
  this._eles.json = grid.get(0, 2);
  var offset = Math.round(this._eles.json.height * 100 / this._eles.json.getScrollHeight()),
      dir;
  // Key bindings
  screen.key('s', function(ch, key){
    if(exiting){
      return;
    }
    var perc = Math.min((dir != 'down' ? offset : 0) + self._eles.json.getScrollPerc() + 5, 100);
    dir = 'down';
    self._eles.json.setScrollPerc(perc)
  });
  screen.key('w', function(ch, key){
    if(exiting){
      return;
    }
    var perc = Math.max(self._eles.json.getScrollPerc() - 5 - (dir != 'up' ? offset : 0), 0);
    dir = 'up';
    self._eles.json.setScrollPerc(perc)
  });

  screen.key(['escape', 'q', 'C-c'], function(ch, key){
    if(exiting){
      return;
    }
    exiting = true;
    screen.title = 'PM2 Monitor (Exiting...)';
    this._killLogs();
    setTimeout(function() {
      process.exit(0);
    }, 2000)
  }.bind(this));

  screen.render();
  this.screen = screen;
};

/**
 * Connect to socket.io server.
 * @param  {String}   ns       the namespace.
 * @param  {Function} callback 
 * @return {[type]}            [description]
 */
Layout.prototype._connectSocketIO = function(ns, callback){
  var socket = io('http://127.0.0.1:' + this.options.port + ns);
  socket.on('connect', function(){
    callback(null, socket);
  });
};

/**
 * Grid of screen elements.
 * @param {blessed.Screen} screen
 * @returns {*}
 * @private
 */
function _grid(screen){
  var style = {
    fg    : '#013409',
    label : {
      bold: true,
      fg  : '#00500d'
    },
    border: {
      fg: '#5e9166'
    }
  };
  // Layout.
  var grid = widgets.Grid({
    rows   : 3,
    cols   : 3,
    margin : 0,
    widths : [25, 25, 50],
    heights: [35, 10, 55]
  });
  // Table of processes
  grid.set({
    row    : 0,
    col    : 0,
    colSpan: 2,
    element: widgets.Table,
    options: {
      keys  : true,
      border: {
        type: 'line'
      },
      style : style,
      label : 'Processes (↑/↓ to move up/down, enter to select)',
      widths: [35, 15, 20, 15]
    }
  });
  // Sparkline of CPU
  grid.set({
    row    : 1,
    col    : 0,
    element: widgets.Sparkline,
    options: {
      border: {
        type: 'line'
      },
      style : {
        fg    : '#bc6f0a',
        label : {
          bold: true,
          fg  : '#00500d'
        },
        border: {
          fg: '#5e9166'
        }
      },
      label : 'CPU Usage(%)'
    }
  });

  // Sparkline of Memory
  grid.set({
    row    : 1,
    col    : 1,
    element: widgets.Sparkline,
    options: {
      border: {
        type: 'line'
      },
      style : {
        fg    : '#6a00bb',
        label : {
          bold: true,
          fg  : '#00500d'
        },
        border: {
          fg: '#5e9166'
        }
      },
      label : 'Memory Usage(%)'
    }
  });

  // Logs
  grid.set({
    row    : 2,
    col    : 0,
    colSpan: 2,
    element: widgets.Log,
    options: {
      border: {
        type: 'line'
      },
      style : style,
      label : 'Logs'
    }
  });

  // JSON data.
  grid.set({
    row    : 0,
    col    : 2,
    rowSpan: 3,
    element: blessed.ScrollableBox,
    options: {
      label : 'Describe Info (w/s to move up/down)',
      border: {
        type: 'line'
      },
      style : style,
      keys  : true
    }
  });
  grid.draw(screen);

  return grid;
}

/**
 * Pretty json data.
 * @param {Object} data
 * @returns {XML|*|string|void}
 * @private
 */
function _formatJSON(data){
  data = JSON.stringify(typeof data != 'string' ? data : JSON.parse(data), null, 2);

  return data.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function(m){
    var color = 'blue';
    if (/^"/.test(m)) {
      color = ['magenta', 'green'][/:$/.test(m) ? 0 : 1];
    } else if (/true|false/.test(m)) {
      color = 'blue';
    } else if (/null|undefined/.test(m)) {
      color = 'blue';
    }
    return chalk[color](m);
  });
}

/**
 * Wrap tick from now.
 * @param {Float} tick
 * @param {Boolean} tiny show all of it.
 * @returns {string}
 */
function _fromNow(tick, tiny){
  if (tick < 60) {
    return tick + 's';
  }
  var s = tick % 60 + 's';
  if (tick < 3600) {
    return parseInt(tick / 60) + 'm ' + s;
  }
  var m = parseInt((tick % 3600) / 60) + 'm ';
  if (tick < 86400) {
    return parseInt(tick / 3600) + 'h ' + m + (!tiny ? '' : s);
  }
  var h = parseInt((tick % 86400) / 3600) + 'h ';
  return parseInt(tick / 86400) + 'd ' + h + (!tiny ? '' : m + s);
}

/**
 * Wrap memory.
 * @param {Float} mem
 * @returns {string}
 */
function _getMem(mem){
  if (typeof mem == 'string') {
    return mem;
  }

  if (mem < 1024) {
    return mem + 'B';
  }
  if (mem < 1048576) {
    return Math.round(mem / 1024) + 'K';
  }
  if (mem < 1073741824) {
    return Math.round(mem / 1048576) + 'M';
  }
  return Math.round(mem / 1073741824) + 'G';
}