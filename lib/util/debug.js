var chalk = require('chalk'),
  _ = require('lodash');

module.exports = Debug;

/**
 * Simple debug tool.
 * @param {Object} options
 * @returns {Debug}
 * @constructor
 */
function Debug(options) {
  if (!(this instanceof Debug)) {
    return new Debug(options);
  }
  if (typeof options == 'string') {
    options = {
      namespace: options
    };
  }
  this.options = _.defaults(options || {}, {
    namespace: 'pm2-gui',
    timestamp: true,
    debug: false
  });
}
Debug.prototype._l = function (level, args) {
  if(!this.options.debug){
    return;
  }
  args = _.values(args);

  var prints = [chalk.bgBlack.grey(this.options.namespace)];
  var prefix, color;
  switch (level) {
    case 'e':
      prefix = 'ERR!', color = 'red';
      break;
    case 'w':
      prefix = 'warn', color = 'yellow';
      break;
    case 'd':
      if(this.options.timestamp){
        prints.push(chalk.underline.dim((new Date()).toISOString()))
      }
      break;
    default :
      prefix = args.splice(0, 1), color = 'green';
      break;
  }
  if(prefix && color){
    prints.splice(2, 0, chalk.bgBlack[color](prefix));
  }
  prints.push(args.join(' '));
  console.log.apply(null, prints);
};

/**
 * Loggers: info, error, debug, log, warn.
 */
['i', 'e', 'd', 'l', 'w'].forEach(function(s){
  Debug.prototype[s] = function(){
    this._l.call(this, s, arguments);
  };
});