'use strict'

var fs = require('fs')
var os = require('os')
var path = require('path')

var APP_NAME = 'pm2-gui'

/**
 * Resolve per-user application data directory (created on install/first run).
 * macOS:   ~/Library/Application Support/pm2-gui
 * Linux:   ~/.local/share/pm2-gui  (or $XDG_DATA_HOME/pm2-gui)
 * Windows: %LOCALAPPDATA%\pm2-gui
 */
function getUserDataDir () {
  var home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME)
  }
  var dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(dataHome, APP_NAME)
}

function getProjectsFile () {
  return path.join(getUserDataDir(), 'projects.json')
}

function getUserMetaFile () {
  return path.join(getUserDataDir(), 'user.json')
}

function ensureUserDataDir () {
  var dir = getUserDataDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  var metaPath = getUserMetaFile()
  if (!fs.existsSync(metaPath)) {
    var user = os.userInfo()
    fs.writeFileSync(metaPath, JSON.stringify({
      username: user.username,
      uid: user.uid,
      createdAt: new Date().toISOString(),
      dataDir: dir
    }, null, 2))
  }

  var projectsPath = getProjectsFile()
  if (!fs.existsSync(projectsPath)) {
    fs.writeFileSync(projectsPath, JSON.stringify({
      version: 1,
      projects: []
    }, null, 2))
  }

  return dir
}

module.exports = {
  APP_NAME: APP_NAME,
  getUserDataDir: getUserDataDir,
  getProjectsFile: getProjectsFile,
  getUserMetaFile: getUserMetaFile,
  ensureUserDataDir: ensureUserDataDir
}
