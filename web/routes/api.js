'use strict'

var fs = require('fs')
var path = require('path')
var authService = require('../../lib/auth-service')
var apiKeys = require('../../lib/api-keys')
var pm = require('../../lib/pm')
var projectsStore = require('../../lib/projects-store')
var projectUpdate = require('../../lib/project-update')
var settings = require('../../lib/settings')
var setupStatus = require('../../lib/setup-status')
var servicePort = require('../../lib/service-port')

function requireAccess (req, res) {
  var allowed = false
  authService.requireApiAccess(req, res, function () {
    allowed = true
  })
  return allowed
}

function pm2Home (req) {
  return (req._config && req._config.pm2) || process.env.PM2_HOME || null
}

function summarizeProcess (proc) {
  if (!proc) return null
  var env = proc.pm2_env || {}
  return {
    pmId: proc.pm_id,
    name: proc.name,
    pid: proc.pid || null,
    status: env.status || null,
    restarts: env.restart_time || 0,
    uptime: env.pm_uptime || null,
    cwd: env.pm_cwd || null,
    script: env.pm_exec_path || null,
    execMode: env.exec_mode || null,
    port: resolveProcessPortSafe(proc),
    memory: proc.monit && proc.monit.memory,
    cpu: proc.monit && proc.monit.cpu,
    unstableRestarts: env.unstable_restarts || 0,
    outLog: env.pm_out_log_path || null,
    errLog: env.pm_err_log_path || null
  }
}

function resolveProcessPortSafe (proc) {
  try {
    var env = (proc && proc.pm2_env) || {}
    var cwd = env.pm_cwd
    if (cwd && servicePort && typeof servicePort.detectPortFromProject === 'function') {
      var detected = servicePort.detectPortFromProject(cwd)
      if (detected && detected.port != null) return detected.port
    }
    var projects = projectsStore.listProjects()
    var match = projects.find(function (p) {
      return cwd && path.resolve(p.path) === path.resolve(cwd)
    })
    if (match && match.servicePort != null) return match.servicePort
  } catch (err) {}
  return null
}

function readLogTail (filePath, maxLines) {
  maxLines = Math.min(500, Math.max(1, parseInt(maxLines, 10) || 100))
  if (!filePath || !fs.existsSync(filePath)) {
    return { file: filePath || null, exists: false, lines: [] }
  }
  try {
    var text = fs.readFileSync(filePath, 'utf8')
    var lines = text.split(/\r?\n/)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return {
      file: filePath,
      exists: true,
      lines: lines.slice(-maxLines)
    }
  } catch (err) {
    return { file: filePath, exists: true, error: err.message, lines: [] }
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

action('get', 'v1', function api_v1_root (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  res.json({
    name: 'pm2-gui API',
    version: (function () {
      try { return require('../../package.json').version } catch (err) { return null }
    })(),
    basePath: '/api/v1',
    auth: {
      apiKey: !!req.apiKeyAuth,
      session: !!(req.session && req.session.userId)
    },
    endpoints: [
      'GET /api/v1/health',
      'GET /api/v1/status',
      'GET /api/v1/processes',
      'GET /api/v1/processes/:pmId',
      'GET /api/v1/processes/:pmId/logs?lines=100&stream=err|out|both',
      'POST /api/v1/processes/:pmId/actions  { "action": "start|stop|restart|delete" }',
      'GET /api/v1/projects',
      'GET /api/v1/projects/:id',
      'POST /api/v1/projects/:id/start',
      'DELETE /api/v1/projects/:id',
      'GET /api/v1/settings',
      'GET /api/v1/logs/dashboard?lines=100'
    ]
  })
})

action('get', 'v1/health', function api_v1_health (req, res) { // eslint-disable-line camelcase
  // Health is intentionally open so probes work before a key exists.
  var keyStatus = apiKeys.getStatus()
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: (function () {
      try { return require('../../package.json').version } catch (err) { return null }
    })(),
    apiKeyConfigured: keyStatus.configured
  })
})

action('get', 'v1/status', function api_v1_status (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  setupStatus.getSetupStatusAsync({
    pm2: pm2Home(req),
    port: (req._config && req._config.port) || undefined
  }, function (err, status) {
    if (err) return res.status(500).json({ error: err.message })
    res.json(status)
  })
})

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

