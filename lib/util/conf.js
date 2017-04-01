'use strict'

var fs = require('fs')
var _ = require('lodash')

var regComment = /^\s*;/
var regSetion = /^\s*\[([^\]]+)\]\s*$/
var regKV = /^([^=]+)=(.*)$/
var regBoolean = /^(true|false|yes|no|y|n)$/i
var regBooleanTrue = /^(true|yes|y)$/i

/**
 * Namespaces of socket.io
 * @type {{SYS: string, LOG: string, PROC: string}}
 */
exports.NSP = {
  SYS: '/system',
  LOG: '/log',
  PROCESS: '/proccess'
}

/**
 * All events of socket.io
 * @type {Object}
 */
exports.SOCKET_EVENTS = {
  ERROR: 'error',
  CONNECTION: 'connection',
  CONNECT: 'connect',
  CONNECT_ERROR: 'connect_error',
  DISCONNECT: 'disconnect',
  DATA: 'data',
  DATA_ACTION: 'data.action',
  DATA_USAGE: 'data.usage',
  DATA_PROCESSES: 'data.processes',
  DATA_SYSTEM_STATS: 'data.sysstat',
  DATA_PM2_VERSION: 'data.pm2version',
  PULL_LOGS: 'pull.log',
  PULL_USAGE: 'pull.usage',
  PULL_LOGS_END: 'pull.log_end',
  PULL_PROCESSES: 'pull.processes',
  PULL_ACTION: 'pull.action'
}

/**
 * Configurations
 * @type {[type]}
 */
exports.File = File

/**
 * Configurations store in a disk file.
 * @param {Object} options
 * @constructor
 */
function File (options) {
  if (!(this instanceof File)) {
    return new File(options)
  }

  if (_.isString(options)) {
    options = {
      file: options
    }
  }
  options = _.assign({}, options || {})
  if (!options.file) {
    throw new Error('`file` is required.')
  }
  Object.freeze(options)
  this.options = options
}

/**
 * Load data from file (sync).
 */
File.prototype.loadSync = function () {
  if (!fs.existsSync(this.options.file)) {
    this._data = {}
    return this
  }

  var json = {}
  var sec
  fs.readFileSync(this.options.file, {
    encoding: 'utf8'
  }).split(/[\r\n]/).forEach(function (line) {
    // Empty line.
    if (!line) {
      sec = null
      return
    }
    // Remove comments.
    if (regComment.test(line)) {
      return
    }
    var ms
    // Sections.
    if ((ms = line.match(regSetion)) && ms.length === 2) {
      json[sec = ms[1].trim()] = {}
      return
    }

    // Key-value pairs.
    if ((ms = line.match(regKV)) && ms.length === 3) {
      var key = ms[1].trim()
      var value = ms[2].trim()
      // Parse boolean and number.
      if (!isNaN(value)) {
        value = parseFloat(value)
      } else if (regBoolean.test(value)) {
        value = regBooleanTrue.test(value)
      }
      if (sec) {
        json[sec][key] = value
      } else {
        json[key] = value
      }
    }
  })

  this._data = json
  return this
}

/**
 * Save data to a disk file (sync).
 * @returns {File}
 */
File.prototype.saveSync = function () {
  var ini = ''
  for (var key in this._data) {
    var value = this._data[key]
    // TODO: Array type.
    if (_.isObject(value)) {
      ini += '[ ' + key + ' ]\n'
      for (var subKey in value) {
        ini += _wrapValue(subKey, value[subKey])
      }
      ini += '\n'
    }
    ini += _wrapValue(key, value)
  }
  fs.writeFileSync(this.options.file, ini)
  return this
}

/**
 * Get data.
 * @returns {{}|*}
 */
File.prototype.valueOf = function () {
  return this._data
}

/**
 * Get/set/remove key-value pairs.
 * @param {String} key
 * @param {Mixed} value
 * @param {Mixed} def
 * @returns {*}
 */
File.prototype.val = function (key, value, def) {
  if (!key) {
    return
  }
  // Load config from File.
  this.loadSync()

  if (_.isUndefined(value)) {
    // Get config.
    return this._data[key]
  }
  if (value == null) {
    // Clear config.
    delete this._data[key]
    // Reset to default if necessary.
    if (!_.isUndefined(def)) {
      this._data[key] = def
    }
    return this.saveSync()
  }

  this._data[key] = value

  // Save it.
  this.saveSync()
  return this
}

function _wrapValue (key, value) {
  return key + ' = ' + (_.isString(value) ? value : JSON.stringify(value)) + '\n'
}
