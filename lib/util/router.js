'use strict'

var path = require('path')
var _ = require('lodash')
var fs = require('fs')

var regJs = /\.js$/
var regMain = /^(index|main|home)$/
var routes = []
var namespace = ''

// bind actions.
global.action = function (method, path, func) {
  if (_.isFunction(method)) {
    func = method
    method = 'get'
    path = func.name
  } else if (_.isFunction(path)) {
    func = path
    path = func.name
  }
  if (!_.isString(method) || !_.isString(path) || !_.isFunction(func)) {
    throw new Error('Arguments of action() should be one of `[FUNCTION]` / `[METHOD], [FUNCTION]` / `[METHOD], [PATH], [FUNCTION]`.')
  }
  routes.push({
    method: method,
    path: '/' + (regMain.test(namespace) ? '' : namespace) + (path ? '/' + path : ''),
    fn: func
  })
}

var cwd = path.resolve(__dirname, '../../', 'web/routes')

// initialize.
module.exports = function (server) {
  fs.readdirSync(cwd)
    .forEach(function (f) {
      if (!f || !regJs.test(f)) {
        return
      }
      namespace = path.basename(f, '.js')
      require(path.resolve(cwd, f))
    })
  routes.forEach(function (route) {
    route.path = route.path.replace(/\/+/g, '/')
    server[route.method](route.path, route.fn)
  })
}
