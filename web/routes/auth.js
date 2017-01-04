'use strict'

var path = require('path')
var fs = require('fs')
var _ = require('lodash')

var pkg = require('../../package')
var contributors

action(function signin (req, res) {
  var agent = res.locals.config.agent
  if (!agent || (req.session.user && agent.authorization === req.session.user.passwd)) {
    return res.redirect('/')
  }
  res.render('auth/lockscreen', {
    title: 'Sign In',
    redirectTo: req.query.redirectTo || ''
  })
})

action('post', function signin (req, res) {
  var agent = res.locals.config.agent
  var respParams = {
    title: 'Sign In',
    redirectTo: req.body.redirectTo || ''
  }
  var passwd
  if (!agent || !agent.authorization) {
    respParams.error = 'Fatal error: no need to signin for anonymous users!'
  } else if (!req.body || !(passwd = req.body.pwd)) {
    respParams.error = 'Fatal error: authorization code is required!'
  }
  if (respParams.error) {
    return res.render('auth/lockscreen', respParams)
  }

  if (agent && passwd === agent.authorization) {
    loadContributors(function (contribs) {
      if (Array.isArray(contribs)) {
        contributors = contribs
      }
      var user = contributors[Math.round(Math.random() * 10000) % contributors.length]
      req.session.user = _.extend({
        activedAt: Date.now(),
        passwd: passwd
      }, user)
      res.redirect(req.body.redirect || '/')
    })
    return
  }
  respParams.error = 'Fatal error: authorization code is incorrect.'
  return res.render('auth/lockscreen', respParams)
})

action(function signout (req, res) {
  if (req.session.user) {
    req.session.destroy()
  }
  res.redirect('/auth/signin')
})

action(function profile (req, res) {
  res.render({
    title: 'Profile',
    profile: _.pick(pkg, 'version', 'description')
  })
})

function loadContributors (fn) {
  if (Array.isArray(contributors)) {
    return fn()
  }
  var contribs = []
  readLines('../THANKS.md', function (data) {
    if (data.indexOf('#') !== 0) {
      contribs.push(data)
    }
  }, function () {
    contribs = contribs.map(function (contrib) {
      let cs = contrib.split(',')
      return {
        nick: cs[0],
        full: cs[1]
      }
    })
    fn(contribs)
  })
}

function readLines (file, onEach, onComplete) {
  var input = fs.createReadStream(path.resolve(__dirname, '../', file))
  var remaining = ''
  input.on('data', function (data) {
    remaining += data
    var index = remaining.indexOf('\n')
    while (index > -1) {
      var line = remaining.substring(0, index)
      remaining = remaining.substring(index + 1)
      onEach(line)
      index = remaining.indexOf('\n')
    }
  })

  input.on('end', function () {
    remaining.length > 0 && onEach(remaining)
    onComplete && onComplete()
  })
}
