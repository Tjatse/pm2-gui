'use strict'

var monitor = null

function setMonitor (instance) {
  monitor = instance
}

function getMonitor () {
  return monitor
}

function reloadSettings () {
  if (monitor && typeof monitor.reloadSettings === 'function') {
    monitor.reloadSettings()
  }
}

module.exports = {
  setMonitor: setMonitor,
  getMonitor: getMonitor,
  reloadSettings: reloadSettings
}
