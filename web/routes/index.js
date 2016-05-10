var _ = require('lodash')
var Monitor = require('../../lib/monitor')

// Authorization
action(function auth (req, res) {
  if (!req._config.agent || (req._config.agent.authorization === req.session['authorization'])) {
    return res.redirect('/')
  }
  res.render('auth', {
    title: 'Authorization'
  })
})

// Index
action(function (req, res) {
  if (req._config.agent && (req._config.agent.authorization !== req.session['authorization'])) {
    return res.redirect('/auth')
  }
  var options = _.clone(req._config)
  var q = Monitor.available(_.extend(options, {
    blank: '&nbsp;'
  }))
  var connections = []

  q.choices.forEach(function (c) {
    c.value = Monitor.toConnectionString(Monitor.parseConnectionString(c.value))
    connections.push(c)
  })
  res.render('index', {
    title: 'Monitor',
    connections: connections,
    readonly: !!req._config.readonly
  })
})

// API
action(function auth_api (req, res) { // eslint-disable-line camelcase
  if (!req._config.agent || !req._config.agent.authorization) {
    return res.json({
      error: 'Can not found agent[.authorization] config, no need to authorize!'
    })
  }
  if (!req.query || !req.query.authorization) {
    return res.json({
      error: 'Authorization is required!'
    })
  }

  if (req._config.agent && req.query.authorization === req._config.agent.authorization) {
    req.session['authorization'] = req.query.authorization
    return res.json({
      status: 200
    })
  }
  return res.json({
    error: 'Failed, authorization is incorrect.'
  })
})
