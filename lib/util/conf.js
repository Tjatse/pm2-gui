var fs = require('fs'),
  _ = require('lodash');

exports.File = File;

/**
 * Configurations store in a disk file.
 * @param {Object} options
 * @constructor
 */
function File(options) {
  if (!(this instanceof File)) {
    return new File(options);
  }

  if (typeof options == 'string') {
    options = {
      file: options
    };
  }
  options = _.assign({}, options || {});
  if (!options.file) {
    throw new Error('`file` is required.');
  }
  Object.freeze(options);
  this.options = options;
}

/**
 * Load data from file (sync).
 */
File.prototype.loadSync = function () {
  if (!fs.existsSync(this.options.file)) {
    this._data = {};
    return this;
  }
  var re_comment = /^\s*;/,
    re_setion = /^\s*\[([^\]]+)\]\s*$/,
    re_kv = /^([^=]+)=(.*)$/,
    re_boolean = /^(true|false)$/i;

  var json = {},
    sec;
  fs.readFileSync(this.options.file, {
      encoding: 'utf8'
    })
    .split(/[\r\n]/).forEach(function (line) {
      // Empty line.
      if (!line) {
        sec = null;
        return;
      }
      // Remove comments.
      if (re_comment.test(line)) {
        return;
      }

      var ms;
      // Sections.
      if ((ms = line.match(re_setion)) && ms.length == 2) {
        json[sec = ms[1].trim()] = {};
        return;
      }

      // Key-value pairs.
      if ((ms = line.match(re_kv)) && ms.length == 3) {
        var key = ms[1].trim(),
          value = ms[2].trim();
        // Parse boolean and number.
        if (!isNaN(value)) {
          value = parseFloat(value);
        } else if (re_boolean.test(value)) {
          value = value.toLowerCase() == 'true';
        }
        if (sec) {
          json[sec][key] = value;
        } else {
          json[key] = value;
        }
      }
    });

  this._data = json;
  return this;
};

/**
 * Save data to a disk file (sync).
 * @returns {File}
 */
File.prototype.saveSync = function () {
  function wrapValue(key, value) {
    return key + ' = ' + (typeof value == 'string' ? value : JSON.stringify(value)) + '\n';
  }
  var ini = '';
  for (var key in this._data) {
    var value = this._data[key];
    // TODO: Array type.
    if (typeof value == 'object') {
      ini += '[ ' + key + ' ]\n';
      for (var subKey in value) {
        ini += wrapValue(subKey, value[subKey])
      }
      ini += '\n';
    }
    ini += wrapValue(key, value);
  }
  fs.writeFileSync(this.options.file, ini);
  return this;
};

/**
 * Get data.
 * @returns {{}|*}
 */
File.prototype.valueOf = function () {
  return this._data;
};

/**
 * Get/set/remove key-value pairs.
 * @param {String} key
 * @param {Mixed} value
 * @param {Mixed} def
 * @returns {*}
 */
File.prototype.val = function (key, value, def) {
  if (!key) {
    return;
  }
  // Load config from File.
  this.loadSync();

  if (typeof value == 'undefined') {
    // Get config.
    return this._data[key];
  } else if (value == null) {
    // Clear config.
    delete this._data[key];
    // Reset to default if necessary.
    (typeof def != 'undefined') && (this._data[key] = def);
    return this.saveSync();
  }

  this._data[key] = value;

  // Save it.
  this.saveSync();
  return this;
};
