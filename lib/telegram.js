'use strict'

var https = require('https')
var http = require('http')
var db = require('./db')

function getConfig () {
  db.open()
  var row = db.db.prepare('SELECT * FROM telegram_config WHERE id = 1').get()
  return {
    enabled: !!row.enabled,
    botToken: row.bot_token || '',
    chatId: row.chat_id || '',
    notifyRestart: !!row.notify_restart,
    notifyError: !!row.notify_error,
    notifyStop: !!row.notify_stop,
    notifyExit: !!row.notify_exit,
    notifyOnline: !!row.notify_online,
    configured: !!(row.bot_token && row.chat_id)
  }
}

function updateConfig (patch) {
  db.open()
  var current = db.db.prepare('SELECT * FROM telegram_config WHERE id = 1').get()
  db.db.prepare(
    `UPDATE telegram_config SET
      enabled = ?,
      bot_token = ?,
      chat_id = ?,
      notify_restart = ?,
      notify_error = ?,
      notify_stop = ?,
      notify_exit = ?,
      notify_online = ?
     WHERE id = 1`
  ).run(
    patch.enabled != null ? (patch.enabled ? 1 : 0) : current.enabled,
    patch.botToken != null ? String(patch.botToken).trim() : current.bot_token,
    patch.chatId != null ? String(patch.chatId).trim() : current.chat_id,
    patch.notifyRestart != null ? (patch.notifyRestart ? 1 : 0) : current.notify_restart,
    patch.notifyError != null ? (patch.notifyError ? 1 : 0) : current.notify_error,
    patch.notifyStop != null ? (patch.notifyStop ? 1 : 0) : current.notify_stop,
    patch.notifyExit != null ? (patch.notifyExit ? 1 : 0) : current.notify_exit,
    patch.notifyOnline != null ? (patch.notifyOnline ? 1 : 0) : current.notify_online
  )
  return getConfig()
}

function sendMessage (text, fn) {
  var config = getConfig()
  if (!config.enabled || !config.botToken || !config.chatId) {
    if (fn) fn(null, { skipped: true })
    return
  }

  var payload = JSON.stringify({
    chat_id: config.chatId,
    text: text,
    disable_web_page_preview: true
  })

  var url = new URL('https://api.telegram.org/bot' + config.botToken + '/sendMessage')
  var transport = url.protocol === 'https:' ? https : http
  var req = transport.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 10000
  }, function (res) {
    var body = ''
    res.on('data', function (chunk) { body += chunk })
    res.on('end', function () {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (fn) fn(null, { ok: true })
      } else {
        var err = new Error('Telegram API error: HTTP ' + res.statusCode + ' ' + body.slice(0, 200))
        console.warn('[telegram]', err.message)
        if (fn) fn(err)
      }
    })
  })

  req.on('error', function (err) {
    console.warn('[telegram]', err.message)
    if (fn) fn(err)
  })
  req.write(payload)
  req.end()
}

function notifyProcessEvent (eventName, processInfo) {
  var config = getConfig()
  if (!config.enabled) {
    return
  }

  var map = {
    restart: config.notifyRestart,
    errored: config.notifyError,
    error: config.notifyError,
    stop: config.notifyStop,
    exit: config.notifyExit,
    online: config.notifyOnline
  }

  if (!map[eventName]) {
    return
  }

  var name = (processInfo && processInfo.name) || 'unknown'
  var pmId = processInfo && processInfo.pm_id != null ? processInfo.pm_id : '?'
  var host = require('os').hostname()
  var lines = [
    'PM2 Monitor alert',
    'Host: ' + host,
    'Event: ' + eventName,
    'Process: ' + name + ' (id ' + pmId + ')',
    'Time: ' + new Date().toISOString()
  ]

  sendMessage(lines.join('\n'))
}

function sendTest (fn) {
  sendMessage('PM2 Monitor test message from ' + require('os').hostname() + ' at ' + new Date().toISOString(), fn)
}

module.exports = {
  getConfig: getConfig,
  updateConfig: updateConfig,
  sendMessage: sendMessage,
  notifyProcessEvent: notifyProcessEvent,
  sendTest: sendTest
}
