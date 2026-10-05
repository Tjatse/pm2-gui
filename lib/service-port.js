'use strict'

var fs = require('fs')
var path = require('path')

var db = require('./db')
var projectsStore = require('./projects-store')

/** Synology / system ports that must not be assigned to managed apps. */
var RESERVED_SYSTEM_PORTS = [80, 443, 5000, 5001]

/**
 * Env keys we treat as "listen port" (first match wins for detection priority).
 * Prefer app-specific keys before generic PORT.
 */
var PORT_ENV_KEYS = [
  'SYNC_WEB_PORT',
  'PORT',
  'HTTP_PORT',
  'SERVER_PORT',
  'APP_PORT',
  'WEB_PORT',
  'NODE_PORT'
]

var ENV_FILES = ['.env', '.env.local', '.env.production', '.env.development']
var ECOSYSTEM_FILES = [
  'ecosystem.config.cjs',
  'ecosystem.config.js',
  'ecosystem.config.json'
]

function parsePort (value) {
  var n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    return null
  }
  return n
}

function getPm2GuiPort () {
  try {
    var fromDb = db.getSetting('port', null)
    var parsed = parsePort(fromDb)
    if (parsed) return parsed
  } catch (err) {}
  var fromEnv = parsePort(process.env.PORT)
  if (fromEnv) return fromEnv
  return 8088
}

function readTextIfExists (filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath, 'utf8')
    }
  } catch (err) {}
  return null
}

function parseEnvFilePorts (text) {
  var found = []
  if (!text) return found
  String(text).split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim()
    if (!trimmed || trimmed.charAt(0) === '#') return
    var m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!m) return
    var key = m[1]
    if (PORT_ENV_KEYS.indexOf(key) < 0) return
    var raw = m[2].trim().replace(/^['"]|['"]$/g, '')
    var port = parsePort(raw)
    if (port) {
      found.push({ key: key, port: port })
    }
  })
  return found
}

function parseEcosystemPorts (text) {
  var found = []
  if (!text) return found
  PORT_ENV_KEYS.forEach(function (key) {
    var re = new RegExp(
      '\\b' + key + '\\s*:\\s*(?:[\'"](\\d{1,5})[\'"]|(\\d{1,5}))',
      'g'
    )
    var m
    while ((m = re.exec(text))) {
      var port = parsePort(m[1] || m[2])
      if (port) {
        found.push({ key: key, port: port })
      }
    }
  })
  return found
}

function readLocalSettingsPorts (projectDir) {
  var found = []
  var dbPath = path.join(projectDir, 'data', 'local-settings.db')
  if (!fs.existsSync(dbPath)) return found
  try {
    var Database = require('better-sqlite3')
    var localDb = new Database(dbPath, { readonly: true, fileMustExist: true })
    var rows = []
    try {
      rows = localDb
        .prepare(
          'SELECT key, value FROM env_vars WHERE key IN (' +
            PORT_ENV_KEYS.map(function () { return '?' }).join(',') +
            ')'
        )
        .all(PORT_ENV_KEYS)
    } catch (err2) {
      rows = []
    }
    localDb.close()
    ;(rows || []).forEach(function (row) {
      var port = parsePort(row.value)
      if (port) found.push({ key: row.key, port: port })
    })
  } catch (err) {
    // better-sqlite3 missing or DB unreadable — ignore
  }
  return found
}

/**
 * Detect listen port configured in a project directory.
 * @returns {{ port: number|null, key: string|null, sources: Array }}
 */
function detectPortFromProject (projectDir) {
  var sources = []
  var dir = path.resolve(projectDir || '')

  ENV_FILES.forEach(function (name) {
    var text = readTextIfExists(path.join(dir, name))
    parseEnvFilePorts(text).forEach(function (hit) {
      sources.push({ file: name, key: hit.key, port: hit.port })
    })
  })

  ECOSYSTEM_FILES.forEach(function (name) {
    var text = readTextIfExists(path.join(dir, name))
    parseEcosystemPorts(text).forEach(function (hit) {
      sources.push({ file: name, key: hit.key, port: hit.port })
    })
  })

  readLocalSettingsPorts(dir).forEach(function (hit) {
    sources.push({ file: 'data/local-settings.db', key: hit.key, port: hit.port })
  })

  var preferred = null
  PORT_ENV_KEYS.forEach(function (key) {
    if (preferred) return
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].key === key) {
        preferred = sources[i]
        return
      }
    }
  })

  return {
    port: preferred ? preferred.port : null,
    key: preferred ? preferred.key : null,
    sources: sources
  }
}

