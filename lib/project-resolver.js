'use strict'

var fs = require('fs')
var path = require('path')

var ECOSYSTEM_FILES = [
  'ecosystem.config.js',
  'ecosystem.config.cjs',
  'ecosystem.config.mjs',
  'process.config.js',
  'process.json',
  'pm2.config.js'
]

var SCRIPT_CANDIDATES = [
  'index.js',
  'app.js',
  'server.js',
  'main.js',
  'bin/www'
]

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * Resolve how PM2 should start a project in the given folder.
 * @param {String} folderPath
 * @returns {{ type: string, name: string, cwd: string, script?: string, configFile?: string }}
 */
function resolveProject (folderPath) {
  folderPath = path.resolve(folderPath)
  if (!fs.existsSync(folderPath)) {
    throw new Error('Folder does not exist: ' + folderPath)
  }
  if (!fs.statSync(folderPath).isDirectory()) {
    throw new Error('Path is not a directory: ' + folderPath)
  }

  var name = path.basename(folderPath)

  for (var i = 0; i < ECOSYSTEM_FILES.length; i++) {
    var configFile = path.join(folderPath, ECOSYSTEM_FILES[i])
    if (fs.existsSync(configFile)) {
      return {
        type: 'ecosystem',
        name: name,
        cwd: folderPath,
        configFile: configFile
      }
    }
  }

  var packagePath = path.join(folderPath, 'package.json')
  if (fs.existsSync(packagePath)) {
    var pkg = readJson(packagePath)
    name = pkg.name || name
    if (pkg.main) {
      return {
        type: 'script',
        name: sanitizeName(name),
        cwd: folderPath,
        script: pkg.main
      }
    }
  }

  for (var j = 0; j < SCRIPT_CANDIDATES.length; j++) {
    var candidate = path.join(folderPath, SCRIPT_CANDIDATES[j])
    if (fs.existsSync(candidate)) {
      return {
        type: 'script',
        name: sanitizeName(name),
        cwd: folderPath,
        script: SCRIPT_CANDIDATES[j]
      }
    }
  }

  var jsFiles = fs.readdirSync(folderPath).filter(function (file) {
    return file.endsWith('.js') && fs.statSync(path.join(folderPath, file)).isFile()
  })
  if (jsFiles.length === 1) {
    return {
      type: 'script',
      name: sanitizeName(name),
      cwd: folderPath,
      script: jsFiles[0]
    }
  }

  throw new Error('No PM2 entry point found in ' + folderPath + '. Add ecosystem.config.js, process.json, package.json with main, or a single .js file.')
}

function sanitizeName (name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

module.exports = {
  resolveProject: resolveProject,
  ECOSYSTEM_FILES: ECOSYSTEM_FILES,
  SCRIPT_CANDIDATES: SCRIPT_CANDIDATES
}
