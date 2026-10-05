'use strict'

var fs = require('fs')
var path = require('path')
var { execFile, spawn } = require('child_process')
var AdmZip = require('adm-zip')

var pm = require('./pm')
var projectsStore = require('./projects-store')
var servicePort = require('./service-port')

var APP_ROOT = path.resolve(__dirname, '..')
var MAX_TOTAL_BYTES = 200 * 1024 * 1024
var INSTALL_TIMEOUT_MS = 10 * 60 * 1000

var EXCLUDED_NAME_RE = /^(node_modules|\.git|\.svn|\.hg|logs?|\.DS_Store|Thumbs\.db|\.next|\.nuxt|\.cache|coverage|\.turbo|\.vercel|data)$/i

function isExcludedRelPath (relPath) {
  var parts = String(relPath || '').replace(/\\/g, '/').split('/')
  return parts.some(function (part) {
    return !part ||
      EXCLUDED_NAME_RE.test(part) ||
      /\.sqlite$/i.test(part) ||
      /\.db$/i.test(part) ||
      /\.db-(journal|wal|shm)$/i.test(part)
  })
}

function assertSafeTargetDir (targetDir) {
  var resolved = path.resolve(targetDir)
  if (!path.isAbsolute(resolved)) {
    throw new Error('Project path must be absolute')
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Project directory does not exist: ' + resolved)
  }
  if (resolved === APP_ROOT || resolved.indexOf(APP_ROOT + path.sep) === 0) {
    throw new Error('Refusing to update the pm2-gui install directory')
  }
  return resolved
}

function safeJoin (root, relPath) {
  var cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.indexOf('\0') >= 0) {
    throw new Error('Invalid relative path')
  }
  if (isExcludedRelPath(cleaned)) {
    return null
  }
  var dest = path.resolve(root, cleaned)
  var rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (dest !== root && dest.indexOf(rootWithSep) !== 0) {
    throw new Error('Path escapes project root: ' + relPath)
  }
  return dest
}

function resolveUpdateTarget (options, fn) {
  options = options || {}
  var pm2Home = options.pm2Home

  if (options.projectId) {
    var project = projectsStore.findProject(options.projectId)
    if (!project) {
      return fn(new Error('Saved project not found'))
    }
    try {
      var dir = assertSafeTargetDir(project.path)
      return findRunningByPath(dir, pm2Home, function (err, proc) {
        if (err) return fn(err)
        fn(null, {
          targetDir: dir,
          project: project,
          pmId: proc ? proc.pm_id : null,
          process: proc || null
        })
      })
    } catch (err) {
      return fn(err)
    }
  }

  if (options.pmId == null || options.pmId === '') {
    return fn(new Error('projectId or pmId is required'))
  }

  pm._findById({ id: options.pmId, pm2: pm2Home }, function (err, proc) {
    if (err) return fn(err)
    if (!proc) return fn(new Error('Process not found'))
    var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
    if (!cwd) return fn(new Error('Process has no pm_cwd; cannot update'))
    try {
      var targetDir = assertSafeTargetDir(cwd)
      var matched = projectsStore.listProjects().find(function (p) {
        return path.resolve(p.path) === targetDir
      }) || null
      fn(null, {
        targetDir: targetDir,
        project: matched,
        pmId: proc.pm_id,
        process: proc
      })
    } catch (assertErr) {
      fn(assertErr)
    }
  })
}

function findRunningByPath (targetDir, pm2Home, fn) {
  pm.list({ pm2Home: pm2Home }, function (err, procs) {
    if (err) return fn(err)
    var proc = (procs || []).find(function (p) {
      var cwd = p && p.pm2_env && p.pm2_env.pm_cwd
      return cwd && path.resolve(cwd) === targetDir
    }) || null
    fn(null, proc)
  })
}

function stopIfRunning (target, pm2Home, fn) {
  if (!target.process || !target.process.pm2_env) {
    return fn(null, { stopped: false })
  }
  if (target.process.pm2_env.status !== 'online') {
    return fn(null, { stopped: false, status: target.process.pm2_env.status })
  }
  pm.action({
    action: 'stop',
    id: target.pmId,
    pm2: pm2Home
  }, function (err) {
    if (err) return fn(err)
    fn(null, { stopped: true, pmId: target.pmId })
  })
}

