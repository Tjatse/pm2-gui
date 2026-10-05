'use strict'

var fs = require('fs')
var path = require('path')

var pm = require('./pm')
var projectsStore = require('./projects-store')
var servicePort = require('./service-port')

var ECOSYSTEM_FILES = [
  'ecosystem.config.cjs',
  'ecosystem.config.js',
  'ecosystem.config.json'
]

function sanitizeProcessName (name) {
  var cleaned = String(name || '').trim().replace(/\s+/g, ' ')
  if (!cleaned) {
    throw new Error('Name is required')
  }
  if (cleaned.length > 120) {
    throw new Error('Name must be 120 characters or fewer')
  }
  if (!/^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]*$/.test(cleaned)) {
    throw new Error('Name has invalid characters')
  }
  return cleaned
}

function readTextIfExists (filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath, 'utf8')
    }
  } catch (err) {}
  return null
}

/**
 * Update `name: "..."` in ecosystem configs (PM2 app name).
 */
function applyNameToProjectFiles (projectDir, name) {
  var dir = path.resolve(projectDir)
  var changes = []

  ECOSYSTEM_FILES.forEach(function (fileName) {
    var filePath = path.join(dir, fileName)
    var text = readTextIfExists(filePath)
    if (text == null) return

    var changed = false
    var next = text.replace(
      /(\bname\s*:\s*)(['"])([^'"]*)\2/g,
      function (match, prefix, quote, oldName) {
        // Skip package-like fields that aren't the PM2 app name when multiple name keys exist.
        // Prefer replacing all string `name:` entries in ecosystem files — typical configs have one.
        if (oldName === name) return match
        changed = true
        return prefix + quote + name + quote
      }
    )

    if (changed) {
      fs.writeFileSync(filePath, next, 'utf8')
      changes.push({ file: fileName, field: 'name' })
    }
  })

  return changes
}

function resolveEditTarget (options, fn) {
  options = options || {}
  var pm2Home = options.pm2Home

  if (options.projectId) {
    var project = projectsStore.findProject(options.projectId)
    if (!project) {
      return fn(new Error('Saved project not found'))
    }
    return pm.list({ pm2Home: pm2Home }, function (err, procs) {
      if (err) return fn(err)
      var proc = (procs || []).find(function (p) {
        var cwd = p.pm2_env && p.pm2_env.pm_cwd
        return cwd && path.resolve(cwd) === path.resolve(project.path)
      }) || null
      fn(null, {
        project: project,
        process: proc,
        pmId: proc ? proc.pm_id : null,
        targetDir: path.resolve(project.path),
        wasOnline: !!(proc && proc.pm2_env && proc.pm2_env.status === 'online')
      })
    })
  }

  if (options.pmId == null || options.pmId === '') {
    return fn(new Error('projectId or pmId is required'))
  }

  pm.list({ pm2Home: pm2Home }, function (err, procs) {
    if (err) return fn(err)
    var proc = (procs || []).find(function (p) {
      return String(p.pm_id) === String(options.pmId)
    })
    if (!proc) {
      return fn(new Error('Process not found: ' + options.pmId))
    }
    var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
    if (!cwd) {
      return fn(new Error('Process has no working directory'))
    }
    var targetDir = path.resolve(cwd)
    var project = projectsStore.listProjects().find(function (p) {
      return path.resolve(p.path) === targetDir
    }) || null
    fn(null, {
      project: project,
      process: proc,
      pmId: proc.pm_id,
      targetDir: targetDir,
      wasOnline: !!(proc.pm2_env && proc.pm2_env.status === 'online')
    })
  })
}

/**
 * Edit process/project name and/or service port, update files, restart via PM2.
 *
 * @param {Object} options
 * @param {String} [options.projectId]
 * @param {Number|String} [options.pmId]
 * @param {String} options.name
 * @param {String|Number|null} [options.servicePort] blank keeps current
 * @param {String} [options.pm2Home]
 * @param {Function} fn
 */
function applyProcessEdit (options, fn) {
  options = options || {}

  var newName
  try {
    newName = sanitizeProcessName(options.name)
  } catch (nameErr) {
    return fn(nameErr)
  }

  resolveEditTarget(options, function (err, target) {
    if (err) return fn(err)

    var steps = []
    var currentPort = (target.project && target.project.servicePort) ||
      servicePort.detectPortFromProject(target.targetDir).port ||
      null

    var portRaw = options.servicePort
    var hasPort = portRaw != null && String(portRaw).trim() !== ''
    var desiredPort = currentPort

    try {
      if (hasPort) {
        desiredPort = servicePort.assertPortAvailable(portRaw, {
          excludeProjectId: target.project && target.project.id,
          excludePath: target.targetDir
        })
        if (desiredPort !== currentPort) {
          var applied = servicePort.applyPortToProject(target.targetDir, desiredPort)
          steps.push({ step: 'port', port: desiredPort, applied: applied })
        } else {
          steps.push({ step: 'port', port: desiredPort, unchanged: true })
        }
      } else if (currentPort) {
        desiredPort = currentPort
        steps.push({ step: 'port', port: desiredPort, unchanged: true })
      } else {
        desiredPort = null
        steps.push({ step: 'port', port: null, unchanged: true })
      }
    } catch (portErr) {
      return fn(portErr)
    }

    var nameChanges = applyNameToProjectFiles(target.targetDir, newName)
    steps.push({ step: 'name-files', changes: nameChanges })

    var project = target.project
    try {
      if (project) {
        project = projectsStore.updateProject(project.id, {
          name: newName,
          servicePort: desiredPort
        })
      } else {
        project = projectsStore.addProject(target.targetDir, {
          servicePort: desiredPort
        })
        if (project.name !== newName) {
          project = projectsStore.updateProject(project.id, {
            name: newName,
            servicePort: desiredPort
          })
        }
      }
      steps.push({ step: 'register', projectId: project.id, name: project.name })
    } catch (storeErr) {
      return fn(storeErr)
    }

    function restartProcess () {
      projectsStore.startProject(project, { pm2Home: options.pm2Home }, function (startErr, proc) {
        if (startErr) {
          steps.push({ step: 'start', error: startErr.message })
          return fn(null, {
            ok: true,
            warning: 'Saved but could not restart: ' + startErr.message,
            project: project,
            steps: steps
          })
        }
        steps.push({ step: 'start', result: { method: 'startProject' } })
        fn(null, {
          ok: true,
          project: project,
          process: proc,
          restarted: true,
          steps: steps
        })
      })
    }

    if (target.pmId == null) {
      return restartProcess()
    }

    pm.action({
      action: 'delete',
      id: target.pmId,
      pm2: options.pm2Home
    }, function (delErr) {
      steps.push({
        step: 'delete-old',
        pmId: target.pmId,
        error: delErr ? delErr.message : null
      })
      restartProcess()
    })
  })
}

module.exports = {
  sanitizeProcessName: sanitizeProcessName,
  applyNameToProjectFiles: applyNameToProjectFiles,
  applyProcessEdit: applyProcessEdit
}
