'use strict'

var blessed = require('blessed')
var chalk = require('chalk')
var async = require('async')
var _ = require('lodash')

var widgets = require('./widgets')
var conf = require('../util/conf')
var Log = require('../util/log')

var ignoredENVKeys = ['LS_COLORS']
var regJSON = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g

module.exports = Layout

/**
 * Create layout.
 * @param {Object} options
 */
function Layout (options) {
  if (!(this instanceof Layout)) {
    return new Layout(options)
  }
  // initialize options
  options = _.clone(options || {})
  if (!options.hostname) {
    options.hostname = '127.0.0.1'
  }
  if (!options.port) {
    throw new Error('Port of socket.io server is required!')
  }
  this._eles = {}
  this._data = {
    processCount: -1,
    sockets: options.sockets || {}
  }
  delete options.sockets
  this.options = options
  Object.freeze(this.options)
}

/**
 * Render GUI.
 * @param  {Monitor} monitor
 * @return {N/A}
 */
Layout.prototype.render = function (monitor) {
  var self = this
  var options = this.options

  // Preparing all socket.io clients.
  async.series(Object.keys(conf.NSP).map(function (ns) {
    return function (next) {
      var nsl = ns.toLowerCase()
      if (self._data.sockets[nsl]) {
        return next()
      }
      // connect to monitor
      monitor.connect(_.extend({
        namespace: conf.NSP[ns]
      }, options), function (err, socket) {
        if (err) {
          return next(new Error('Fatal to connect to ' + socket.nsp + ' due to ' + err))
        }
        next(null, socket)
      })
    }
  }), function (err, res) {
    if (err) {
      console.error(err.message)
      return process.exit(0)
    }
    // muted logger.
    Log({
      level: 1000
    })
    var connectedSockets = {}
    res.forEach(function (socket) {
      connectedSockets[socket.nsp.replace(/^\/+/g, '')] = socket
    })
    // cache sockets.
    _.extend(self._data.sockets, connectedSockets)

    // render layout.
    self._observe()
    self._draw()
    // refresh processes every 1s
    setInterval(function () {
      self._processesTable()
    }, 1000)
  })
}

/**
 * Observe socket.io events.
 */
Layout.prototype._observe = function () {
  var self = this
  console.info('Listening socket events...')
  // watch processes
  this._socket(conf.NSP.PROCESS)
    .on(conf.SOCKET_EVENTS.DATA_PROCESSES, function (procs) {
      self._data.processes = {
        data: procs,
        tick: Date.now()
      }
      self._processesTable()
    })
    .emit(conf.SOCKET_EVENTS.PULL_PROCESSES)
    .on(conf.SOCKET_EVENTS.DATA_USAGE, function (proc) {
      if (!self._data.usages || proc.pid !== self._data.usages.pid || self._data.usages.time === proc.time) {
        return
      }
      self._data.usages.time = proc.time
      self._data.usages.cpu.shift()
      self._data.usages.cpu.push(Math.min(100, Math.max(proc.usage.cpu, 1)))
      self._data.usages.mem.shift()
      self._data.usages.mem.push(Math.min(100, Math.max(proc.usage.memory, 1)))
    })

  // subscribe logs
  this._socket(conf.NSP.LOG).on(conf.SOCKET_EVENTS.DATA, function (log) {
    if (!self._eles.logs || self._data.lastLogPMId !== log.id) {
      return
    }
    self._eles.logs.log(log.text)
  })
}

/**
 * Render processes in a datatable
 * @return {N/A}
 */
Layout.prototype._processesTable = function () {
  if (this._data.exiting || !this._eles.processes || !this._data.processes) {
    return
  }
  if (this._data.processes.tick === this._data.processesLastTick) {
    // Update tick only.
    return this._processesTableRows(true)
  }

  if (_.isUndefined(this._data.processesLastTick)) {
    // show first process informations.
    this._describeInfo(0)
    // bind `select` event on datatable.
    this._eles.processes.rows.on('select', this._onProcessesTableSelect.bind(this))
  }
  // cache last tick
  this._data.processesLastTick = this._data.processes.tick
  // render rows of datatable
  this._processesTableRows(true)
}

/**
 * Render processes datatable rows
 * @param  {Boolean} forceRefresh
 * @return {N/A}
 */