function mergeUploadedFiles (targetDir, files, fields) {
  var written = []
  var totalBytes = 0
  var relPaths = fields && fields.paths
    ? [].concat(fields.paths)
    : null

  files.forEach(function (file, index) {
    totalBytes += file.size || 0
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Upload exceeds ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + ' MB limit')
    }

    var rel = (relPaths && relPaths[index]) || file.originalname || file.fieldname
    rel = String(rel || '').replace(/\\/g, '/')
    // Strip a single top-level folder prefix if present (folder picker often includes it)
    if (fields && fields.stripPrefix) {
      var prefix = String(fields.stripPrefix).replace(/\\/g, '/').replace(/\/?$/, '/')
      if (rel.indexOf(prefix) === 0) {
        rel = rel.slice(prefix.length)
      }
    }

    var dest = safeJoin(targetDir, rel)
    if (!dest) return

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(file.path, dest)
    written.push(rel)
  })

  return { written: written, totalBytes: totalBytes }
}

function mergeZipArchive (targetDir, zipPath) {
  var zip = new AdmZip(zipPath)
  var entries = zip.getEntries()
  var written = []
  var totalBytes = 0

  var fileRels = entries
    .filter(function (entry) { return !entry.isDirectory })
    .map(function (entry) { return entry.entryName.replace(/^\/+/, '') })
    .filter(Boolean)

  var stripPrefix = ''
  if (fileRels.length) {
    var top = fileRels[0].split('/')[0]
    var wrapped = top && fileRels.every(function (rel) {
      return rel === top || rel.indexOf(top + '/') === 0
    }) && fileRels.some(function (rel) {
      return rel.indexOf('/') >= 0
    })
    if (wrapped) stripPrefix = top + '/'
  }

  entries.forEach(function (entry) {
    if (entry.isDirectory) return
    var rel = entry.entryName.replace(/^\/+/, '')
    if (stripPrefix && rel.indexOf(stripPrefix) === 0) {
      rel = rel.slice(stripPrefix.length)
    }
    if (!rel) return
    var dest = safeJoin(targetDir, rel)
    if (!dest) return

    totalBytes += entry.header.size || 0
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Archive exceeds ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + ' MB limit')
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.getData())
    written.push(rel)
  })

  return { written: written, totalBytes: totalBytes }
}

function detectPackageManager (targetDir) {
  if (fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) {
    return { bin: 'pnpm', args: ['install', '--prod'] }
  }

  // package.json "packageManager": "pnpm@..."
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'))
    if (pkg && typeof pkg.packageManager === 'string' && pkg.packageManager.indexOf('pnpm') === 0) {
      return { bin: 'pnpm', args: ['install', '--prod'] }
    }
  } catch (err) {}

  if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) {
    return { bin: 'yarn', args: ['install', '--production'] }
  }

  return { bin: 'npm', args: ['install', '--omit=dev'] }
}

/**
 * Always run install after upload when package.json is present (create + update).
 * Chooses pnpm / yarn / npm from lockfiles and packageManager field.
 *
 * For pnpm: install with --ignore-scripts first, then run postinstall / prisma generate
 * separately so Synology failures surface real prisma errors (not a blank "exit null").
 */
function installDepsAfterUpload (targetDir, fn) {
  var pkgPath = path.join(targetDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return fn(null, { skipped: true, reason: 'no package.json' })
  }

  var mgr = detectPackageManager(targetDir)
  var installEnv = Object.assign({}, process.env, {
    // Non-interactive: pnpm otherwise aborts removing node_modules without a TTY
    CI: process.env.CI || 'true',
    PNPM_CONFIRM_MODULES_PURGE: 'false',
    npm_config_engine_strict: 'false',
    PNPM_CONFIG_ENGINE_STRICT: 'false'
  })

  var installArgs = mgr.args.slice()
  var runScriptsAfter = false
  if (mgr.bin === 'pnpm') {
    // --no-frozen-lockfile: uploaded package.json/lockfile may include new deps;
    // CI=true would otherwise freeze and refuse to update the tree.
    // engine-strict=false: NAS pnpm (often 11) must still install apps pinned to pnpm 12.
    installArgs = [
      'install',
      '--prod',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--config.engine-strict=false'
    ]
    runScriptsAfter = true
  }

  console.info(
    '[project-update] installing deps in %s: %s %s',
    targetDir,
    mgr.bin,
    installArgs.join(' ')
  )

  execFile(mgr.bin, installArgs, {
    cwd: targetDir,
    timeout: INSTALL_TIMEOUT_MS,
    env: installEnv,
    maxBuffer: 10 * 1024 * 1024
  }, function (err, stdout, stderr) {
    if (err) {
      var out = [String(stderr || ''), String(stdout || '')].join('\n').trim()
      var errLines = out.split(/\r?\n/).filter(function (line) {
        return /ERR_PNPM_|ERR!|error |failed/i.test(line)
      })
      var detail = errLines.length
        ? errLines.slice(-12).join('\n')
        : out.slice(-1200)
      console.error('[project-update] %s install failed in %s', mgr.bin, targetDir)
      console.error(out.slice(-4000) || err.message)
      return fn(new Error(
        mgr.bin + ' install failed: ' + (err.message || '') +
        (detail ? '\n' + detail : '')
      ))
    }

    if (!runScriptsAfter) {
      return fn(null, {
        skipped: false,
        command: mgr.bin + ' ' + installArgs.join(' '),
        stdoutTail: String(stdout || '').slice(-400)
      })
    }

    runProjectPostInstall(targetDir, installEnv, function (scriptErr, scriptInfo) {
      if (scriptErr) return fn(scriptErr)
      fn(null, {
        skipped: false,
        command: mgr.bin + ' ' + installArgs.join(' '),
        stdoutTail: String(stdout || '').slice(-400),
        postinstall: scriptInfo
      })
    })
  })
}

