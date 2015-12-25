var chalk = require('chalk');

module.exports = function (options) {
  if (console.__hacked) {
    return;
  }
  options = options || {};
  var hacks = ['debug', 'log', 'info', 'warn', 'error'],
    colors = ['grey', '', 'green', 'yellow', 'red'],
    consoled = {},
    lev = options.level;

  if ((typeof lev == 'string' && !(lev = hacks[lev])) || (isFinite(lev) && (lev < 0 || lev > hacks.length))) {
    options.level = 0;
  }

  hacks.forEach(function (method) {
    if (method == 'debug') {
      consoled.debug = console.log;
      return;
    }
    consoled[method] = console[method];
  });

  hacks.forEach(function (method, index) {
    console[method] = function () {
      if (index < options.level) {
        return;
      }
      if (method != 'log' && arguments.length > 0) {
        arguments[0] = (options.prefix ? chalk.bold[colors[index]]('[' + method.toUpperCase() + '] ') : '') +
          (options.date ? (new Date()).toLocaleString() + ' ' : '') + arguments[0];
      }
      consoled[method].apply(console, arguments);
    };
  });

  console.__hacked = true;
};
