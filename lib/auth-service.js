'use strict'

var crypto = require('crypto')
var bcrypt = require('bcryptjs')
var otplib = require('otplib')
var QRCode = require('qrcode')
var db = require('./db')

var BCRYPT_ROUNDS = 10

function getAuthConfig () {
  db.open()
  var row = db.db.prepare('SELECT * FROM auth_config WHERE id = 1').get()
  return {
    enabled: !!row.enabled,
    require2fa: !!row.require_2fa,
    sessionTimeoutHours: row.session_timeout_hours,
    maxLoginAttempts: row.max_login_attempts,
    lockoutMinutes: row.lockout_minutes,
    hasLegacyToken: !!(row.legacy_token && row.legacy_token.length),
    userCount: db.db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  }
}

function updateAuthConfig (patch) {
  db.open()
  var current = db.db.prepare('SELECT * FROM auth_config WHERE id = 1').get()
  db.db.prepare(
    `UPDATE auth_config SET
      enabled = ?,
      require_2fa = ?,
      session_timeout_hours = ?,
      max_login_attempts = ?,
      lockout_minutes = ?
     WHERE id = 1`
  ).run(
    patch.enabled != null ? (patch.enabled ? 1 : 0) : current.enabled,
    patch.require2fa != null ? (patch.require2fa ? 1 : 0) : current.require_2fa,
    patch.sessionTimeoutHours != null ? parseInt(patch.sessionTimeoutHours, 10) : current.session_timeout_hours,
    patch.maxLoginAttempts != null ? parseInt(patch.maxLoginAttempts, 10) : current.max_login_attempts,
    patch.lockoutMinutes != null ? parseInt(patch.lockoutMinutes, 10) : current.lockout_minutes
  )
  return getAuthConfig()
}

function listUsers () {
  db.open()
  return db.db.prepare(
    'SELECT id, username, totp_enabled AS totpEnabled, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY username'
  ).all().map(function (u) {
    return {
      id: u.id,
      username: u.username,
      totpEnabled: !!u.totpEnabled,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt
    }
  })
}

function findUserByUsername (username) {
  db.open()
  return db.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username)
}

function findUserById (id) {
  db.open()
  return db.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

function createUser (username, password) {
  username = String(username || '').trim()
  if (!username || username.length < 2) {
    throw new Error('Username must be at least 2 characters')
  }
  if (!password || String(password).length < 8) {
    throw new Error('Password must be at least 8 characters')
  }
  if (findUserByUsername(username)) {
    throw new Error('Username already exists')
  }

  var now = new Date().toISOString()
  var user = {
    id: crypto.randomUUID(),
    username: username,
    password_hash: bcrypt.hashSync(String(password), BCRYPT_ROUNDS),
    totp_secret: null,
    totp_enabled: 0,
    created_at: now,
    updated_at: now
  }

  db.db.prepare(
    'INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(user.id, user.username, user.password_hash, null, 0, now, now)

  return {
    id: user.id,
    username: user.username,
    totpEnabled: false,
    createdAt: now
  }
}

function changePassword (userId, currentPassword, newPassword) {
  var user = findUserById(userId)
  if (!user) {
    throw new Error('User not found')
  }
  if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
    throw new Error('Current password is incorrect')
  }
  if (!newPassword || String(newPassword).length < 8) {
    throw new Error('New password must be at least 8 characters')
  }

  db.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(newPassword), BCRYPT_ROUNDS), new Date().toISOString(), userId)
}

function deleteUser (userId) {
  db.open()
  var count = db.db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  if (count <= 1) {
    throw new Error('Cannot delete the last user')
  }
  var info = db.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  if (!info.changes) {
    throw new Error('User not found')
  }
}

function isLocked (username) {
  db.open()
  var row = db.db.prepare('SELECT * FROM login_attempts WHERE username = ? COLLATE NOCASE').get(username)
  if (!row || !row.locked_until) {
    return false
  }
  if (new Date(row.locked_until).getTime() > Date.now()) {
    return true
  }
  db.db.prepare('DELETE FROM login_attempts WHERE username = ? COLLATE NOCASE').run(username)
  return false
}

function recordFailure (username) {
  var config = getAuthConfig()
  db.open()
  var row = db.db.prepare('SELECT * FROM login_attempts WHERE username = ? COLLATE NOCASE').get(username)
  var failures = row ? row.failures + 1 : 1
  var lockedUntil = null
  if (failures >= config.maxLoginAttempts) {
    lockedUntil = new Date(Date.now() + config.lockoutMinutes * 60 * 1000).toISOString()
  }
  db.db.prepare(
    'INSERT INTO login_attempts (username, failures, locked_until) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until'
  ).run(username, failures, lockedUntil)
  return { failures: failures, locked: !!lockedUntil }
}

function clearFailures (username) {
  db.open()
  db.db.prepare('DELETE FROM login_attempts WHERE username = ? COLLATE NOCASE').run(username)
}