function hasVendoredPrismaClient (targetDir) {
  var markers = [
    path.join(targetDir, 'src', 'generated', 'prisma', 'client.js'),
    path.join(targetDir, 'src', 'generated', 'prisma', 'client.ts'),
    path.join(targetDir, 'src', 'generated', 'prisma', 'index.js'),
    path.join(targetDir, 'dist', 'generated', 'prisma', 'client.js'),
    path.join(targetDir, 'dist', 'generated', 'prisma', 'index.js')
  ]
  return markers.some(function (marker) {
    return fs.existsSync(marker)
  })
}

function runProjectPostInstall (targetDir, installEnv, fn) {
  var generateScript = path.join(targetDir, 'scripts', 'prisma-generate.mjs')
  var pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'))
  } catch (err) {
    return fn(null, { skipped: true, reason: 'no package.json for scripts' })
  }

  var hasPostinstall = !!(pkg.scripts && pkg.scripts.postinstall)
  if (!hasPostinstall && !fs.existsSync(generateScript)) {
    return fn(null, { skipped: true, reason: 'no postinstall' })
  }

  var cmd
  var args
  if (fs.existsSync(generateScript)) {
    cmd = process.execPath
    args = [generateScript]
  } else {
    cmd = 'pnpm'
    args = ['run', 'postinstall']
  }

  console.info('[project-update] running postinstall in %s: %s %s', targetDir, cmd, args.join(' '))
  execFile(cmd, args, {
    cwd: targetDir,
    timeout: INSTALL_TIMEOUT_MS,
    env: installEnv,
    maxBuffer: 10 * 1024 * 1024
  }, function (err, stdout, stderr) {
    var out = [String(stderr || ''), String(stdout || '')].join('\n').trim()
    if (out) {
      console.error('[project-update] postinstall output:\n%s', out.slice(-4000))
    }
    if (err) {
      if (hasVendoredPrismaClient(targetDir)) {
        console.warn(
          '[project-update] postinstall failed but vendored Prisma client present — continuing:\n%s',
          (out || err.message).slice(-800)
        )
        return runOptionalNativeEnsure(targetDir, installEnv, function (nativeErr, nativeInfo) {
          if (nativeErr) {
            console.warn('[project-update] native ensure after vendored prisma:', nativeErr.message)
          }
          fn(null, {
            command: cmd + ' ' + args.join(' '),
            warned: true,
            stdoutTail: String(stdout || '').slice(-400),
            native: nativeInfo || null
          })
        })
      }
      return fn(new Error(
        'postinstall failed: ' + (err.message || '') +
        (out ? '\n' + out.slice(-1200) : '')
      ))
    }

    // When prisma-generate.mjs was used alone, still run ensure-natives if present.
    if (fs.existsSync(generateScript)) {
      return runOptionalNativeEnsure(targetDir, installEnv, function (nativeErr, nativeInfo) {
        if (nativeErr) return fn(nativeErr)
        fn(null, {
          command: cmd + ' ' + args.join(' '),
          stdoutTail: String(stdout || '').slice(-400),
          native: nativeInfo || null
        })
      })
    }

    fn(null, {
      command: cmd + ' ' + args.join(' '),
      stdoutTail: String(stdout || '').slice(-400)
    })
  })
}