function upsertEnvFilePort (filePath, key, port) {
  var text = readTextIfExists(filePath)
  var line = key + '=' + String(port)
  if (text == null) {
    fs.writeFileSync(filePath, line + '\n', 'utf8')
    return { created: true, updated: true, file: path.basename(filePath), key: key }
  }

  var lines = text.split(/\r?\n/)
  var found = false
  var changed = false
  var next = lines.map(function (raw) {
    var trimmed = raw.trim()
    if (!trimmed || trimmed.charAt(0) === '#') return raw
    var m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed)
    if (!m || m[1] !== key) return raw
    found = true
    var replacement = key + '=' + String(port)
    if (raw !== replacement) changed = true
    return replacement
  })

  if (!found) {
    if (next.length && next[next.length - 1] === '') {
      next[next.length - 1] = line
      next.push('')
    } else {
      next.push(line)
    }
    changed = true
  }

  if (changed) {
    fs.writeFileSync(filePath, next.join('\n'), 'utf8')
  }
  return { created: false, updated: changed, file: path.basename(filePath), key: key }
}

function updateEcosystemPort (filePath, keys, port) {
  var text = readTextIfExists(filePath)
  if (text == null) return null
  var changed = false
  var next = text
  keys.forEach(function (key) {
    var re = new RegExp(
      '(\\b' + key + '\\s*:\\s*)([\'"]?)(\\d{1,5})\\2',
      'g'
    )
    next = next.replace(re, function (match, prefix, quote) {
      changed = true
      quote = quote || ''
      return prefix + quote + String(port) + quote
    })
  })
  if (changed) {
    fs.writeFileSync(filePath, next, 'utf8')
  }
  return { updated: changed, file: path.basename(filePath) }
}

