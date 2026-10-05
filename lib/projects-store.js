'use strict'

var crypto = require('crypto')
var path = require('path')
var _ = require('lodash')

var userData = require('./user-data')
var projectResolver = require('./project-resolver')
var pm = require('./pm')
var db = require('./db')

function rowToProject (row) {
  if (!row) return null
  var project = {
    id: row.id,
    name: row.name,
    path: row.path,
    type: row.type,
    script: row.script,
    configFile: row.config_file,
    servicePort: row.service_port,
    serviceUrl: row.service_url,
    autoStart: !!row.auto_start,
    addedAt: row.added_at
  }
  try {
    project.appVersion = require('./app-version').readAppVersion(project.path)
  } catch (err) {
    project.appVersion = null
  }
  return project
}

function listProjects () {
  db.open()
  return db.db.prepare('SELECT * FROM projects ORDER BY added_at ASC').all().map(rowToProject)
}

function findProject (id) {
  db.open()
  return rowToProject(db.db.prepare('SELECT * FROM projects WHERE id = ?').get(id))
}

function addProject (folderPath, extras) {
  var resolved = projectResolver.resolveProject(folderPath)
  var absolutePath = path.resolve(folderPath)
  extras = extras || {}
  db.open()

  var appRoot = path.resolve(path.join(__dirname, '..'))
  if (absolutePath === appRoot) {
    throw new Error(
      'Cannot add the pm2-gui install folder itself. ' +
      'It is already running as the dashboard (via synology-start.sh or node pm2-gui.js start). ' +
      'Add other app folders under /volume1/web instead.'
    )
  }

  var existing = db.db.prepare('SELECT * FROM projects WHERE path = ?').get(absolutePath)
  if (existing) {
    var nextPort = extras.servicePort
      ? (parseInt(extras.servicePort, 10) || null)
      : existing.service_port
    var nextUrl = extras.serviceUrl != null && extras.serviceUrl !== ''
      ? extras.serviceUrl
      : existing.service_url
    db.db.prepare(
      'UPDATE projects SET name = ?, type = ?, script = ?, config_file = ?, service_port = ?, service_url = ? WHERE id = ?'
    ).run(
      resolved.name,
      resolved.type,
      resolved.script || null,
      resolved.configFile || null,
      nextPort,
      nextUrl,
      existing.id
    )
    return findProject(existing.id)
  }

  var project = {
    id: crypto.randomUUID(),
    name: resolved.name,
    path: absolutePath,
    type: resolved.type,
    script: resolved.script || null,
    configFile: resolved.configFile || null,
    servicePort: extras.servicePort ? (parseInt(extras.servicePort, 10) || null) : null,
    serviceUrl: extras.serviceUrl || null,
    autoStart: false,
    addedAt: new Date().toISOString()
  }

  db.db.prepare(
    'INSERT INTO projects (id, name, path, type, script, config_file, service_port, service_url, auto_start, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    project.id,
    project.name,
    project.path,
    project.type,
    project.script,
    project.configFile,
    project.servicePort,
    project.serviceUrl,
    0,
    project.addedAt
  )

  return project
}

function setProjectServicePort (id, port) {
  return updateProject(id, { servicePort: port })
}

function updateProject (id, patch) {
  db.open()
  var existing = findProject(id)
  if (!existing) {
    throw new Error('Project not found')
  }
  patch = patch || {}
  var nextName = patch.name != null ? String(patch.name).trim() : existing.name
  if (!nextName) {
    throw new Error('Name is required')
  }
  var nextPort = Object.prototype.hasOwnProperty.call(patch, 'servicePort')
    ? (patch.servicePort == null || patch.servicePort === ''
      ? null
      : (parseInt(patch.servicePort, 10) || null))
    : existing.servicePort

  db.db.prepare(
    'UPDATE projects SET name = ?, service_port = ? WHERE id = ?'
  ).run(nextName, nextPort, id)

  return findProject(id)
}

function removeProject (id) {
  db.open()
  var info = db.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  if (!info.changes) {
    throw new Error('Project not found')
  }
}

function removeProjectByPath (folderPath) {
  if (!folderPath) return false
  db.open()
  var info = db.db.prepare('DELETE FROM projects WHERE path = ?').run(path.resolve(folderPath))
  return info.changes > 0
}

function removeProjectsByPaths (paths) {
  if (!paths || !paths.length) return 0
  db.open()
  var removed = 0
  var del = db.db.prepare('DELETE FROM projects WHERE path = ?')
  paths.forEach(function (p) {
    removed += del.run(path.resolve(p)).changes
  })
  return removed
}

function startProject (project, options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }

  pm.startProject(_.extend({
    project: project
  }, options), fn)
}

function autoStartAll (options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }

  var projects = listProjects().filter(function (p) { return p.autoStart === true })
  if (projects.length === 0) {
    return fn(null, [])
  }

  pm.list(options, function (err, procs) {
    if (err) {
      return fn(err)
    }

    var results = []
    var pending = projects.length
    var hadError = null

    projects.forEach(function (project) {
      var alreadyRunning = _.find(procs, function (proc) {
        var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
        return cwd && path.resolve(cwd) === path.resolve(project.path)
      })

      if (alreadyRunning) {
        results.push({ project: project, status: 'already_running', pm_id: alreadyRunning.pm_id })
        if (--pending === 0) fn(hadError, results)
        return
      }

      startProject(project, options, function (err, proc) {
        if (err) {
          hadError = hadError || err
          results.push({ project: project, status: 'error', error: err.message })
        } else {
          results.push({ project: project, status: 'started', pm_id: proc && proc[0] && proc[0].pm2_env ? proc[0].pm2_env.pm_id : null })
        }
        if (--pending === 0) fn(hadError, results)
      })
    })
  })
}

module.exports = {
  ensureReady: function () {
    userData.ensureUserDataDir()
    db.open()
  },
  getDataDir: userData.getUserDataDir,
  listProjects: listProjects,
  findProject: findProject,
  addProject: addProject,
  setProjectServicePort: setProjectServicePort,
  updateProject: updateProject,
  removeProject: removeProject,
  removeProjectByPath: removeProjectByPath,
  removeProjectsByPaths: removeProjectsByPaths,
  startProject: startProject,
  autoStartAll: autoStartAll
}