function runOptionalNativeEnsure (targetDir, installEnv, fn) {
  var ensureScript = path.join(targetDir, 'scripts', 'ensure-natives.mjs')
  if (!fs.existsSync(ensureScript)) {
    return fn(null, { skipped: true, reason: 'no ensure-natives.mjs' })
  }
  console.info('[project-update] ensuring native prebuilds in %s', targetDir)
  execFile(process.execPath, [ensureScript], {
    cwd: targetDir,
    timeout: INSTALL_TIMEOUT_MS,
    env: installEnv,
    maxBuffer: 10 * 1024 * 1024
  }, function (err, stdout, stderr) {
    var out = [String(stderr || ''), String(stdout || '')].join('\n').trim()
    if (out) {
      console.error('[project-update] ensure-natives output:\n%s', out.slice(-4000))
    }
    if (err) {
      return fn(new Error(
        'ensure-natives failed: ' + (err.message || '') +
        (out ? '\n' + out.slice(-1200) : '')
      ))
    }
    fn(null, {
      command: process.execPath + ' ' + ensureScript,
      stdoutTail: String(stdout || '').slice(-400)
    })
  })
}

function startAfterUpdate (target, pm2Home, fn) {
  // After file + dependency updates, prefer a clean start from the saved project
  // (ecosystem/script) so new packages and env are picked up.
  function startFromProject () {
    if (!target.project) {
      return fn(new Error('No saved project available to start after update'))
    }
    projectsStore.startProject(target.project, { pm2Home: pm2Home }, function (err, proc) {
      if (err) return fn(err)
      fn(null, { method: 'startProject', process: proc })
    })
  }

  if (target.pmId != null) {
    return pm.action({
      action: 'delete',
      id: target.pmId,
      pm2Home: pm2Home,
      pm2: pm2Home
    }, function (delErr) {
      if (delErr) {
        console.warn('[project-update] delete before restart:', delErr.message)
      }
      if (target.project) {
        return startFromProject()
      }
      // No saved project — try starting the previous pm id, then fail clearly.
      return pm.action({
        action: 'start',
        id: target.pmId,
        pm2Home: pm2Home,
        pm2: pm2Home
      }, function (err) {
        if (err) return fn(err)
        fn(null, { method: 'pm.start', pmId: target.pmId })
      })
    })
  }

  if (target.project) {
    return startFromProject()
  }

  fn(new Error('No saved project or pm id available to start after update'))
}

/**
 * Apply an uploaded update (multipart files and/or a .zip archive).
 * @param {Object} options
 * @param {String} [options.projectId]
 * @param {Number|String} [options.pmId]
 * @param {String} [options.pm2Home]
 * @param {Array} options.files multer file objects
 * @param {Object} options.fields form fields (paths[], stripPrefix, archive handled via files)
 * @param {Function} fn
 */
function applyUpdate (options, fn) {
  options = options || {}
  var files = options.files || []
  var fields = options.fields || {}

  if (!files.length) {
    return fn(new Error('No files uploaded'))
  }

  resolveUpdateTarget(options, function (err, target) {
    if (err) return fn(err)

    var steps = []

    stopIfRunning(target, options.pm2Home, function (stopErr, stopInfo) {
      if (stopErr) return fn(stopErr)
      steps.push({ step: 'stop', result: stopInfo })

      var mergeResult
      try {
        var zipFile = files.find(function (f) {
          return f.fieldname === 'archive' || /\.zip$/i.test(f.originalname || '')
        })
        if (zipFile && (files.length === 1 || zipFile.fieldname === 'archive')) {
          mergeResult = mergeZipArchive(target.targetDir, zipFile.path)
        } else {
          mergeResult = mergeUploadedFiles(target.targetDir, files, fields)
        }
        steps.push({
          step: 'merge',
          filesWritten: mergeResult.written.length,
          bytes: mergeResult.totalBytes
        })
      } catch (mergeErr) {
        return fn(mergeErr)
      }

      var portResult
      try {
        portResult = servicePort.resolveAndApplyProjectPort({
          requestedPort: fields.servicePort,
          projectDir: target.targetDir,
          existingServicePort: target.project && target.project.servicePort,
          excludeProjectId: target.project && target.project.id,
          excludePath: target.targetDir
        })
        if (portResult.port != null && target.project && target.project.id) {
          projectsStore.setProjectServicePort(target.project.id, portResult.port)
          target.project = projectsStore.findProject(target.project.id) || target.project
        } else if (portResult.port != null && !target.project) {
          // Process without saved project — register path with port if we can
          try {
            target.project = projectsStore.addProject(target.targetDir, {
              servicePort: portResult.port
            })
          } catch (regErr) {
            console.warn('[project-update] could not register port for process:', regErr.message)
          }
        }
        steps.push({
          step: 'port',
          port: portResult.port,
          source: portResult.source,
          applied: portResult.applied
        })
      } catch (portErr) {
        return fn(portErr)
      }

      installDepsAfterUpload(target.targetDir, function (installErr, installInfo) {
        if (installErr) {
          return fn(installErr)
        }
        steps.push({ step: 'install', result: installInfo })

        startAfterUpdate(target, options.pm2Home, function (startErr, startInfo) {
          if (startErr) {
            return fn(startErr)
          }
          steps.push({ step: 'start', result: startInfo })
          fn(null, {
            ok: true,
            targetDir: target.targetDir,
            projectId: target.project && target.project.id,
            pmId: target.pmId,
            steps: steps
          })
        })
      })
    })
  })
}