Layout.prototype._processesTableRows = function (forceRefresh) {
  var rows = []
  var selectedIndex = this._eles.processes.rows.selected
  var len = this._data.processes.data.length

  this._data.processes.data.forEach(function (p, i) {
    var pm2 = p.pm2_env
    var index = '[' + (i + 1) + '/' + len + ']'
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

  selectedIndex = !_.isUndefined(selectedIndex) ? selectedIndex : 0
  var maxIndex = this._eles.processes.rows.items.length - 1
  if (selectedIndex > maxIndex) {
    selectedIndex = maxIndex
  }
  this._eles.processes.rows.select(selectedIndex)

  if (forceRefresh) {
    this._onProcessesTableSelect()
  }
}

/**
 * Listening select event on processes datatable.
 * @param  {Object} item
 * @param  {Number} selectedIndex
 * @return {N/A}
 */
Layout.prototype._onProcessesTableSelect = function (item, selectedIndex) {
  if (!!item) { // eslint-disable-line no-extra-boolean-cast
    var lastIndex = this._data.lastSelectedIndex
    this._data.lastSelectedIndex = selectedIndex
    if (selectedIndex !== lastIndex) {
      this._describeInfo(selectedIndex)
    }
  }
  this._cpuAndMemUsage(this._data.lastSelectedIndex || 0)
  this._displayLogs(this._data.lastSelectedIndex || 0)
  this._eles.screen.render()
}

/**
 * Get description of a specified process.
 * @param  {Number} index the selected row index.
 * @return {N/A}
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
    ignoredENVKeys.forEach(function (envKey) {
      delete pm2.pm2_env.env[envKey]
    })
  }
  delete pm2.monit
  this._eles.json.setContent(_formatJSON(pm2))
}

/**
 * CPU and Memory usage of a specific process
 * @param  {Number} index the selected row index.
 * @return {N/A}
 */
Layout.prototype._cpuAndMemUsage = function (index) {
  var pm2 = this._dataOf(index)
  if (!pm2) {
    return
  }
  if (!this._data.usages) {
    this._data.usages = {
      mem: [],
      cpu: []
    }
    var len = this._eles.cpu.width - 4
    for (var i = 0; i < len; i++) {
      this._data.usages.cpu.push(1)
      this._data.usages.mem.push(1)
    }
  }
  // fetch process info every 3 times
  if (pm2.pid !== 0 && this._data.processCount === 2) {
    this._data.processCount = -1
    this._socket(conf.NSP.PROCESS).emit(conf.SOCKET_EVENTS.PULL_USAGE, pm2.pid)
  }
  this._data.processCount++
  this._data.usages.pid = pm2.pid

  this._eles.cpu.setData(this._data.usages.cpu, 0, 100)
  this._eles.cpu.setLabel('CPU Usage (' + (this._data.usages.cpu[this._data.usages.cpu.length - 1]).toFixed(2) + '%)')

  this._eles.mem.setData(this._data.usages.mem, 0, 100)
  this._eles.mem.setLabel('Memory Usage (' + (this._data.usages.mem[this._data.usages.mem.length - 1]).toFixed(2) + '%)')
}

/**
 * Display logs.
 * @param  {Number} index
 * @return {N/A}
 */
Layout.prototype._displayLogs = function (index) {
  var pm2 = this._dataOf(index)
  if (!pm2 || this._data.lastLogPMId === pm2.pm_id) {
    return
  }
  this._stopLogging()
  this._socket(conf.NSP.LOG).emit(conf.SOCKET_EVENTS.PULL_LOGS, pm2.pm_id, true)
  this._data.lastLogPMId = pm2.pm_id
}

/**
 * Stop logging.
 * @return {N/A}
 */
Layout.prototype._stopLogging = function () {
  if (_.isUndefined(this._data.lastLogPMId)) {
    return
  }
  this._socket(conf.NSP.LOG).emit(conf.SOCKET_EVENTS.PULL_LOGS_END, this._data.lastLogPMId)
}

/**
 * Get data by index.
 * @param  {Number} index
 * @return {Object}
 */
Layout.prototype._dataOf = function (index) {
  if (!this._data.processes || !Array.isArray(this._data.processes.data) || index >= this._data.processes.data.length) {
    return null
  }
  return this._data.processes.data[index]
}

/**
 * Draw elements.
 * @return {N/A}
 */
Layout.prototype._draw = function () {
  console.info('Rendering dashboard...')
  var self = this
  var screen = blessed.Screen()
  screen.title = 'PM2 Monitor'

  var grid = _grid(screen)

  // Processes.
  this._eles.processes = grid.get(0, 0)
  this._processesTable()

  _.extend(this._eles, {
    cpu: grid.get(1, 0),
    mem: grid.get(1, 1),
    logs: grid.get(2, 0),
    json: grid.get(0, 2)
  })

  var offset = Math.round(this._eles.json.height * 100 / this._eles.json.getScrollHeight())
  var dir
  // Key bindings
  screen.key('s', function (ch, key) {
    if (self._data.exiting) {
      return
    }
    var perc = Math.min((dir !== 'down' ? offset : 0) + self._eles.json.getScrollPerc() + 5, 100)
    dir = 'down'
    self._eles.json.setScrollPerc(perc)
  })
  screen.key('w', function (ch, key) {
    if (self._data.exiting) {
      return
    }
    var perc = Math.max(self._eles.json.getScrollPerc() - 5 - (dir !== 'up' ? offset : 0), 0)
    dir = 'up'
    self._eles.json.setScrollPerc(perc)
  })
  screen.key(['escape', 'q', 'C-c'], function (ch, key) {
    if (self._data.exiting) {
      return
    }
    self._data.exiting = true
    this._stopLogging()
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
  this._eles.screen = screen
}

/**
 * Get socket.io object by namespace
 * @param  {String} ns
 * @return {socket.io}
 */
Layout.prototype._socket = function (ns) {
  if (ns && this._data.sockets) {
    return this._data.sockets[(ns || '').replace(/^\/+/g, '').toLowerCase()]
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
  data = JSON.stringify(!_.isString(data) ? data : JSON.parse(data), null, 2)

  return data.replace(regJSON, function (m) {
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
