'use strict'

var path = require('path')
var fs = require('fs')
var express = require('express')
var _ = require('lodash')

var middleware = require('./middleware')
var router = express.Router()
var routes = []
var namespace = ''

var regRoot = /\/?(index|main|home)$/
var allowedMethods = ['get', 'post', 'delete', 'put']
var cwd = path.resolve(__dirname, './routes')

// bind actions.
global.action = function (method, path, func) {
  // fixed parameters
  if (typeof method === 'function') {
    func = method
    method = 'get'
    path = func.name
  } else if (typeof path === 'function') {
    func = path
    path = func.name

    var methodLower = method.toLowerCase()
    if (methodLower === 'all' || !!~allowedMethods.indexOf(methodLower)) { // eslint-disable-line no-extra-boolean-cast
      path = func.name
    } else {
      path = method
      method = 'get'
    }
  }
  // verify...
  if (!_.isString(method) || !_.isString(path) || !_.isFunction(func)) {
    throw new Error('Arguments of action() should be one of `[FUNCTION]` / `[METHOD], [FUNCTION]` / `[METHOD], [PATH], [FUNCTION]`.')
  }
  // routes
  namespace = namespace.replace(regRoot, '')
  routes.push({
    method: method,
    path: '/' + namespace + (path ? '/' + path : ''),
    fn: func
  })
}

function initRouter () {
  // import routes
  importRoutes(cwd)
    .predicate(function (f) {
      return f && /\.js$/i.test(f)
    })
    .ready(function (rejectedFiles, resolvedFiles) {
      // if (rejectedFiles.length > 0) {
      //   console.log('   [router] rejected files', rejectedFiles.join(', '))
      // }
      resolvedFiles.forEach(function (f) {
        namespace = path.relative(cwd, f).replace(/^[./]+/g, '').replace(/\.js$/, '')
        require(path.resolve(cwd, f))
      })
      routes.forEach(function (route) {
        route.path = route.path.replace(/\/+/g, '/')
        var params = [route.path, (req, res, next) => {
          res.locals.path = route.path
          middleware(req, res, next)
        }, route.fn]
        if (route.method === 'all') {
          allowedMethods.forEach(function (method) {
            router[method].apply(router, params)
          })
        } else {
          router[route.method].apply(router, params)
        }
      })
    })
  return router
}

function importRoutes (cwd) {
  var core = {
    predicate: function (pred) {
      return {
        ready: function (fn) {
          var out = {
            rejected: [],
            resolved: []
          }
          core.read('', cwd, pred, out)
          fn(out.rejected, out.resolved)
        }
      }
    },
    read: function (prefix, cwd, pred, out) {
      fs.readdirSync(cwd)
        .forEach(function (f) {
          if (pred(f)) {
            out.resolved.push(prefix + (prefix ? '/' : '') + f)
          } else if (f) {
            var dir = path.resolve(cwd, f)
            var stat = fs.lstatSync(dir)
            if (stat.isDirectory()) {
              return core.read(prefix + (prefix ? '/' : '') + f, dir, pred, out)
            }
            out.rejected.push(f)
          }
        })
    }
  }

  return core
}

// initialize.
module.exports = initRouter()