function updateLocalSettingsPorts (projectDir, keys, port) {
  var dbPath = path.join(projectDir, 'data', 'local-settings.db')
  if (!fs.existsSync(dbPath)) return null
  try {
    var Database = require('better-sqlite3')
    var localDb = new Database(dbPath)
    var now = new Date().toISOString()
    var upsert = localDb.prepare(
      'INSERT INTO env_vars (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    var updatedKeys = []
    keys.forEach(function (key) {
      upsert.run(key, String(port), now)
      updatedKeys.push(key)
    })
    localDb.close()
    return { updated: updatedKeys.length > 0, file: 'data/local-settings.db', keys: updatedKeys }
  } catch (err) {
    return { updated: false, error: err.message }
  }
}

/**
 * Write `port` into .env / ecosystem / local-settings for keys already used by the project.
 * If the project has no port keys yet, create/update `.env` with PORT=<port>.
 */
function applyPortToProject (projectDir, port) {
  var dir = path.resolve(projectDir)
  var parsed = parsePort(port)
  if (!parsed) {
    throw new Error('Invalid port: ' + port)
  }

  var detected = detectPortFromProject(dir)
  var keys = []
  detected.sources.forEach(function (src) {
    if (keys.indexOf(src.key) < 0) keys.push(src.key)
  })
  if (!keys.length) {
    keys = ['PORT']
  }

  var changes = []
  var envPath = path.join(dir, '.env')
  keys.forEach(function (key) {
    var result = upsertEnvFilePort(envPath, key, parsed)
    if (result.updated) changes.push(result)
  })

  ENV_FILES.forEach(function (name) {
    if (name === '.env') return
    var filePath = path.join(dir, name)
    if (!fs.existsSync(filePath)) return
    keys.forEach(function (key) {
      var result = upsertEnvFilePort(filePath, key, parsed)
      if (result.updated) changes.push(result)
    })
  })

  ECOSYSTEM_FILES.forEach(function (name) {
    var result = updateEcosystemPort(path.join(dir, name), keys, parsed)
    if (result && result.updated) changes.push(result)
  })

  var localResult = updateLocalSettingsPorts(dir, keys, parsed)
  if (localResult && localResult.updated) changes.push(localResult)

  return {
    port: parsed,
    keys: keys,
    changes: changes,
    previous: detected.port
  }
}

/**
 * Map of port → label describing who uses it.
 */
function collectUsedPorts (options) {
  options = options || {}
  var used = {}
  var excludeId = options.excludeProjectId || null
  var excludePath = options.excludePath
    ? path.resolve(options.excludePath)
    : null

  function mark (port, label) {
    var p = parsePort(port)
    if (!p || used[p]) return
    used[p] = label
  }

  RESERVED_SYSTEM_PORTS.forEach(function (p) {
    mark(p, 'system reserved')
  })
  mark(getPm2GuiPort(), 'pm2-gui dashboard')

  try {
    projectsStore.listProjects().forEach(function (project) {
      if (excludeId && project.id === excludeId) return
      if (excludePath && path.resolve(project.path) === excludePath) return
      if (project.servicePort) {
        mark(project.servicePort, 'project "' + project.name + '"')
      }
      try {
        var detected = detectPortFromProject(project.path)
        if (detected.port) {
          mark(detected.port, 'project "' + project.name + '"')
        }
      } catch (err) {}
    })
  } catch (err) {}

  return used
}

/**
 * Validate a requested port is free (or owned by the excluded project).
 * @returns {number} parsed port
 */
function assertPortAvailable (port, options) {
  var parsed = parsePort(port)
  if (!parsed) {
    throw new Error('Invalid port. Enter a number between 1 and 65535.')
  }

  if (RESERVED_SYSTEM_PORTS.indexOf(parsed) >= 0) {
    throw new Error(
      'Port ' + parsed + ' is reserved by the system (80, 443, 5000, 5001). Choose a different port.'
    )
  }

  var used = collectUsedPorts(options || {})
  if (used[parsed]) {
    throw new Error(
      'Port ' + parsed + ' is already used by ' + used[parsed] + '. Choose a different port.'
    )
  }

  return parsed
}

/**
 * Resolve the port to store / apply for create or update.
 *
 * @param {Object} options
 * @param {string|number|null} options.requestedPort - from pm2-gui UI (optional)
 * @param {string} options.projectDir - after merge
 * @param {number|null} [options.existingServicePort] - currently stored for this project
 * @param {string} [options.excludeProjectId]
 * @param {string} [options.excludePath]
 * @returns {{ port: number|null, applied: Object|null, source: string }}
 */
function resolveAndApplyProjectPort (options) {
  options = options || {}
  var projectDir = options.projectDir
  var requestedRaw = options.requestedPort
  var hasRequest = requestedRaw != null && String(requestedRaw).trim() !== ''
  var detected = detectPortFromProject(projectDir)
  var existing = parsePort(options.existingServicePort)

  if (hasRequest) {
    var requested = assertPortAvailable(requestedRaw, {
      excludeProjectId: options.excludeProjectId,
      excludePath: options.excludePath || projectDir
    })
    var applied = applyPortToProject(projectDir, requested)
    return { port: requested, applied: applied, source: 'requested' }
  }

  if (existing) {
    if (detected.port !== existing) {
      var appliedExisting = applyPortToProject(projectDir, existing)
      return { port: existing, applied: appliedExisting, source: 'existing-service-port' }
    }
    return { port: existing, applied: null, source: 'existing-service-port' }
  }

  if (detected.port) {
    return { port: detected.port, applied: null, source: 'detected' }
  }

  return { port: null, applied: null, source: 'none' }
}

module.exports = {
  RESERVED_SYSTEM_PORTS: RESERVED_SYSTEM_PORTS,
  PORT_ENV_KEYS: PORT_ENV_KEYS,
  parsePort: parsePort,
  getPm2GuiPort: getPm2GuiPort,
  detectPortFromProject: detectPortFromProject,
  applyPortToProject: applyPortToProject,
  collectUsedPorts: collectUsedPorts,
  assertPortAvailable: assertPortAvailable,
  resolveAndApplyProjectPort: resolveAndApplyProjectPort
}
