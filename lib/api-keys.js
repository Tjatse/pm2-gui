'use strict'

var crypto = require('crypto')
var db = require('./db')

var KEY_PREFIX = 'pm2gui_'

function ensureTable () {
  db.open()
  db.db.exec(
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'default',
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )`
  )
}

function hashKey (rawKey) {
  return crypto.createHash('sha256').update(String(rawKey || ''), 'utf8').digest('hex')
}

function generateRawKey () {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url')
}

function publicKeyInfo (row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    configured: true
  }
}

function listKeys () {
  ensureTable()
  return db.db.prepare(
    'SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
  ).all().map(function (row) {
    return {
      id: row.id,
      name: row.name,
      prefix: row.key_prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || null
    }
  })
}

function getStatus () {
  var keys = listKeys()
  if (!keys.length) {
    return {
      configured: false,
      keys: [],
      header: 'Authorization: Bearer <key>  or  X-API-Key: <key>',
      basePath: '/api/v1'
    }
  }
  return {
    configured: true,
    keys: keys,
    header: 'Authorization: Bearer <key>  or  X-API-Key: <key>',
    basePath: '/api/v1'
  }
}

function createKey (name) {
  ensureTable()
  var raw = generateRawKey()
  var id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')
  var now = new Date().toISOString()
  var prefix = raw.slice(0, 14) + '…'
  db.db.prepare(
    'INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, String(name || 'default').slice(0, 80) || 'default', prefix, hashKey(raw), now)

  return {
    id: id,
    name: String(name || 'default').slice(0, 80) || 'default',
    prefix: prefix,
    createdAt: now,
    apiKey: raw,
    envExample: 'PM2_GUI_API_KEY=' + raw
  }
}

function revokeKey (id) {
  ensureTable()
  var info = db.db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id)
  if (!info) {
    throw new Error('API key not found')
  }
  db.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  return { revoked: true, id: id }
}

function revokeAll () {
  ensureTable()
  db.db.prepare('DELETE FROM api_keys').run()
  return { revoked: true }
}

function extractKeyFromRequest (req) {
  if (!req || !req.headers) return null
  var auth = req.headers.authorization || req.headers.Authorization
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim()
  }
  var headerKey = req.headers['x-api-key'] || req.headers['X-API-Key']
  if (headerKey) return String(headerKey).trim()
  if (req.query && req.query.api_key) return String(req.query.api_key).trim()
  return null
}

function verifyRawKey (rawKey) {
  if (!rawKey) return null
  ensureTable()
  var row = db.db.prepare(
    'SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE key_hash = ?'
  ).get(hashKey(rawKey))
  if (!row) return null
  try {
    db.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id)
  } catch (err) {}
  return publicKeyInfo(row)
}

function authenticateRequest (req) {
  return verifyRawKey(extractKeyFromRequest(req))
}

module.exports = {
  ensureTable: ensureTable,
  listKeys: listKeys,
  getStatus: getStatus,
  createKey: createKey,
  revokeKey: revokeKey,
  revokeAll: revokeAll,
  extractKeyFromRequest: extractKeyFromRequest,
  verifyRawKey: verifyRawKey,
  authenticateRequest: authenticateRequest
}
