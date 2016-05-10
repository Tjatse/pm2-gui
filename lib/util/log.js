var chalk = require('chalk')

module.exports = function (options) {
  options = options || {}
  var lev = options.level
  var hacks = ['debug', 'log', 'info', 'warn', 'error']

  if ((typeof lev === 'string' && typeof (lev = hacks.indexOf(lev)) === 'undefined') || (isFinite(lev) && (lev < 0 || lev > hacks.length))) {
    options.level = 0
  }
  options.level = !isNaN(lev) ? lev : 0

  console.__level = options.level

  if (console.__hacked) {
    return
  }

  var colors = ['grey', '', 'green', 'yellow', 'red']
  var consoled = {}

  hacks.forEach(function (method) {
    if (method === 'debug') {
      consoled.debug = console.log
      return
    }
    consoled[method] = console[method]
  })

  hacks.forEach(function (method, index) {
    console[method] = function () {
      if (index < console.__level) {
        return
      }
      if (method !== 'log' && arguments.length > 0) {
        arguments[0] = (options.prefix ? chalk.bold[colors[index]]('[' + method.toUpperCase() + '] ') : '') +
        (options.date ? (new Date()).toLocaleString() + ' ' : '') + arguments[0]
      }
      consoled[method].apply(console, arguments)
    }
  })

  console.__hacked = true
}
