'use strict'

var fs = require('fs')
var path = require('path')
var Database = require('better-sqlite3')
var userData = require('./user-data')

var db = null

var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    type TEXT,
    script TEXT,
    config_file TEXT,
    service_port INTEGER,
    service_url TEXT,
    auto_start INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    require_2fa INTEGER NOT NULL DEFAULT 0,
    session_timeout_hours INTEGER NOT NULL DEFAULT 24,
    max_login_attempts INTEGER NOT NULL DEFAULT 5,
    lockout_minutes INTEGER NOT NULL DEFAULT 15,
    legacy_token TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    bot_token TEXT,
    chat_id TEXT,
    notify_restart INTEGER NOT NULL DEFAULT 1,
    notify_error INTEGER NOT NULL DEFAULT 1,
    notify_stop INTEGER NOT NULL DEFAULT 1,
    notify_exit INTEGER NOT NULL DEFAULT 1,
    notify_online INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    username TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'default',
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`
]

var DEFAULT_SETTINGS = {
  refresh: '5s',
  process_refresh: '3s',
  readonly: false,
  debug_enabled: false,
  public_host: '',
  public_protocol: 'http',
  projects_root: '/volume1/web',
  log_dir: './logs',
  log_prefix: true,
  log_date: false,
  log_level: 'info',
  origins: '*:*'
}

function getDbPath () {
  return path.join(userData.getUserDataDir(), 'pm2-gui.sqlite')
}

function open () {
  if (db) {
    return db
  }

  userData.ensureUserDataDir()
  var file = getDbPath()
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  SCHEMA.forEach(function (sql) {
    db.exec(sql)
  })

  ensureDefaults()
  migrateFromLegacyFiles()

  return db
}

function ensureDefaults () {
  var now = new Date().toISOString()
  var insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
  )

  Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
    insertSetting.run(key, JSON.stringify(DEFAULT_SETTINGS[key]), now)
  })

  db.prepare(
    'INSERT OR IGNORE INTO auth_config (id, enabled, require_2fa, session_timeout_hours, max_login_attempts, lockout_minutes) VALUES (1, 0, 0, 24, 5, 15)'
  ).run()

  db.prepare(
    'INSERT OR IGNORE INTO telegram_config (id, enabled, bot_token, chat_id, notify_restart, notify_error, notify_stop, notify_exit, notify_online) VALUES (1, 0, NULL, NULL, 1, 1, 1, 1, 0)'
  ).run()
}

function migrateFromLegacyFiles () {
  migrateProjectsJson()
  migrateIniHints()
}

function migrateProjectsJson () {
  var projectsFile = userData.getProjectsFile()
  if (!fs.existsSync(projectsFile)) {
    return
  }

  var count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c
  if (count > 0) {
    return
  }

  try {
    var raw = JSON.parse(fs.readFileSync(projectsFile, 'utf8') || '{}')
    var projects = raw.projects || []
    var insert = db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, path, type, script, config_file, service_port, service_url, auto_start, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )

    var tx = db.transaction(function (rows) {
      rows.forEach(function (p) {
        insert.run(
          p.id,
          p.name,
          p.path,
          p.type || null,
          p.script || null,
          p.configFile || null,
          p.servicePort || null,
          p.serviceUrl || null,
          p.autoStart === false ? 0 : 1,
          p.addedAt || new Date().toISOString()
        )
      })
    })
    tx(projects)

    if (projects.length) {
      console.info('[db] Migrated', projects.length, 'project(s) from projects.json')
    }
  } catch (err) {
    console.warn('[db] Could not migrate projects.json:', err.message)
  }
}

function migrateIniHints () {
  try {
    var iniPath = path.resolve(__dirname, '..', 'pm2-gui.ini')
    if (!fs.existsSync(iniPath)) {
      return
    }
    var text = fs.readFileSync(iniPath, 'utf8')
    var hostMatch = text.match(/^\s*public_host\s*=\s*(.+)$/m)
    var protoMatch = text.match(/^\s*public_protocol\s*=\s*(.+)$/m)
    var tokenMatch = text.match(/^\s*;?\s*authorization\s*=\s*(.+)$/m)

    var currentHost = getSetting('public_host')
    if ((!currentHost || currentHost === '') && hostMatch) {
      var host = hostMatch[1].trim()
      if (host && host.charAt(0) !== ';') {
        setSetting('public_host', host)
      }
    }

    if (protoMatch) {
      var proto = protoMatch[1].trim()
      if (proto && proto.charAt(0) !== ';') {
        setSetting('public_protocol', proto)
      }
    }

    if (tokenMatch) {
      var token = tokenMatch[1].trim()
      if (token && token.charAt(0) !== ';' && token !== 'AuTh') {
        db.prepare('UPDATE auth_config SET legacy_token = ? WHERE id = 1 AND (legacy_token IS NULL OR legacy_token = \'\')').run(token)
      }
    }
  } catch (err) {
    console.warn('[db] Could not migrate ini hints:', err.message)
  }
}

function getSetting (key, fallback) {
  open()
  var row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) {
    return fallback
  }
  try {
    return JSON.parse(row.value)
  } catch (err) {
    return row.value
  }
}

function setSetting (key, value) {
  open()
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(value), new Date().toISOString())
}

function getAllSettings () {
  open()
  var rows = db.prepare('SELECT key, value FROM settings').all()
  var out = {}
  rows.forEach(function (row) {
    try {
      out[row.key] = JSON.parse(row.value)
    } catch (err) {
      out[row.key] = row.value
    }
  })
  return out
}

function close () {
  if (db) {
    db.close()
    db = null
  }
}

module.exports = {
  open: open,
  close: close,
  getDbPath: getDbPath,
  getSetting: getSetting,
  setSetting: setSetting,
  getAllSettings: getAllSettings,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  get db () {
    return open()
  }
}
