var blessed = require('blessed')
var chalk = require('chalk')
var async = require('async')
var _ = require('lodash')
var widgets = require('./widgets')
var conf = require('../util/conf')
var Log = require('../util/log')

module.exports = Layout

var exiting = false
/**
 * Create layout.
 * @param {Object} options
 */
function Layout (options) {
  if (!(this instanceof Layout)) {
    return new Layout(options)
  }
  options = _.clone(options || {})
  if (!options.hostname) {
    options.hostname = '127.0.0.1'
  }
  if (!options.port) {
    throw new Error('Port of socket.io server is required!')
  }
  options.sockets = options.sockets || {}
  this.options = options
  this._eles = {}
  this._procCount = 0
}

/**
 * Render GUI.
 */
Layout.prototype.render = function (monitor) {
  var self = this
  var options = this.options

  // Preparing all socket.io clients.
  async.series(Object.keys(conf.NSP).map(function (ns) {
    return function (callback) {
      var callbackOnce = _.once(callback)
      var nsl = ns.toLowerCase()
      if (options.sockets[nsl]) {
        return callbackOnce()
      }

      monitor.connect(_.extend({
        namespace: conf.NSP[ns]
      }, options), function (socket) {
        console.info('Connected to', socket.nsp)
        callbackOnce(null, socket)
      }, function (err, socket) {
        if (err) {
          return callbackOnce(new Error('Failed to connect to [' + ns + '] due to ' + err.message))
        }
      })
    }
  }), function (err, res) {
    if (err) {
      console.error(err.message)
      return process.exit(0)
    }
    Log({
      level: 1000
    })
    var connectedSockets = {}
    res.forEach(function (socket) {
      connectedSockets[socket.nsp.replace(/^\/+/g, '')] = socket
    })
    self.sockets = _.extend(connectedSockets, options.sockets)
    delete options.sockets

    self._observe()
    self._draw()

    setInterval(function () {
      self._bindProcesses()
    }, 1000)
  })
}

/**
 * Observe socket.io events.
 */
Layout.prototype._observe = function () {
  var self = this
  console.info('Listening socket events...')
  var socketSys = this._socket(conf.NSP.SYS)
  socketSys.on('procs', function (procs) {
    self._procs = {
      data: procs,
      tick: Date.now()
    }
    if (typeof self._procs === 'undefined') {
      self._bindProcesses()
    }
  })
  socketSys.emit('procs')

  this._socket(conf.NSP.PROC).on('proc', function (proc) {
    if (!self._usages || proc.pid !== self._usages.pid || self._usages.time === proc.time) {
      return
    }
    self._usages.time = proc.time
    self._usages.cpu.shift()
    self._usages.cpu.push(Math.min(100, Math.max(proc.usage.cpu, 1)))
    self._usages.mem.shift()
    self._usages.mem.push(Math.min(100, Math.max(proc.usage.memory, 1)))
  })

  this._socket(conf.NSP.LOG).on('log', function (log) {
    if (!self._eles.logs || self._lastLogPMId !== log.pm_id) {
      return
    }
    self._eles.logs.log(log.msg)
  })
}

/**
 * Bind processes to table.
 */
Layout.prototype._bindProcesses = function () {
  if (exiting || !this._eles.processes || !this._procs) {
    return
  }
  if (this._procs.tick === this._procsLastTick) {
    // Update tick only.
    return setRows.call(this, true)
  }

  if (typeof this._procsLastTick === 'undefined') {
    this._describeInfo(0)
    this._eles.processes.rows.on('select', onSelect.bind(this))
  }

  this._procsLastTick = this._procs.tick

  setRows.call(this, true)

  function setRows (forceRefresh) {
    var rows = []
    var selectedIndex = this._eles.processes.rows.selected
    var len = this._procs.data.length

    this._procs.data.forEach(function (p, i) {
      var pm2 = p.pm2_env
      var index = '[' + i + '/' + len + ']'
      rows.push([
        ' ' + chalk.grey((index + Array(8 - index.length).join(' '))) + ' ' + p.name,
        pm2.restart_time,
        pm2.status !== 'online' ? '0s' : _fromNow(Math.ceil((Date.now() - pm2.pm_uptime) / 1000), true),
        pm2.status === 'online' ? chalk.green('✔') : chalk.red('✘')
      ])
    })
    this._eles.processes.setData({
      headers: [' Name', 'Restarts', 'Uptime', ''],
      rows: rows
    })

    selectedIndex = typeof selectedIndex !== 'undefined' ? selectedIndex : 0
    var maxIndex = this._eles.processes.rows.items.length - 1
    if (selectedIndex > maxIndex) {
      selectedIndex = maxIndex
    }
    this._eles.processes.rows.select(selectedIndex)

    if (forceRefresh) {
      onSelect.call(this)
    }
  }

  function onSelect (item, selectedIndex) {
    if (!!item) { // eslint-disable-line no-extra-boolean-cast
      var lastIndex = this._lastSelectedIndex

      this._lastSelectedIndex = selectedIndex
      if (selectedIndex !== lastIndex) {
        this._describeInfo(selectedIndex)
      }
    }
    this._cpuAndMemUsage(this._lastSelectedIndex || 0)
    this._displayLogs(this._lastSelectedIndex || 0)
    this.screen.render()
  }
}

