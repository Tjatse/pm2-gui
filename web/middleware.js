'use strict'

var _ = require('lodash')
var url = require('url')

var whitelist = [
  /\/auth\/signin/i,
  /\/auth\/signout/i
]

/**
 * Middleware of express
 * @param  {Request}   req
 * @param  {Resonse}   res
 * @param  {Function} next
 * @return {N/A}
 */
module.exports = function (req, res, next) {
  var pathname = url.parse(req.url).pathname
  var redirectTo = decodeURIComponent(req.url)

  var conf = res.locals.config
  var user
  if (conf.agent && conf.agent.authorization) {
    user = req.session && req.session.user
    if (!user && !whitelist.some((d) => d.test(pathname || ''))) {
      return res.redirect('/auth/signin?redirectTo=' + (redirectTo || ''))
    }
  } else {
    user = {
      nick: 'anony',
      full: 'anonymous user',
      anony: true,
      activedAt: Date.now()
    }
  }

  var locals = {
    user: _.omit(user, 'passwd'),
    title: '',
    error: ''
  }

  var routePath = res.locals.path
  var render = res.render

  _.extend(res.locals, locals)

  res.render = (templatePath, extraData) => {
    if (_.isUndefined(templatePath) || _.isObject(templatePath)) {
      extraData = templatePath ? _.clone(templatePath) : {}
      templatePath = routePath
    }
    templatePath = _.trim(templatePath, '/') || 'index'
    return render.call(res, templatePath, _.extend(locals, extraData || {}))
  }
  next()
}
