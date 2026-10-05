'use strict'

var fs = require('fs')
var path = require('path')

var cache = Object.create(null)
var CACHE_TTL_MS = 5000

/**
 * Read package.json version for a project directory (cached briefly).
 * @param {string} projectDir
 * @returns {string|null}
 */
function readAppVersion (projectDir) {
  if (!projectDir) return null
  var dir = path.resolve(projectDir)
  var now = Date.now()
  var cached = cache[dir]
  if (cached && (now - cached.at) < CACHE_TTL_MS) {
    return cached.version
  }

  var version = null
  try {
    var pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg && pkg.version) {
        version = String(pkg.version).trim() || null
      }
    }
  } catch (err) {
    version = null
  }

  cache[dir] = { at: now, version: version }
  return version
}

function invalidate (projectDir) {
  if (!projectDir) return
  delete cache[path.resolve(projectDir)]
}

module.exports = {
  readAppVersion: readAppVersion,
  invalidate: invalidate
}