/**
 * Get description of a specified process.
 * @param  {Number} index the selected row index.
 */
Layout.prototype._describeInfo = function (index) {
  var pm2 = this._dataOf(index)
  if (!pm2) {
    return this._eles.json.setContent(_formatJSON({
      message: 'There is no process running!'
    }))
  }
  if (pm2.pm2_env && pm2.pm2_env.env) {
    // Remove useless large-bytes attributes.
    delete pm2.pm2_env.env['LS_COLORS']
  }
  delete pm2.monit
  this._eles.json.setContent(_formatJSON(pm2))
}

/**
 * CPU and Memory usage of a specific process
 * @param  {Number} index the selected row index.
 */
Layout.prototype._cpuAndMemUsage = function (index) {
  var pm2 = this._dataOf(index)
  if (!pm2) {
    return
  }
  if (!this._usages) {
    this._usages = {
      mem: [],
      cpu: []
    }
    var len = this._eles.cpu.width - 4
    for (var i = 0; i < len; i++) {
      this._usages.cpu.push(1)
      this._usages.mem.push(1)
    }
  }
  if (pm2.pid !== 0 && this._procCount === 2) {
    this._procCount = -1
    this._socket(conf.NSP.PROC).emit('proc', pm2.pid)
  }
  this._procCount++
  this._usages.pid = pm2.pid

  this._eles.cpu.setData(this._usages.cpu, 0, 100)
  this._eles.cpu.setLabel('CPU Usage (' + (this._usages.cpu[this._usages.cpu.length - 1]).toFixed(2) + '%)')

  this._eles.mem.setData(this._usages.mem, 0, 100)
  this._eles.mem.setLabel('Memory Usage (' + (this._usages.mem[this._usages.mem.length - 1]).toFixed(2) + '%)')
}

/**
 * Display logs.
 * @param  {Number} index [description]
 * @return {[type]}       [description]
 */
Layout.prototype._displayLogs = function (index) {
  var pm2 = this._dataOf(index)
  if (!pm2 || this._lastLogPMId === pm2.pm_id) {
    return
  }
  this._killLogs()
  this._socket(conf.NSP.LOG).emit('tail', this._lastLogPMId = pm2.pm_id, true)
}

/**
 * Kill `tail` process
 * @return {[type]}         [description]
 */
Layout.prototype._killLogs = function () {
  if (typeof this._lastLogPMId === 'undefined') {
    return
  }
  this._socket(conf.NSP.LOG).emit('tail_kill', this._lastLogPMId)
}

/**
 * Get data by index.
 * @param  {Number} index
 * @return {Object}
 */
Layout.prototype._dataOf = function (index) {
  if (!this._procs || !Array.isArray(this._procs.data) || index >= this._procs.data.length) {
    return null
  }
  return this._procs.data[index]
}

/**
 * Draw elements.
 */
Layout.prototype._draw = function () {
  console.info('Rendering dashboard...')
  var self = this
  var screen = blessed.Screen()
  screen.title = 'PM2 Monitor'

  var grid = _grid(screen)

  // Processes.
  this._eles.processes = grid.get(0, 0)
  this._bindProcesses()

  this._eles.cpu = grid.get(1, 0)
  this._eles.mem = grid.get(1, 1)

  // Logs.
  this._eles.logs = grid.get(2, 0)

  // Detail.
  this._eles.json = grid.get(0, 2)
  var offset = Math.round(this._eles.json.height * 100 / this._eles.json.getScrollHeight())
  var dir
  // Key bindings
  screen.key('s', function (ch, key) {
    if (exiting) {
      return
    }
    var perc = Math.min((dir !== 'down' ? offset : 0) + self._eles.json.getScrollPerc() + 5, 100)
    dir = 'down'
    self._eles.json.setScrollPerc(perc)
  })
  screen.key('w', function (ch, key) {
    if (exiting) {
      return
    }
    var perc = Math.max(self._eles.json.getScrollPerc() - 5 - (dir !== 'up' ? offset : 0), 0)
    dir = 'up'
    self._eles.json.setScrollPerc(perc)
  })

  screen.key(['escape', 'q', 'C-c'], function (ch, key) {
    if (exiting) {
      return
    }
    exiting = true
    this._killLogs()
    screen.title = 'PM2 Monitor (Exiting...)'
    screen.destroy()
    screen.title = ''
    screen.cursorReset()
    setTimeout(function () {
      // clear screen.
      // process.stdout.write('\u001B[2J\u001B[0;0f')
      process.exit(0)
    }, 1000)
  }.bind(this))

  screen.render()
  this.screen = screen
}

