// Inspired by the blessed-contrib, but more powerful and free.
// (c) Tjatse

var blessed = require('blessed')
var util = require('util')
var re_stripANSI = /(?:(?:\u001b\[)|\u009b)(?:(?:[0-9]{1,3})?(?:(?:;[0-9]{0,3})*)?[A-M|f-m])|\u001b[A-M]/g

exports.Grid = Grid
exports.Table = Table
exports.Sparkline = Sparkline
exports.Log = Log

/**
 * Grid cells.
 * @param {Object} options
 * @returns {Grid}
 * @constructor
 */
function Grid (options) {
  if (!(this instanceof Grid)) {
    return new Grid(options)
  }
  options = util._extend({
    margin: 2
  }, options || {})

  this.grids = []

  for (var r = 0; r < options.rows; r++) {
    this.grids[r] = []
    for (var c = 0; c < options.cols; c++) {
      this.grids[r][c] = {}
    }
  }

  this.options = options
}
/**
 * Get instance in the specific row and column.
 * @param {Number} row
 * @param {Number} col
 * @returns {*}
 */
Grid.prototype.get = function (row, col) {
  return this.grids[row][col].instance
}
/**
 * Set element in the cell.
 * @param ele
 */
Grid.prototype.set = function (ele) {
  if (Array.isArray(ele)) {
    for (var i = 0; i < ele.length; i++) {
      this.set(ele[i])
    }
    return
  }
  this.grids[ele.row][ele.col] = util._extend({rowSpan: 1, colSpan: 1}, ele)
}
/**
 * Draw grid.
 * @param {blessed.screen} screen
 */
Grid.prototype.draw = function (screen, rect) {
  rect = rect || {
    width: 100,
    height: 100,
    top: 0,
    left: 0
  }
  var margin = this.options.margin
  var widths = this.options.widths || []
  var heights = this.options.heights || []
  var cols = this.options.cols
  var rows = this.options.rows

  if (widths.length !== cols) {
    var avg = (rect.width - margin) / cols
    for (var c = 0; c < cols; c++) {
      widths.push(avg)
    }
  }
  if (heights.length !== rows) {
    var avg = (rect.height - margin) / rows // eslint-disable-line no-redeclare
    for (var r = 0; r < rows; r++) {
      heights.push(avg)
    }
  }

  for (var r = 0; r < rows; r++) { // eslint-disable-line no-redeclare
    for (var c = 0; c < cols; c++) { // eslint-disable-line no-redeclare
      var ele = this.grids[r][c]
      if (!ele.element) {
        continue
      }

      var factorWidth = (rect.width - margin) / 100
      var factorHeight = (rect.height - margin) / 100
      var width = widths.slice(c, c + ele.colSpan).reduce(_reduce) * factorWidth
      var height = heights.slice(r, r + ele.rowSpan).reduce(_reduce) * factorHeight
      var top = rect.top + margin / 2 + (r === 0 ? 0 : heights.slice(0, r).reduce(_reduce)) * factorHeight
      var left = rect.left + margin / 2 + (c === 0 ? 0 : widths.slice(0, c).reduce(_reduce)) * factorWidth

      if (ele.element instanceof Grid) {
        ele.element.draw(screen, {
          width: width,
          height: height,
          top: top,
          left: left
        })
      } else {
        screen.append(ele.instance = ele.element(util._extend(ele.options || {}, {
          top: top + '%',
          left: left + '%',
          width: width + '%',
          height: height + '%'
        })))
      }
    }
  }
}

/**
 * Table list.
 * @param {Object} options
 * @returns {Table}
 * @constructor
 */
function Table (options) {
  if (!(this instanceof Table)) {
    return new Table(options)
  }

  this.options = options || {}
  this.options.tags = true

  blessed.Box.call(this, this.options)

  this.rows = blessed.list(util._extend(this.options.rows || {}, {
    height: 0,
    top: 1,
    width: 0,
    left: 0,
    selectedFg: '#fcfbac',
    selectedBg: '#398cc6',
    fg: '#333',
    keys: true
  }))
  this.append(this.rows)
}

util.inherits(Table, blessed.Box)

/**
 * Inherits from blessed.Box
 */
Table.prototype.render = function () {
  this.rows.focus()
  this.rows.width = this.width - 2
  this.rows.height = this.height - 4
  blessed.Box.prototype.render.call(this, this.options)
}

/**
 * Bind data to Table.
 * @param {Object} data
 */
Table.prototype.setData = function (data) {
  var widths = this.options.widths
  var def = true
  if (!widths) {
    widths = 24
    def = false
  }
  var dataToString = function (d) {
    return d.map(function (s, i) {
      s = s.toString()
      var s1 = s.replace(re_stripANSI, '')
      var size = !def ? widths : widths[i]
      var len = size - s1.length

      if (len < 0) {
        s = s1.substr(0, size - 1) + '...'
      } else {
        s += Array(len).join(' ')
      }
      return s
    }).join('')
  }

  var rows = []

  data.rows.forEach(function (d) {
    rows.push(dataToString(d))
  })
  this.setContent('{bold}' + dataToString(data.headers) + '{/bold}')
  this.rows.setItems(rows)
}

/**
 * Sparkline.
 * @param {Object} options
 * @returns {Sparkline}
 * @constructor
 */
function Sparkline (options) {
  if (!(this instanceof Sparkline)) {
    return new Sparkline(options)
  }

  this.options = util._extend({
    chars: ['▂', '▃', '▄', '▅', '▆', '▇', '█'],
    tags: true,
    padding: {
      left: 1,
      top: 1
    }
  }, options || {})
  blessed.Box.call(this, this.options)
}
util.inherits(Sparkline, blessed.Box)

/**
 * Set data.
 * @param {Array} data
 */
Sparkline.prototype.setData = function (data, min, max) {
  var chars = this.options.chars
  max = typeof max === 'undefined' ? Math.max.apply(null, data) : max
  min = typeof min === 'undefined' ? Math.min.apply(null, data) : min
  var dis = max - min
  var len = chars.length - 1

  if (dis === 0) {
    dis = 1
  }

  var content = data.map(function (n) {
    var index = Math.round((n - min) / dis * len)
    return chars[index]
  }).join('')
  this.setContent(content)
}

/**
 * Log.
 * @param {Object} options
 * @returns {Log}
 * @constructor
 */
function Log (options) {
  if (!(this instanceof Log)) {
    return new Log(options)
  }

  this.options = options || {}

  blessed.ScrollableBox.call(this, this.options)

  this.logs = []
}
util.inherits(Log, blessed.ScrollableBox)

/**
 * Log logs.
 * @param {String} str
 */
Log.prototype.log = function (str, size) {
  size = size || this.height
  this.logs.push(str)
  var len = this.logs.length - size
  if (len > 0) {
    this.logs.splice(0, len)
  }
  this.setContent(this.logs.join('\n'))
  this.setScrollPerc(100)
}

function _reduce (x, y) {
  return x + y
}
