'use strict'

var db = require('./db')

function getSettings () {
  return db.getAllSettings()
}

function updateSettings (patch) {
  patch = patch || {}
  Object.keys(patch).forEach(function (key) {
    if (
      Object.prototype.hasOwnProperty.call(db.DEFAULT_SETTINGS, key) ||
      key.indexOf('log_') === 0 ||
      key.indexOf('public_') === 0 ||
      key === 'readonly' ||
      key === 'debug_enabled' ||
      key === 'refresh' ||
      key === 'process_refresh' ||
      key === 'origins' ||
      key === 'projects_root'
    ) {
      db.setSetting(key, patch[key])
    }
  })
  return getSettings()
}

/**
 * Merge DB settings into monitor runtime options.
 */
function applyToOptions (options) {
  options = options || {}
  var settings = getSettings()

  if (settings.refresh != null) options.refresh = settings.refresh
  if (settings.process_refresh != null) options.process_refresh = settings.process_refresh
  if (typeof settings.readonly === 'boolean') options.readonly = settings.readonly
  if (settings.origins) options.origins = settings.origins

  options.web = options.web || {}
  options.web.public_host = settings.public_host || ''
  options.web.public_protocol = settings.public_protocol || 'http'

  options.log = options.log || {}
  if (settings.log_dir != null) options.log.dir = settings.log_dir
  if (typeof settings.log_prefix === 'boolean') options.log.prefix = settings.log_prefix
  if (typeof settings.log_date === 'boolean') options.log.date = settings.log_date
  if (settings.log_level) options.log.level = settings.log_level
  if (settings.debug_enabled) {
    options.log = options.log || {}
    options.log.level = 'debug'
  }

  return options
}

function getPublicConfig () {
  var settings = getSettings()
  return {
    publicHost: settings.public_host || '',
    publicProtocol: settings.public_protocol || 'http',
    projectsRoot: settings.projects_root || '',
    readonly: !!settings.readonly,
    debugEnabled: !!settings.debug_enabled,
    refresh: settings.refresh,
    processRefresh: settings.process_refresh
  }
}

module.exports = {
  getSettings: getSettings,
  updateSettings: updateSettings,
  applyToOptions: applyToOptions,
  getPublicConfig: getPublicConfig
}