/**
 * Get socket.io object by namespace
 * @param  {String} ns
 */
Layout.prototype._socket = function (ns) {
  if (ns && this.sockets) {
    return this.sockets[(ns || '').replace(/^\/+/g, '').toLowerCase()]
  }
  return null
}

/**
 * Grid of screen elements.
 * @param {blessed.Screen} screen
 * @returns {*}
 * @private
 */
function _grid (screen) {
  var style = {
    fg: '#013409',
    label: {
      bold: true,
      fg: '#00500d'
    },
    border: {
      fg: '#5e9166'
    }
  }
  // Layout.
  var grid = widgets.Grid({
    rows: 3,
    cols: 3,
    margin: 0,
    widths: [25, 25, 50],
    heights: [35, 10, 55]
  })
  // Table of processes
  grid.set({
    row: 0,
    col: 0,
    colSpan: 2,
    element: widgets.Table,
    options: {
      keys: true,
      border: {
        type: 'line'
      },
      style: style,
      label: 'Processes (↑/↓ to move up/down, enter to select)',
      widths: [35, 15, 20, 15]
    }
  })
  // Sparkline of CPU
  grid.set({
    row: 1,
    col: 0,
    element: widgets.Sparkline,
    options: {
      border: {
        type: 'line'
      },
      style: {
        fg: '#bc6f0a',
        label: {
          bold: true,
          fg: '#00500d'
        },
        border: {
          fg: '#5e9166'
        }
      },
      label: 'CPU Usage(%)'
    }
  })

  // Sparkline of Memory
  grid.set({
    row: 1,
    col: 1,
    element: widgets.Sparkline,
    options: {
      border: {
        type: 'line'
      },
      style: {
        fg: '#6a00bb',
        label: {
          bold: true,
          fg: '#00500d'
        },
        border: {
          fg: '#5e9166'
        }
      },
      label: 'Memory Usage(%)'
    }
  })

  // Logs
  grid.set({
    row: 2,
    col: 0,
    colSpan: 2,
    element: widgets.Log,
    options: {
      border: {
        type: 'line'
      },
      style: style,
      label: 'Logs'
    }
  })

  // JSON data.
  grid.set({
    row: 0,
    col: 2,
    rowSpan: 3,
    element: blessed.ScrollableBox,
    options: {
      label: 'Describe Info (w/s to move up/down)',
      border: {
        type: 'line'
      },
      style: style,
      keys: true
    }
  })
  grid.draw(screen)

  return grid
}

/**
 * Pretty json data.
 * @param {Object} data
 * @returns {XML|*|string|void}
 * @private
 */
function _formatJSON (data) {
  data = JSON.stringify(typeof data !== 'string' ? data : JSON.parse(data), null, 2)

  return data.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (m) {
    var color = 'blue'
    if (/^"/.test(m)) {
      color = ['magenta', 'green'][/:$/.test(m) ? 0 : 1]
    } else if (/true|false/.test(m)) {
      color = 'blue'
    } else if (/null|undefined/.test(m)) {
      color = 'blue'
    }
    return chalk[color](m)
  })
}

/**
 * Wrap tick from now.
 * @param {Float} tick
 * @param {Boolean} tiny show all of it.
 * @returns {string}
 */
function _fromNow (tick, tiny) {
  if (tick < 60) {
    return tick + 's'
  }
  var s = tick % 60 + 's'
  if (tick < 3600) {
    return parseInt(tick / 60) + 'm ' + s
  }
  var m = parseInt((tick % 3600) / 60) + 'm '
  if (tick < 86400) {
    return parseInt(tick / 3600) + 'h ' + m + (!tiny ? '' : s)
  }
  var h = parseInt((tick % 86400) / 3600) + 'h '
  return parseInt(tick / 86400) + 'd ' + h + (!tiny ? '' : m + s)
}