function cleanupFiles (files) {
  ;(files || []).forEach(function (file) {
    if (file && file.path) {
      try {
        fs.unlinkSync(file.path)
      } catch (err) {}
    }
  })
}

function sanitizeProjectFolderName (name) {
  var cleaned = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() || ''
  cleaned = cleaned.replace(/^\.+/, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Invalid project folder name')
  }
  if (!/^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]{0,120}$/.test(cleaned)) {
    throw new Error('Project folder name has invalid characters: ' + cleaned)
  }
  return cleaned
}

function assertProjectsRoot (rootPath) {
  var resolved = path.resolve(String(rootPath || '').trim())
  if (!path.isAbsolute(resolved)) {
    throw new Error('Default projects path must be an absolute path')
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Default projects path does not exist: ' + resolved)
  }
  if (resolved === APP_ROOT || resolved.indexOf(APP_ROOT + path.sep) === 0) {
    throw new Error('Default projects path cannot be the pm2-gui install directory')
  }
  return resolved
}

/**
 * Create a new project under settings.projects_root from an uploaded laptop folder.
 * If the target folder already exists (e.g. a previous failed add), stop any PM2
 * process using it, wipe the folder, and recreate from the upload.
 */
function createFromUpload (options, fn) {
  options = options || {}
  var files = options.files || []
  var fields = options.fields || {}
  var pm2Home = options.pm2Home
  var settings = require('./settings').getSettings()
  var steps = []

  if (!files.length) {
    return fn(new Error('No files uploaded'))
  }

  var folderName
  try {
    folderName = sanitizeProjectFolderName(fields.folderName || fields.name)
  } catch (nameErr) {
    return fn(nameErr)
  }

  var root
  try {
    root = assertProjectsRoot(settings.projects_root || '')
  } catch (rootErr) {
    return fn(rootErr)
  }

  var targetDir = path.join(root, folderName)
  if (targetDir === APP_ROOT || targetDir.indexOf(APP_ROOT + path.sep) === 0) {
    return fn(new Error('Refusing to create a project inside the pm2-gui install directory'))
  }

  // Validate requested port before wiping / writing anything
  if (fields.servicePort != null && String(fields.servicePort).trim() !== '') {
    try {
      servicePort.assertPortAvailable(fields.servicePort, { excludePath: targetDir })
    } catch (portErr) {
      return fn(portErr)
    }
  }

  function continueAfterPrepare () {
    try {
      fs.mkdirSync(targetDir, { recursive: true })
    } catch (mkdirErr) {
      return fn(new Error('Could not create project directory: ' + mkdirErr.message))
    }

    var mergeResult
    try {
      var zipFile = files.find(function (f) {
        return f.fieldname === 'archive' || /\.zip$/i.test(f.originalname || '')
      })
      if (zipFile && (files.length === 1 || zipFile.fieldname === 'archive')) {
        mergeResult = mergeZipArchive(targetDir, zipFile.path)
      } else {
        mergeResult = mergeUploadedFiles(targetDir, files, fields)
      }
      steps.push({
        step: 'merge',
        filesWritten: mergeResult.written.length,
        bytes: mergeResult.totalBytes,
        targetDir: targetDir
      })
    } catch (mergeErr) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true })
      } catch (rmErr) {}
      return fn(mergeErr)
    }

    var portResult
    try {
      // Prefer existing registered project for this path (overwrite case)
      var existingProject = null
      try {
        existingProject = projectsStore.listProjects().find(function (p) {
          return path.resolve(p.path) === path.resolve(targetDir)
        }) || null
      } catch (listErr) {}

      portResult = servicePort.resolveAndApplyProjectPort({
        requestedPort: fields.servicePort,
        projectDir: targetDir,
        existingServicePort: existingProject && existingProject.servicePort,
        excludeProjectId: existingProject && existingProject.id,
        excludePath: targetDir
      })
      steps.push({
        step: 'port',
        port: portResult.port,
        source: portResult.source,
        applied: portResult.applied
      })
    } catch (portErr) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true })
      } catch (rmErr) {}
      return fn(portErr)
    }

    var hasPackageJson = fs.existsSync(path.join(targetDir, 'package.json'))
    installDepsAfterUpload(targetDir, function (installErr, installInfo) {
      if (installErr) {
        return fn(installErr)
      }
      steps.push({ step: 'install', result: installInfo, hadPackageJson: hasPackageJson })

      var extras = {}
      if (portResult.port != null) {
        extras.servicePort = portResult.port
      }
      if (fields.serviceUrl) {
        extras.serviceUrl = String(fields.serviceUrl)
      }

      var project
      try {
        project = projectsStore.addProject(targetDir, extras)
      } catch (addErr) {
        return fn(addErr)
      }
      steps.push({ step: 'register', projectId: project.id, name: project.name })

      var shouldStart = fields.start !== '0' && fields.start !== 'false' && fields.start !== false
      if (!shouldStart) {
        return fn(null, {
          ok: true,
          targetDir: targetDir,
          project: project,
          steps: steps
        })
      }

      projectsStore.startProject(project, { pm2Home: pm2Home }, function (startErr, proc) {
        if (startErr) {
          steps.push({ step: 'start', error: startErr.message })
          return fn(null, {
            ok: true,
            warning: 'Project saved but could not start: ' + startErr.message,
            targetDir: targetDir,
            project: project,
            steps: steps
          })
        }
        steps.push({ step: 'start', result: { method: 'startProject' } })
        fn(null, {
          ok: true,
          targetDir: targetDir,
          project: project,
          process: proc,
          steps: steps
        })
      })
    })
  }

  if (!fs.existsSync(targetDir)) {
    return continueAfterPrepare()
  }

  // Overwrite leftover / previous folder (failed add, re-upload, etc.)
  findRunningByPath(path.resolve(targetDir), pm2Home, function (findErr, proc) {
    if (findErr) {
      // Still attempt wipe — folder may exist without a usable PM2 daemon
      console.warn('[project-update] createFromUpload findRunning:', findErr.message)
    }

    function wipeAndContinue () {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true })
        steps.push({ step: 'overwrite', targetDir: targetDir, wiped: true })
      } catch (wipeErr) {
        return fn(new Error(
          'Project folder already exists and could not be overwritten: ' +
          targetDir + ' (' + wipeErr.message + ')'
        ))
      }
      continueAfterPrepare()
    }

    if (proc && proc.pm2_env && proc.pm2_env.status === 'online') {
      pm.action({
        action: 'delete',
        id: proc.pm_id,
        pm2: pm2Home
      }, function (stopErr) {
        if (stopErr) {
          console.warn('[project-update] createFromUpload stop before overwrite:', stopErr.message)
        }
        steps.push({
          step: 'stop_before_overwrite',
          pmId: proc.pm_id,
          error: stopErr ? stopErr.message : null
        })
        wipeAndContinue()
      })
      return
    }

    wipeAndContinue()
  })
}

