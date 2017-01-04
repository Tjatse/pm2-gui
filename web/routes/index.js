'use strict'

var _ = require('lodash')

var Monitor = require('../../libs/monitor')
var conf = require('../../libs/util/conf')

action(function (req, res) {
  var config = res.locals.config
  var agent = config.agent
  if (agent && agent.authorization && (!req.session.user || agent.authorization !== req.session.user.passwd)) {
    return res.redirect('/auth/signout')
  }
  var q = Monitor.available(_.extend({
    blank: '',
    notFormatName: true
  }, config))
  var connections = []

  q.choices.forEach(function (c) {
    c.value = Monitor.toConnectionString(Monitor.parseConnectionString(c.value))
    connections.push(c)
  })
  res.render('index', {
    title: 'Monitor',
    connections: connections,
    readonly: agent && !!agent.readonly,
    socketConfigs: {
      events: conf.SOCKET_EVENTS,
      namespaces: conf.NSP
    }
  })
})