function login (username, password, totpCode) {
  var config = getAuthConfig()
  if (!config.enabled) {
    return { ok: true, authDisabled: true }
  }

  username = String(username || '').trim()
  if (isLocked(username)) {
    throw new Error('Account temporarily locked. Try again later.')
  }

  // Legacy token fallback (until a user account is created)
  if (config.userCount === 0) {
    var authRow = db.db.prepare('SELECT legacy_token FROM auth_config WHERE id = 1').get()
    if (authRow && authRow.legacy_token && password === authRow.legacy_token) {
      clearFailures(username || 'legacy')
      return { ok: true, legacy: true }
    }
  }

  var user = findUserByUsername(username)
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    recordFailure(username)
    throw new Error('Invalid username or password')
  }

  if (user.totp_enabled) {
    if (!totpCode) {
      return { ok: false, needs2fa: true, userId: user.id, username: user.username }
    }
    if (!verifyTotp(user.totp_secret, totpCode)) {
      recordFailure(username)
      throw new Error('Invalid authentication code')
    }
  } else if (config.require2fa) {
    // Allow password login once so the user can finish 2FA enrollment in Settings.
    clearFailures(username)
    return {
      ok: true,
      mustSetup2fa: true,
      user: {
        id: user.id,
        username: user.username,
        totpEnabled: false
      }
    }
  }

  clearFailures(username)
  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      totpEnabled: !!user.totp_enabled
    }
  }
}

function verifyTotp (secret, code) {
  if (!secret || !code) return false
  try {
    var result = otplib.verifySync({ token: String(code), secret: secret })
    return !!(result && result.valid)
  } catch (err) {
    return false
  }
}

function beginTotpSetup (userId) {
  var user = findUserById(userId)
  if (!user) {
    throw new Error('User not found')
  }

  var secret = otplib.generateSecret()
  db.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?')
    .run(secret, new Date().toISOString(), userId)

  var otpauth = otplib.generateURI({
    issuer: 'PM2 Monitor',
    label: user.username,
    secret: secret
  })
  return QRCode.toDataURL(otpauth).then(function (qrDataUrl) {
    return {
      secret: secret,
      otpauth: otpauth,
      qrDataUrl: qrDataUrl
    }
  })
}

function confirmTotpSetup (userId, code) {
  var user = findUserById(userId)
  if (!user || !user.totp_secret) {
    throw new Error('2FA setup has not been started')
  }
  if (!verifyTotp(user.totp_secret, code)) {
    throw new Error('Invalid authentication code')
  }
  db.db.prepare('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId)
  return { totpEnabled: true }
}

function disableTotp (userId, password, code) {
  var user = findUserById(userId)
  if (!user) {
    throw new Error('User not found')
  }
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    throw new Error('Password is incorrect')
  }
  if (user.totp_enabled && user.totp_secret && !verifyTotp(user.totp_secret, code)) {
    throw new Error('Invalid authentication code')
  }
  var config = getAuthConfig()
  if (config.require2fa) {
    throw new Error('2FA is required by policy and cannot be disabled')
  }
  db.db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId)
  return { totpEnabled: false }
}

function isAuthenticated (req) {
  var config = getAuthConfig()
  if (!config.enabled) {
    return true
  }
  if (req.session && req.session.userId) {
    return true
  }
  // Legacy session token
  if (req.session && req.session.authorization) {
    var row = db.db.prepare('SELECT legacy_token FROM auth_config WHERE id = 1').get()
    if (row && row.legacy_token && req.session.authorization === row.legacy_token) {
      return true
    }
  }
  // API key (Bearer / X-API-Key) — works even when session auth is enabled
  try {
    var apiKeys = require('./api-keys')
    var keyInfo = apiKeys.authenticateRequest(req)
    if (keyInfo) {
      req.apiKeyAuth = keyInfo
      return true
    }
  } catch (err) {}
  return false
}

/**
 * Require session or API key. Unlike isAuthenticated when auth is disabled,
 * API routes under /api/v1 always require a valid API key (or session).
 */
function requireSessionOrApiKey (req, res, next) {
  if (isAuthenticated(req)) {
    return next()
  }
  return res.status(401).json({
    error: 'Authentication required',
    hint: 'Pass Authorization: Bearer <PM2_GUI_API_KEY> or X-API-Key'
  })
}

/**
 * Strict API-key auth for machine clients. Session cookie also accepted so the
 * Settings UI can call the same endpoints while logged in.
 */
function requireApiAccess (req, res, next) {
  try {
    var apiKeys = require('./api-keys')
    var keyInfo = apiKeys.authenticateRequest(req)
    if (keyInfo) {
      req.apiKeyAuth = keyInfo
      return next()
    }
  } catch (err) {}

  if (req.session && req.session.userId) {
    return next()
  }

  // When auth is disabled, still allow localhost session-less browser use for UI,
  // but machine API callers should send a key once one exists.
  var config = getAuthConfig()
  if (!config.enabled) {
    try {
      var apiKeys2 = require('./api-keys')
      var status = apiKeys2.getStatus()
      if (!status.configured) {
        return next()
      }
    } catch (err) {}
  }

  return res.status(401).json({
    error: 'API key required',
    hint: 'Generate a key in Settings → API, then set PM2_GUI_API_KEY in .env'
  })
}

function requireAuth (req, res, next) {
  if (isAuthenticated(req)) {
    return next()
  }
  if (req.path && (req.path.indexOf('_api') >= 0 || req.path.indexOf('/projects_api') === 0 || req.path.indexOf('/settings_api') === 0 || req.path.indexOf('/api/') === 0)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  return res.redirect('/auth')
}

module.exports = {
  getAuthConfig: getAuthConfig,
  updateAuthConfig: updateAuthConfig,
  listUsers: listUsers,
  createUser: createUser,
  changePassword: changePassword,
  deleteUser: deleteUser,
  login: login,
  beginTotpSetup: beginTotpSetup,
  confirmTotpSetup: confirmTotpSetup,
  disableTotp: disableTotp,
  isAuthenticated: isAuthenticated,
  requireAuth: requireAuth,
  requireSessionOrApiKey: requireSessionOrApiKey,
  requireApiAccess: requireApiAccess,
  findUserById: findUserById
}
