#!/usr/bin/env node
'use strict'

var userData = require('../lib/user-data')
var db = require('../lib/db')

try {
  var dir = userData.ensureUserDataDir()
  db.open()
  console.log('[pm2-gui] User data directory ready:', dir)
  console.log('[pm2-gui] SQLite database ready:', db.getDbPath())
} catch (err) {
  console.warn('[pm2-gui] Could not initialize user data directory:', err.message)
  process.exit(0)
}