function isExcludedSelfRelPath (relPath) {
  // Keep pattern local so a partial deploy can't leave a missing top-level binding.
  var selfExcludeRe = /^(node_modules|\.git|\.svn|\.hg|logs?|\.DS_Store|Thumbs\.db|\.next|\.nuxt|\.cache|coverage|\.turbo|\.vercel|data|\.pm2-gui-boot\.env|pm2-gui\.log|pm2-gui\.pid)$/i
  var parts = String(relPath || '').replace(/\\/g, '/').split('/')
  return parts.some(function (part) {
    return !part || selfExcludeRe.test(part) || /\.sqlite$/i.test(part)
  })
}

function safeJoinSelf (root, relPath) {
  var cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.indexOf('\0') >= 0) {
    throw new Error('Invalid relative path')
  }
  if (isExcludedSelfRelPath(cleaned)) {
    return null
  }
  var dest = path.resolve(root, cleaned)
  var rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (dest !== root && dest.indexOf(rootWithSep) !== 0) {
    throw new Error('Path escapes project root: ' + relPath)
  }
  return dest
}

function mergeUploadedFilesSelf (targetDir, files, fields) {
  var written = []
  var totalBytes = 0
  var relPaths = fields && fields.paths
    ? [].concat(fields.paths)
    : null

  files.forEach(function (file, index) {
    totalBytes += file.size || 0
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Upload exceeds ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + ' MB limit')
    }

    var rel = (relPaths && relPaths[index]) || file.originalname || file.fieldname
    rel = String(rel || '').replace(/\\/g, '/')
    if (fields && fields.stripPrefix) {
      var prefix = String(fields.stripPrefix).replace(/\\/g, '/').replace(/\/?$/, '/')
      if (rel.indexOf(prefix) === 0) {
        rel = rel.slice(prefix.length)
      }
    }

    var dest = safeJoinSelf(targetDir, rel)
    if (!dest) return

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(file.path, dest)
    written.push(rel)
  })

  return { written: written, totalBytes: totalBytes }
}