action('get', 'v1/processes', function api_v1_processes (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  pm.list({ pm2Home: pm2Home(req) }, function (err, procs) {
    if (err) return res.status(500).json({ error: err.message })
    var list = (procs || []).map(function (proc) {
      return summarizeProcess(proc)
    })
    res.json({ count: list.length, processes: list })
  })
})

action('get', 'v1/processes/:pmId', function api_v1_process_get (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  pm._findById({ id: req.params.pmId, pm2: pm2Home(req) }, function (err, proc) {
    if (err) return res.status(500).json({ error: err.message })
    if (!proc) return res.status(404).json({ error: 'Process not found' })
    var summary = summarizeProcess(proc)
    summary.pm2_env = proc.pm2_env || null
    summary.monit = proc.monit || null
    res.json({ process: summary })
  })
})

action('get', 'v1/processes/:pmId/logs', function api_v1_process_logs (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  var lines = req.query.lines
  var stream = String(req.query.stream || 'both').toLowerCase()
  pm._findById({ id: req.params.pmId, pm2: pm2Home(req) }, function (err, proc) {
    if (err) return res.status(500).json({ error: err.message })
    if (!proc) return res.status(404).json({ error: 'Process not found' })
    var env = proc.pm2_env || {}
    var result = {
      pmId: proc.pm_id,
      name: proc.name,
      status: env.status || null
    }
    if (stream === 'out' || stream === 'both') {
      result.out = readLogTail(env.pm_out_log_path, lines)
    }
    if (stream === 'err' || stream === 'both') {
      result.err = readLogTail(env.pm_err_log_path, lines)
    }
    res.json(result)
  })
})

action('post', 'v1/processes/:pmId/actions', function api_v1_process_action (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  if (req._config && req._config.readonly) {
    return res.status(403).json({ error: 'Server is in readonly mode.' })
  }
  var body = req.body || {}
  var actionName = String(body.action || '').toLowerCase()
  if (['start', 'stop', 'restart', 'delete'].indexOf(actionName) < 0) {
    return res.status(400).json({
      error: 'Invalid action',
      allowed: ['start', 'stop', 'restart', 'delete']
    })
  }
  pm.action({
    action: actionName,
    id: req.params.pmId,
    pm2Home: pm2Home(req),
    pm2: pm2Home(req)
  }, function (err, result) {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, action: actionName, pmId: req.params.pmId, result: result || null })
  })
})

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

action('get', 'v1/projects', function api_v1_projects (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  var projects = projectsStore.listProjects()
  res.json({
    dataDir: projectsStore.getDataDir(),
    count: projects.length,
    projects: projects
  })
})

action('get', 'v1/projects/:id', function api_v1_project_get (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  var project = projectsStore.findProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ project: project })
})

action('post', 'v1/projects/:id/start', function api_v1_project_start (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  if (req._config && req._config.readonly) {
    return res.status(403).json({ error: 'Server is in readonly mode.' })
  }
  var project = projectsStore.findProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  projectsStore.startProject(project, { pm2Home: pm2Home(req) }, function (err, proc) {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, project: project, process: summarizeProcess(proc) })
  })
})

action('delete', 'v1/projects/:id', function api_v1_project_delete (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  if (req._config && req._config.readonly) {
    return res.status(403).json({ error: 'Server is in readonly mode.' })
  }
  try {
    projectsStore.removeProject(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// Settings / logs
// ---------------------------------------------------------------------------

action('get', 'v1/settings', function api_v1_settings (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  var all = settings.getSettings()
  delete all.session_secret
  res.json({
    settings: all,
    auth: authService.getAuthConfig(),
    api: apiKeys.getStatus(),
    port: (req._config && req._config.port) || null,
    dataDir: projectsStore.getDataDir()
  })
})

action('get', 'v1/logs/dashboard', function api_v1_dashboard_logs (req, res) { // eslint-disable-line camelcase
  if (!requireAccess(req, res)) return
  try {
    var lines = Math.min(500, Math.max(1, parseInt(req.query.lines, 10) || 100))
    res.json(projectUpdate.getDashboardLogTail(lines))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