function mergeZipArchiveSelf (targetDir, zipPath) {
  var zip = new AdmZip(zipPath)
  var entries = zip.getEntries()
  var written = []
  var totalBytes = 0

  var fileRels = entries
    .filter(function (entry) { return !entry.isDirectory })
    .map(function (entry) { return entry.entryName.replace(/^\/+/, '') })
    .filter(Boolean)

  var stripPrefix = ''
  if (fileRels.length) {
    var top = fileRels[0].split('/')[0]
    var wrapped = top && fileRels.every(function (rel) {
      return rel === top || rel.indexOf(top + '/') === 0
    }) && fileRels.some(function (rel) {
      return rel.indexOf('/') >= 0
    })
    if (wrapped) stripPrefix = top + '/'
  }

  entries.forEach(function (entry) {
    if (entry.isDirectory) return
    var rel = entry.entryName.replace(/^\/+/, '')
    if (stripPrefix && rel.indexOf(stripPrefix) === 0) {
      rel = rel.slice(stripPrefix.length)
    }
    if (!rel || isExcludedSelfRelPath(rel)) return
    var dest = safeJoinSelf(targetDir, rel)
    if (!dest) return

    totalBytes += entry.header.size || 0
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Archive exceeds ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + ' MB limit')
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.getData())
    written.push(rel)
  })

  return { written: written, totalBytes: totalBytes }
}

function scheduleDashboardRestart () {
  var script = path.join(APP_ROOT, 'synology-start.sh')
  if (!fs.existsSync(script)) {
    throw new Error('synology-start.sh not found at ' + script)
  }
  console.info('[self-update] scheduling synology-start.sh restart in 800ms')
  setTimeout(function () {
    try {
      var child = spawn('sh', [script, 'restart'], {
        cwd: APP_ROOT,
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      child.unref()
    } catch (err) {
      console.error('[self-update] failed to spawn restart:', err.message)
    }
  }, 800)
}

/**
 * Soft dependency install for pm2-gui self-update.
 * Synology typically has no `make`/`g++`, so rebuilding better-sqlite3 fails.
 * Uploads already skip node_modules, so existing native binaries are preserved.
 * Always use --ignore-scripts; never run package install hooks.
 */
function installDepsAfterSelfUpdate (targetDir, fn) {
  var pkgPath = path.join(targetDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return fn(null, { skipped: true, reason: 'no package.json' })
  }

  var mgr = detectPackageManager(targetDir)
  var args
  if (mgr.bin === 'pnpm') {
    args = [
      'install',
      '--prod',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--config.engine-strict=false'
    ]
  } else if (mgr.bin === 'yarn') {
    args = ['install', '--production', '--ignore-scripts']
  } else {
    args = ['install', '--omit=dev', '--ignore-scripts']
  }

  var installEnv = Object.assign({}, process.env, {
    CI: process.env.CI || 'true',
    PNPM_CONFIRM_MODULES_PURGE: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_engine_strict: 'false',
    PNPM_CONFIG_ENGINE_STRICT: 'false'
  })

  console.info(
    '[self-update] soft install (ignore-scripts, preserve native modules): %s %s',
    mgr.bin,
    args.join(' ')
  )

  execFile(mgr.bin, args, {
    cwd: targetDir,
    timeout: INSTALL_TIMEOUT_MS,
    env: installEnv,
    maxBuffer: 10 * 1024 * 1024
  }, function (err, stdout, stderr) {
    if (err) {
      var out = [String(stderr || ''), String(stdout || '')].join('\n').trim()
      console.error('[self-update] soft install failed in %s', targetDir)
      console.error(out.slice(-4000) || err.message)
      // If native modules already exist, still allow restart — code merge already applied.
      var sqliteOk = fs.existsSync(path.join(targetDir, 'node_modules', 'better-sqlite3'))
      if (sqliteOk) {
        console.warn('[self-update] continuing despite install errors (better-sqlite3 present)')
        return fn(null, {
          skipped: false,
          warned: true,
          command: mgr.bin + ' ' + args.join(' '),
          error: err.message,
          stdoutTail: String(stdout || '').slice(-400)
        })
      }
      return fn(new Error(
        mgr.bin + ' install failed: ' + (err.message || '') +
        (out ? '\n' + out.slice(-1200) : '') +
        '\nSynology cannot rebuild better-sqlite3 without make/g++. ' +
        'Keep existing node_modules and retry, or install build tools.'
      ))
    }

    // Optional lightweight postinstall (user data dir) — pure JS, no native rebuild.
    var post = path.join(targetDir, 'scripts', 'postinstall.js')
    if (fs.existsSync(post)) {
      try {
        execFile(process.execPath, [post], {
          cwd: targetDir,
          timeout: 30000,
          env: installEnv
        }, function () {
          fn(null, {
            skipped: false,
            command: mgr.bin + ' ' + args.join(' '),
            stdoutTail: String(stdout || '').slice(-400)
          })
        })
        return
      } catch (postErr) {}
    }

    fn(null, {
      skipped: false,
      command: mgr.bin + ' ' + args.join(' '),
      stdoutTail: String(stdout || '').slice(-400)
    })
  })
}

/**
 * Overwrite the pm2-gui install directory from an uploaded laptop folder/zip,
 * soft-install deps without rebuilding native modules, then restart via synology-start.sh.
 */
function applySelfUpdate (options, fn) {
  options = options || {}
  var files = options.files || []
  var fields = options.fields || {}
  var steps = []

  if (!files.length) {
    return fn(new Error('No files uploaded'))
  }

  var mergeResult
  try {
    var zipFile = files.find(function (f) {
      return f.fieldname === 'archive' || /\.zip$/i.test(f.originalname || '')
    })
    if (zipFile && (files.length === 1 || zipFile.fieldname === 'archive')) {
      mergeResult = mergeZipArchiveSelf(APP_ROOT, zipFile.path)
    } else {
      mergeResult = mergeUploadedFilesSelf(APP_ROOT, files, fields)
    }
    steps.push({
      step: 'merge',
      filesWritten: mergeResult.written.length,
      bytes: mergeResult.totalBytes,
      targetDir: APP_ROOT
    })
  } catch (mergeErr) {
    return fn(mergeErr)
  }

  installDepsAfterSelfUpdate(APP_ROOT, function (installErr, installInfo) {
    if (installErr) {
      return fn(installErr)
    }
    steps.push({ step: 'install', result: installInfo })

    try {
      scheduleDashboardRestart()
      steps.push({ step: 'restart', scheduled: true, script: 'synology-start.sh restart' })
    } catch (restartErr) {
      return fn(restartErr)
    }

    fn(null, {
      ok: true,
      targetDir: APP_ROOT,
      restarting: true,
      message: 'pm2-gui updated. Restarting dashboard via synology-start.sh…',
      steps: steps
    })
  })
}

function getDashboardLogTail (lineCount) {
  lineCount = Math.max(1, Math.min(500, parseInt(lineCount, 10) || 100))
  var candidates = [
    path.join(APP_ROOT, 'pm2-gui.log'),
    path.join(APP_ROOT, 'logs', 'pm2-gui.err'),
    path.join(APP_ROOT, 'logs', 'pm2-gui.out')
  ]

  var chosen = null
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      chosen = candidates[i]
      break
    }
  }

  if (!chosen) {
    return {
      path: null,
      lines: [],
      text: '(no log file found — expected ' + path.join(APP_ROOT, 'pm2-gui.log') + ')',
      lineCount: 0
    }
  }

  var raw = fs.readFileSync(chosen, 'utf8')
  var allLines = raw.split(/\r?\n/)
  if (allLines.length && allLines[allLines.length - 1] === '') {
    allLines.pop()
  }
  var lines = allLines.slice(-lineCount)
  return {
    path: chosen,
    lines: lines,
    text: lines.join('\n'),
    lineCount: lines.length
  }
}

module.exports = {
  MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
  EXCLUDED_NAME_RE: EXCLUDED_NAME_RE,
  isExcludedRelPath: isExcludedRelPath,
  resolveUpdateTarget: resolveUpdateTarget,
  applyUpdate: applyUpdate,
  applySelfUpdate: applySelfUpdate,
  getDashboardLogTail: getDashboardLogTail,
  createFromUpload: createFromUpload,
  cleanupFiles: cleanupFiles,
  assertSafeTargetDir: assertSafeTargetDir,
  sanitizeProjectFolderName: sanitizeProjectFolderName,
  APP_ROOT: APP_ROOT
}
