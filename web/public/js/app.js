;(function () {
  'use strict'
  var NSP = {
    SYS: '/system',
    LOG: '/log',
    PROCESS: '/proccess'
  }

  var EVENTS = {
    ERROR: 'error',
    CONNECT: 'connect',
    CONNECT_ERROR: 'connect_error',
    DISCONNECT: 'disconnect',
    DATA: 'data',
    DATA_PROCESSES: 'data.processes',
    DATA_SYSTEM_STATS: 'data.sysstat',
    DATA_PM2_VERSION: 'data.pm2version',
    DATA_ACTION: 'data.action',
    DATA_USAGE: 'data.usage',
    PULL_LOGS: 'pull.log',
    PULL_LOGS_END: 'pull.log_end',
    PULL_USAGE: 'pull.usage',
    PULL_PROCESSES: 'pull.processes',
    PULL_ACTION: 'pull.action'
  }

  var CONNECT_TIMEOUT_MS = 8000

  // Same glyph as toolbar #self-update-btn (download-to-tray / update from laptop)
  var UPDATE_FROM_LAPTOP_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M8 11l4 4 4-4"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M4 19h16"/>' +
    '</svg>'

  var state = {
    sysStat: null,
    processes: [],
    sockets: {},
    selectedProc: null,
    monitorData: [],
    logAutoScroll: true,
    connected: false,
    connectionValue: null,
    connectTimer: null,
    setupData: null,
    savedProjects: [],
    projectsLoading: false,
    browsingFolder: false,
    startup: null,
    updating: false,
    confirmResolver: null,
    promptResolver: null,
    folderPickResolver: null,
    folderPickBound: false,
    folderPickSourceKey: null,
    folderPickAskPort: false,
    uploadSelectionCache: {}
  }

  var els = {}

  boot()

  function boot () {
    try {
      document.documentElement.dataset.pm2guiBoot = 'starting'
      init()
      document.documentElement.dataset.pm2guiBoot = 'done'
    } catch (err) {
      document.documentElement.dataset.pm2guiBoot = 'error'
      document.documentElement.dataset.pm2guiError = err.message
      cacheElements()
      showSetupModal('Dashboard failed to start: ' + err.message)
    }
  }

  function init () {
    cacheElements()

    if (typeof io === 'undefined') {
      showFatal('Socket.IO client failed to load. Restart pm2-gui and reload this page.')
      return
    }

    bindUI()

    if (!Array.isArray(window.GUI.connections) || window.GUI.connections.length === 0) {
      showSetupModal('No monitoring agent is configured.')
      return
    }

    var connection = window.GUI.connections[window.GUI.connections.length - 1]
    if (els.agentSelect) {
      els.agentSelect.addEventListener('change', function () {
        reconnect(els.agentSelect.value)
      })
      connection = window.GUI.connections.find(function (c) {
        return c.value === els.agentSelect.value
      }) || connection
    }

    loadSetupStatus()
    loadSavedProjects()
    connectAll(connection.value)
  }

  function cacheElements () {
    els = {
      pm2Version: document.getElementById('pm2-version'),
      statHostname: document.getElementById('stat-hostname'),
      statPlatform: document.getElementById('stat-platform'),
      statCpu: document.getElementById('stat-cpu'),
      statCpuBar: document.getElementById('stat-cpu-bar'),
      statMemory: document.getElementById('stat-memory'),
      statMemoryBar: document.getElementById('stat-memory-bar'),
      statUptime: document.getElementById('stat-uptime'),
      statProcesses: document.getElementById('stat-processes'),
      processCount: document.getElementById('process-count'),
      processList: document.getElementById('process-list'),
      toastContainer: document.getElementById('toast-container'),
      modal: document.getElementById('process-modal'),
      modalTitle: document.getElementById('modal-title'),
      modalSubtitle: document.getElementById('modal-subtitle'),
      modalInfo: document.getElementById('modal-info'),
      modalLog: document.getElementById('modal-log'),
      monitorChart: document.getElementById('monitor-chart'),
      agentSelect: document.getElementById('agent-select'),
      setupModal: document.getElementById('setup-modal'),
      setupSummary: document.getElementById('setup-summary'),
      setupStatus: document.getElementById('setup-status'),
      setupSteps: document.getElementById('setup-steps'),
      setupRetry: document.getElementById('setup-retry'),
      setupCopy: document.getElementById('setup-copy'),
      addProjectBtn: document.getElementById('add-project-btn'),
      startProjectsBtn: document.getElementById('start-projects-btn'),
      addProjectModal: document.getElementById('add-project-modal'),
      addProjectPath: document.getElementById('add-project-path'),
      addProjectBrowse: document.getElementById('add-project-browse'),
      addProjectSubmit: document.getElementById('add-project-submit'),
      addProjectPort: document.getElementById('add-project-port'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsModal: document.getElementById('settings-modal')
    }
  }

  function bindUI () {
    document.body.addEventListener('click', function (event) {
      var dropzoneClick = event.target.closest('#folder-dropzone')
      if (dropzoneClick) {
        browseFolderFromPickModal()
        return
      }

      // Clicks on SVG/path inside icon buttons must resolve to the button
      var target = event.target.closest(
        'button, a.btn, a.btn-icon, [data-close], [data-settings-tab], [data-tab], [data-action], [data-project-start], [data-project-remove], [data-project-delete], [data-project-update], [data-project-edit], [data-process-update], [data-process-edit]'
      ) || event.target

      if (target.dataset.close === 'setup') {
        hideSetupModal()
        return
      }

      if (target.dataset.close === 'add-project') {
        hideAddProjectModal()
        return
      }

      if (target.dataset.close === 'settings') {
        hideSettingsModal()
        return
      }

      if (target.dataset.close === 'confirm-cancel') {
        resolveConfirm(false)
        return
      }

      if (target.dataset.close === 'prompt-cancel') {
        resolvePrompt(null)
        return
      }

      if (target.id === 'confirm-ok') {
        resolveConfirm(true)
        return
      }

      if (target.id === 'prompt-ok') {
        var promptInput = document.getElementById('prompt-input')
        resolvePrompt(promptInput ? promptInput.value : '')
        return
      }

      if (target.dataset.settingsTab) {
        switchSettingsTab(target.dataset.settingsTab)
        return
      }

      if (target.id === 'settings-btn') {
        showSettingsModal()
        return
      }

      if (target.id === 'settings-save') {
        saveSettings()
        return
      }

      if (target.id === 'setting-self-update' || target.id === 'self-update-btn') {
        beginSelfUpdate()
        return
      }

      if (target.id === 'setting-debug-view-log') {
        openDebugLogModal()
        return
      }

      if (target.id === 'debug-log-copy') {
        copyDebugLog()
        return
      }

      if (target.id === 'modal-log-copy') {
        copyProcessLog()
        return
      }

      if (target.id === 'debug-log-refresh') {
        openDebugLogModal()
        return
      }

      if (target.dataset.close === 'folder-pick-cancel') {
        resolveFolderPick(null)
        return
      }

      if (target.id === 'folder-pick-browse') {
        browseFolderFromPickModal()
        return
      }

      if (target.id === 'folder-pick-upload-last') {
        uploadFromSavedFolderSource()
        return
      }

      if (target.dataset.close === 'debug-log') {
        hideDebugLogModal()
        return
      }

      if (target.id === 'setting-create-user') {
        createSettingsUser()
        return
      }

      if (target.id === 'setting-tg-test') {
        testTelegram()
        return
      }

      if (target.id === 'setting-startup-create') {
        createStartupTask()
        return
      }

      if (target.id === 'setting-startup-copy') {
        copyStartupCommand()
        return
      }

      if (target.id === 'setting-change-password') {
        changeSettingsPassword()
        return
      }

      if (target.id === 'setting-api-key-generate') {
        generateApiKey()
        return
      }

      if (target.id === 'setting-api-key-revoke-all') {
        revokeAllApiKeys()
        return
      }

      if (target.id === 'setting-api-key-copy') {
        copyApiKeyValue()
        return
      }

      if (target.id === 'setting-api-key-copy-env') {
        copyApiKeyEnvLine()
        return
      }

      if (target.dataset.apiKeyRevoke) {
        revokeApiKey(target.dataset.apiKeyRevoke)
        return
      }

      if (target.id === 'setting-2fa-begin') {
        begin2faSetup()
        return
      }

      if (target.id === 'setting-2fa-confirm') {
        confirm2faSetup()
        return
      }

      if (target.id === 'setting-2fa-disable') {
        disable2fa()
        return
      }

      if (target.id === 'setting-logout') {
        logout()
        return
      }

      if (target.dataset.close === 'modal') {
        closeModal()
        return
      }

      if (target.dataset.tab) {
        switchTab(target.dataset.tab)
        return
      }

      if (target.id === 'setup-retry') {
        reconnect(state.connectionValue || getCurrentConnection())
        return
      }

      if (target.id === 'setup-copy') {
        copySetupCommands()
        return
      }

      if (target.id === 'add-project-btn') {
        beginCreateProjectFromLaptop()
        return
      }

      if (target.id === 'add-project-browse') {
        browseProjectFolder()
        return
      }

      if (target.id === 'add-project-submit') {
        submitProjectPath()
        return
      }

      if (target.id === 'start-projects-btn') {
        startAllSavedProjects()
        return
      }

      if (target.dataset.projectStart) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        startSavedProject(target.dataset.projectStart, target)
        return
      }

      if (target.dataset.projectRemove) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        removeSavedProject(target.dataset.projectRemove, target)
        return
      }

      if (target.dataset.projectDelete) {
        deleteSavedProjectRow(target.dataset.projectDelete, target)
        return
      }

      if (target.dataset.projectUpdate) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        beginProjectUpdate({ projectId: target.dataset.projectUpdate, button: target })
        return
      }

      if (target.dataset.processUpdate) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        beginProjectUpdate({
          pmId: target.dataset.processUpdate,
          pathHint: target.dataset.updatePath || '',
          button: target
        })
        return
      }

      if (target.dataset.processEdit) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        beginEditProcess({ pmId: target.dataset.processEdit })
        return
      }

      if (target.dataset.projectEdit) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        beginEditProcess({ projectId: target.dataset.projectEdit })
        return
      }

      if (target.dataset.close === 'edit-process-cancel') {
        hideEditProcessModal()
        return
      }

      if (target.id === 'edit-process-save') {
        saveEditProcess()
        return
      }

      if (target.dataset.action && !window.GUI.readonly) {
        if (state.updating) {
          toast('Wait for the project update to finish', 'error')
          return
        }
        var id = target.dataset.id
        var action = target.dataset.action
        if (action === 'delete' && id !== 'all') {
          showConfirmModal({
            title: 'Delete process',
            message: 'Delete this process and remove it from saved projects?',
            confirmLabel: 'Delete',
            danger: true
          }).then(function (ok) {
            if (ok) runAction(action, id, target)
          })
          return
        }
        if (action === 'delete' && id === 'all') {
          showConfirmModal({
            title: 'Delete all processes',
            message: 'Delete ALL processes from PM2?',
            confirmLabel: 'Delete all',
            danger: true
          }).then(function (ok) {
            if (ok) runAction(action, id, target)
          })
          return
        }
        runAction(action, id, target)
        return
      }

      var row = event.target.closest('[data-pmid]')
      if (row && row.dataset.pmid !== undefined && !event.target.closest('a, button')) {
        openProcessModal(parseInt(row.dataset.pmid, 10))
      }
    })

    document.body.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return
      var promptModal = document.getElementById('prompt-modal')
      if (promptModal && !promptModal.hidden && event.target && event.target.id === 'prompt-input') {
        event.preventDefault()
        resolvePrompt(event.target.value)
        return
      }
      var editModal = document.getElementById('edit-process-modal')
      if (
        editModal &&
        !editModal.hidden &&
        event.target &&
        (event.target.id === 'edit-process-name' || event.target.id === 'edit-process-port')
      ) {
        event.preventDefault()
        saveEditProcess()
      }
    })

    var debugToggle = document.getElementById('setting-debug-enabled')
    if (debugToggle) {
      debugToggle.addEventListener('change', function () {
        syncDebugLogButton(!!debugToggle.checked)
      })
    }
  }

  function connectAll (connectionValue) {
    disconnectAll()
    clearConnectTimer()
    state.connectionValue = connectionValue
    state.connected = false
    setConnectionStatus('Connecting...', 'pending')

    state.sockets.sys = connectSocket(connectionValue, NSP.SYS)
    state.sockets.process = connectSocket(connectionValue, NSP.PROCESS)

    wireSocket(state.sockets.sys, {
      onConnect: function () {
        markPartiallyConnected('Connected to monitor')
      },
      onVersion: function (info) {
        applyPm2Version(info)
      },
      onSysStat: onSystemStats,
      onError: onSocketError
    })

    wireSocket(state.sockets.process, {
      onConnect: function () {
        state.sockets.process.emit(EVENTS.PULL_PROCESSES)
      },
      onProcesses: onProcesses,
      onError: onSocketError
    })

    state.connectTimer = setTimeout(function () {
      if (!state.connected) {
        showSetupModal('Could not connect to the pm2-gui monitor within ' + (CONNECT_TIMEOUT_MS / 1000) + ' seconds.')
      }
    }, CONNECT_TIMEOUT_MS)
  }

  function wireSocket (socket, handlers) {
    socket.on(EVENTS.CONNECT, function () {
      handlers.onConnect && handlers.onConnect()
    })
    socket.on(EVENTS.CONNECT_ERROR, handlers.onError || onSocketError)
    socket.on(EVENTS.DISCONNECT, function () {
      if (state.connected) {
        setConnectionStatus('Reconnecting...', 'pending')
      }
    })

    if (handlers.onVersion) {
      socket.on(EVENTS.DATA_PM2_VERSION, handlers.onVersion)
    }
    if (handlers.onSysStat) {
      socket.on(EVENTS.DATA_SYSTEM_STATS, handlers.onSysStat)
    }
    if (handlers.onProcesses) {
      socket.on(EVENTS.DATA_PROCESSES, handlers.onProcesses)
    }

    socket.on(EVENTS.DATA_ACTION, function (payload) {
      if (payload && payload.error) {
        toast(payload.error, 'error')
        return
      }
      if (payload && payload.success && payload.action === 'delete') {
        loadSavedProjects()
      }
    })
    socket.on(EVENTS.ERROR, handlers.onError || onSocketError)
  }

  function reconnect (connectionValue) {
    hideSetupModal()
    connectAll(connectionValue)
    loadSetupStatus()
  }

  function disconnectAll () {
    clearConnectTimer()
    Object.keys(state.sockets).forEach(function (key) {
      if (state.sockets[key]) {
        state.sockets[key].disconnect()
      }
    })
    state.sockets = {}
    closeLogSocket()
    stopMonitor()
  }

  function connectSocket (connectionValue, namespace) {
    var uri = connectionValue
    var pageHost = location.hostname
    var pageIsLocal = pageHost === 'localhost' || pageHost === '127.0.0.1'

    if (pageIsLocal && (/127\.0\.0\.1|localhost/.test(uri))) {
      uri = uri.replace(/^https?:\/\/[^/?]+/, location.origin.replace(/\/$/, ''))
    } else if (!pageIsLocal) {
      uri = uri.replace(/^https?:\/\/[^/?]+/, location.origin.replace(/\/$/, ''))
    }

    var index = uri.indexOf('?')
    var query = ''
    if (index >= 0) {
      query = uri.slice(index)
      uri = uri.slice(0, index)
    }

    uri = uri.replace(/\/$/, '') + (namespace || '') + query

    var auth = document.getElementById('authorization')
    if (auth && auth.value && uri.indexOf('auth=') < 0) {
      uri += (uri.indexOf('?') >= 0 ? '&' : '?') + 'auth=' + encodeURIComponent(auth.value)
    }

    return io(uri, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      timeout: CONNECT_TIMEOUT_MS,
      reconnection: true,
      reconnectionAttempts: 10
    })
  }

  function markPartiallyConnected (label) {
    setConnectionStatus(label, 'pending')
  }

  function markConnected (label) {
    state.connected = true
    clearConnectTimer()
    hideSetupModal()
    setConnectionStatus(label, 'ok')
  }

  function applyPm2Version (info) {
    if (typeof info === 'string') {
      markConnected('PM2 v' + info)
      if (els.pm2Version) {
        els.pm2Version.title = ''
      }
      return
    }

    var label = 'PM2 v' + (info.version || '0.0.0')
    markConnected(label)

    if (els.pm2Version && info.updateRecommended) {
      els.pm2Version.title = 'Daemon is v' + info.daemon + '. Run: pm2 update'
      els.pm2Version.dataset.state = 'pending'
    } else if (els.pm2Version) {
      els.pm2Version.title = ''
    }
  }

  function setConnectionStatus (label, tone) {
    els.pm2Version.textContent = label
    els.pm2Version.dataset.state = tone || 'pending'
  }

  function clearConnectTimer () {
    if (state.connectTimer) {
      clearTimeout(state.connectTimer)
      state.connectTimer = null
    }
  }

  function loadSavedProjects () {
    state.projectsLoading = true
    fetch('/projects_api', { credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        state.savedProjects = data.projects || []
        renderProcessTable()
      })
      .catch(function (err) {
        toast('Could not load saved project folders.', 'error')
      })
      .finally(function () {
        state.projectsLoading = false
      })
  }

  function normalizePath (value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  function findProjectForProcess (proc) {
    if (!proc) return null
    var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
    if (!cwd) {
      return null
    }
    var normalized = normalizePath(cwd)
    return (state.savedProjects || []).find(function (project) {
      return normalizePath(project.path) === normalized
    }) || null
  }

  function findProcessByPmId (pmId) {
    var needle = String(pmId)
    return state.processes.find(function (p) {
      return p && String(p.pm_id) === needle
    }) || null
  }

  function findProcessForProject (project) {
    if (!project) return null
    var normalized = normalizePath(project.path)
    return state.processes.find(function (proc) {
      var cwd = proc && proc.pm2_env && proc.pm2_env.pm_cwd
      return cwd && normalizePath(cwd) === normalized
    }) || null
  }

  function getUnmanagedSavedProjects () {
    return state.savedProjects.filter(function (project) {
      return !findProcessForProject(project)
    })
  }

  function showAddProjectModal () {
    if (!els.addProjectModal || window.GUI.readonly) {
      return
    }
    els.addProjectModal.hidden = false
    if (els.addProjectPath) {
      els.addProjectPath.value = els.addProjectPath.value || ''
      setTimeout(function () { els.addProjectPath.focus() }, 50)
      if (!els.addProjectPath.dataset.boundEnter) {
        els.addProjectPath.dataset.boundEnter = '1'
        els.addProjectPath.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            submitProjectPath()
          }
        })
      }
    }
  }

  function hideAddProjectModal () {
    if (els.addProjectModal) {
      els.addProjectModal.hidden = true
    }
  }

  function browseProjectFolder () {
    if (window.GUI.readonly || state.browsingFolder) {
      return
    }

    state.browsingFolder = true
    if (els.addProjectBrowse) {
      els.addProjectBrowse.disabled = true
      els.addProjectBrowse.textContent = 'Browsing…'
    }

    fetch('/projects_api/browse', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not open folder picker')
        }
        if (result.body.canceled) {
          return
        }
        if (result.body.project && result.body.project.path && els.addProjectPath) {
          els.addProjectPath.value = result.body.project.path
        }
        toast('Saved project folder: ' + result.body.project.name)
        hideAddProjectModal()
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message + ' Use the path field instead.', 'error')
      })
      .finally(function () {
        state.browsingFolder = false
        if (els.addProjectBrowse) {
          els.addProjectBrowse.disabled = false
          els.addProjectBrowse.textContent = 'Browse'
        }
      })
  }

  function submitProjectPath () {
    if (window.GUI.readonly || state.browsingFolder) {
      return
    }

    var folder = els.addProjectPath ? els.addProjectPath.value.trim() : ''
    if (!folder) {
      toast('Enter a project folder path.', 'error')
      if (els.addProjectPath) els.addProjectPath.focus()
      return
    }

    var payload = { path: folder }
    if (els.addProjectPort && els.addProjectPort.value.trim()) {
      payload.servicePort = parseInt(els.addProjectPort.value.trim(), 10)
    }

    state.browsingFolder = true
    if (els.addProjectSubmit) {
      els.addProjectSubmit.disabled = true
      els.addProjectSubmit.textContent = 'Adding…'
    }

    fetch('/projects_api/add', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not add project folder')
        }
        toast('Saved project folder: ' + result.body.project.name)
        if (els.addProjectPath) {
          els.addProjectPath.value = ''
        }
        if (els.addProjectPort) {
          els.addProjectPort.value = ''
        }
        hideAddProjectModal()
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        state.browsingFolder = false
        if (els.addProjectSubmit) {
          els.addProjectSubmit.disabled = false
          els.addProjectSubmit.textContent = 'Add project'
        }
      })
  }

  function startSavedProject (projectId, button) {
    if (button) {
      button.disabled = true
    }

    fetch('/projects_api/' + encodeURIComponent(projectId) + '/start', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not start project')
        }
        toast('Started ' + result.body.project.name)
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        if (button) {
          button.disabled = false
        }
      })
  }

  function startAllSavedProjects () {
    if (window.GUI.readonly) {
      return
    }

    fetch('/projects_api/start_all', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok && !result.body.results) {
          throw new Error(result.body.error || 'Could not start saved projects')
        }
        var started = (result.body.results || []).filter(function (r) { return r.status === 'started' }).length
        toast(started > 0 ? 'Started ' + started + ' saved project(s)' : 'Saved projects are already running or unavailable')
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function removeSavedProject (projectId, button) {
    if (button) {
      button.disabled = true
    }

    fetch('/projects_api/' + encodeURIComponent(projectId), {
      method: 'DELETE',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not remove project')
        }
        toast('Removed saved folder')
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        if (button) {
          button.disabled = false
        }
      })
  }

  function deleteSavedProjectRow (projectId, button) {
    if (state.updating) {
      toast('Wait for the project update to finish', 'error')
      return
    }
    showConfirmModal({
      title: 'Remove saved project',
      message: 'Remove this saved project from your list?',
      confirmLabel: 'Remove',
      danger: true
    }).then(function (ok) {
      if (ok) removeSavedProject(projectId, button)
    })
  }

  function onSocketError (err) {
    var message = typeof err === 'string' ? err : (err && err.message) || 'Connection error'
    if (message === 'unauthorized') {
      message = 'Authentication failed. Check your authorization token in pm2-gui.ini.'
      showSetupModal(message)
    }
    toast(message, 'error')
  }

  function onSystemStats (data) {
    state.sysStat = data
    markConnected(els.pm2Version.textContent.indexOf('PM2 v') === 0 ? els.pm2Version.textContent : 'Connected')
    els.statHostname.textContent = data.hostname || '—'
    els.statPlatform.textContent = (data.platform || '') + ' ' + (data.release || '')
    els.statCpu.textContent = (data.cpu || 0) + '%'
    els.statCpuBar.style.width = Math.min(parseFloat(data.cpu) || 0, 100) + '%'
    els.statMemory.textContent = formatBytes(data.memory && data.memory.total ? data.memory.total - data.memory.free : 0) + ' used'
    els.statMemoryBar.style.width = Math.min((data.memory && data.memory.percentage) || 0, 100) + '%'
    els.statUptime.textContent = formatDuration(data.uptime || 0)
  }

  function onProcesses (processes) {
    state.processes = processes || []
    markConnected(els.pm2Version.textContent === 'Connecting...' ? 'Connected' : els.pm2Version.textContent)
    els.statProcesses.textContent = String(state.processes.length)
    renderProcessTable()
  }

  function renderProcessTable () {
    var colSpan = window.GUI.readonly ? 9 : 10
    var unmanaged = getUnmanagedSavedProjects()
    var totalRows = state.processes.length + unmanaged.length

    els.processCount.textContent = totalRows + ' app' + (totalRows === 1 ? '' : 's')

    if (!totalRows) {
      els.processList.innerHTML = '<tr><td colspan="' + colSpan + '"><div class="empty-state">No projects yet. Click <strong>Add project folder</strong> to add one without starting it.</div></td></tr>'
      return
    }

    var rows = state.processes.map(renderProcessRow).concat(unmanaged.map(renderSavedProjectRow))
    els.processList.innerHTML = rows.join('')
  }

  function renderProcessRow (proc) {
    var env = proc.pm2_env || {}
    var status = env.status || 'unknown'
    var mode = (env.exec_mode || '').replace(/_mode$/, '')
    var project = findProjectForProcess(proc)
    var pathHint = project ? project.path : (env.pm_cwd || '')
    var port = resolveProcessPort(proc, project)
    var actions = window.GUI.readonly ? '' : (
      '<td class="row-actions">' +
        renderProcessActions(status, proc, project) +
      '</td>'
    )

    return (
      '<tr class="is-clickable" data-pmid="' + proc.pm_id + '">' +
        '<td><span class="status-badge ' + status + '"><span class="status-dot"></span>' + status + '</span></td>' +
        '<td>' + renderNameCell(proc.name || 'unknown', pathHint, null, proc.appVersion) + '</td>' +
        '<td>' + proc.pm_id + '</td>' +
        '<td><span class="mode-badge">' + escapeHtml(mode || 'fork') + '</span></td>' +
        '<td>' + (port != null ? escapeHtml(String(port)) : '—') + '</td>' +
        '<td>' + formatPercent(proc.monit && proc.monit.cpu) + '</td>' +
        '<td>' + formatBytes(proc.monit && proc.monit.memory) + '</td>' +
        '<td>' + (env.restart_time || 0) + '</td>' +
        '<td>' + formatDuration(env.pm_uptime ? (Date.now() - env.pm_uptime) / 1000 : 0) + '</td>' +
        actions +
      '</tr>'
    )
  }

  function renderSavedProjectRow (project) {
    var entry = project.type === 'ecosystem'
      ? 'ecosystem config'
      : (project.script || 'index.js')
    var port = resolveProcessPort(null, project)
    var actions = window.GUI.readonly ? '' : (
      '<td class="row-actions">' +
        '<button class="btn btn-icon" data-project-edit="' + project.id + '" title="Edit" aria-label="Edit">✎</button>' +
        '<button class="btn btn-icon" data-project-update="' + project.id + '" title="Update from laptop" aria-label="Update from laptop">' + UPDATE_FROM_LAPTOP_ICON + '</button>' +
        '<button class="btn btn-icon" data-project-start="' + project.id + '" title="start">▶</button>' +
        '<button class="btn btn-icon" data-project-delete="' + project.id + '" title="delete">✕</button>' +
      '</td>'
    )

    return (
      '<tr class="is-saved" data-project-id="' + project.id + '">' +
        '<td><span class="status-badge saved"><span class="status-dot"></span>saved</span></td>' +
        '<td>' + renderNameCell(project.name, project.path, entry, project.appVersion) + '</td>' +
        '<td>—</td>' +
        '<td><span class="mode-badge">—</span></td>' +
        '<td>' + (port != null ? escapeHtml(String(port)) : '—') + '</td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        actions +
      '</tr>'
    )
  }

  function renderNameCell (name, pathHint, entry, version) {
    var html = '<span class="process-name-line">' +
      '<strong>' + escapeHtml(name) + '</strong>'
    if (version) {
      html += '<span class="process-version" title="package.json version">v' +
        escapeHtml(String(version).replace(/^v/i, '')) +
        '</span>'
    }
    html += '</span>'
    if (pathHint) {
      html += '<span class="process-path" title="' + escapeHtml(pathHint) + '">' + escapeHtml(pathHint) + '</span>'
    }
    if (entry) {
      html += '<span class="process-entry">Entry: ' + escapeHtml(entry) + '</span>'
    }
    return html
  }

  function renderProcessActions (status, proc, project) {
    var html = ''
    var updatePath = escapeAttr((project && project.path) || (proc.pm2_env && proc.pm2_env.pm_cwd) || '')
    var updateBtn = updatePath
      ? '<button class="btn btn-icon" data-process-update="' + proc.pm_id + '" data-update-path="' + updatePath + '" title="Update from laptop" aria-label="Update from laptop">' + UPDATE_FROM_LAPTOP_ICON + '</button>'
      : ''
    var editBtn = '<button class="btn btn-icon" data-process-edit="' + proc.pm_id + '" title="Edit name and port" aria-label="Edit">✎</button>'

    if (status === 'online') {
      var serviceUrl = resolveServiceUrl(proc, project)
      if (serviceUrl) {
        html += openServiceLink(serviceUrl)
      }
      html += editBtn + updateBtn + actionButton('restart', proc.pm_id) + actionButton('stop', proc.pm_id) + actionButton('delete', proc.pm_id)
    } else {
      html += editBtn + updateBtn + actionButton('start', proc.pm_id) + actionButton('delete', proc.pm_id)
    }
    return html
  }

  function getPublicHost () {
    var host = location.hostname
    if (window.GUI.publicHost && (!host || host === 'localhost' || host === '127.0.0.1')) {
      return window.GUI.publicHost
    }
    return host
  }

  function getPublicProtocol () {
    if (window.GUI.publicProtocol) {
      var protocol = String(window.GUI.publicProtocol).replace(/:$/, '')
      return protocol + ':'
    }
    return location.protocol || 'http:'
  }

  function extractPortFromEnv (env) {
    if (!env) {
      return null
    }
    var keys = [
      'SYNC_WEB_PORT',
      'PORT',
      'port',
      'HTTP_PORT',
      'SERVER_PORT',
      'APP_PORT',
      'WEB_PORT',
      'NODE_PORT'
    ]
    for (var i = 0; i < keys.length; i++) {
      if (env[keys[i]] != null && env[keys[i]] !== '') {
        var port = parseInt(env[keys[i]], 10)
        if (port > 0 && port < 65536) {
          return port
        }
      }
    }
    return null
  }

  function resolveProcessPort (proc, project) {
    // Prefer the running process env — stored servicePort is only a hint for the open link.
    if (proc) {
      var env = proc.pm2_env || {}
      var fromEnv = extractPortFromEnv(env.env) || extractPortFromEnv(env)
      if (fromEnv != null) {
        return fromEnv
      }
    }
    if (project && project.servicePort != null && project.servicePort !== '') {
      var saved = parseInt(project.servicePort, 10)
      if (saved > 0 && saved < 65536) {
        return saved
      }
    }
    return null
  }

  function resolveServiceUrl (proc, project) {
    if (project && project.serviceUrl) {
      return project.serviceUrl
    }

    var port = resolveProcessPort(proc, project)
    if (!port) {
      return null
    }

    var host = getPublicHost()
    if (!host) {
      return null
    }

    var path = (project && project.servicePath) || '/'
    if (path.charAt(0) !== '/') {
      path = '/' + path
    }

    return getPublicProtocol() + '//' + host + ':' + port + path
  }

  function openServiceLink (url) {
    return (
      '<a class="btn btn-icon btn-open" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + escapeAttr(url) + '">↗</a>'
    )
  }

  function actionButton (action, id) {
    var labels = { start: '▶', restart: '↻', stop: '■', delete: '✕' }
    return '<button class="btn btn-icon" data-action="' + action + '" data-id="' + id + '" title="' + action + '">' + (labels[action] || action) + '</button>'
  }

  function runAction (action, id, button) {
    if (!state.sockets.sys || !state.sockets.sys.connected) {
      toast('Not connected to monitor.', 'error')
      return
    }
    if (button) {
      button.disabled = true
      setTimeout(function () { button.disabled = false }, 1200)
    }
    state.sockets.sys.emit(EVENTS.PULL_ACTION, action, id)
  }

  var UPDATE_EXCLUDE_RE = /^(node_modules|\.git|\.svn|\.hg|logs?|\.DS_Store|Thumbs\.db|\.next|\.nuxt|\.cache|coverage|\.turbo|\.vercel|data|\.pm2-gui-boot\.env|pm2-gui\.log|pm2-gui\.pid)$/i
  var MAX_UPLOAD_BYTES = 200 * 1024 * 1024
  var UPLOAD_SOURCE_LS_KEY = 'pm2gui.uploadSources.v1'
  var UPLOAD_SOURCE_IDB_NAME = 'pm2gui-upload-sources'
  var UPLOAD_SOURCE_IDB_VERSION = 2
  var UPLOAD_SOURCE_HANDLE_STORE = 'handles'
  var UPLOAD_SOURCE_SNAPSHOT_STORE = 'snapshots'

  function isExcludedUpdatePath (relPath) {
    return String(relPath || '').replace(/\\/g, '/').split('/').some(function (part) {
      return part && (
        UPDATE_EXCLUDE_RE.test(part) ||
        /\.sqlite$/i.test(part) ||
        /\.db$/i.test(part) ||
        /\.db-(journal|wal|shm)$/i.test(part)
      )
    })
  }

  function isUnreadableFileError (err) {
    if (!err) return false
    var name = String(err.name || '')
    var msg = String(err.message || '')
    return name === 'NotReadableError' ||
      name === 'NotFoundError' ||
      /could not be read/i.test(msg) ||
      /permission problems that have occurred after a reference/i.test(msg)
  }

  function friendlyFolderReadError (err, folderName) {
    var label = folderName || 'that folder'
    if (isUnreadableFileError(err) || (err && err.name === 'NotAllowedError')) {
      return 'Browser lost access to “' + label +
        '”. Use Browse folder once more, then Upload will remember it.'
    }
    return (err && err.message) || ('Could not read “' + label + '”')
  }

  function readFileArrayBufferViaReader (file, previousErr) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () { resolve(reader.result) }
      reader.onerror = function () {
        reject(reader.error || previousErr || new Error('Could not read file'))
      }
      try {
        reader.readAsArrayBuffer(file)
      } catch (err) {
        reject(err)
      }
    })
  }

  function readFileArrayBuffer (file) {
    if (!file) return Promise.reject(new Error('Missing file'))
    if (typeof file.arrayBuffer === 'function') {
      return Promise.resolve().then(function () {
        return file.arrayBuffer()
      }).catch(function (err) {
        return readFileArrayBufferViaReader(file, err)
      })
    }
    return readFileArrayBufferViaReader(file)
  }

  function cloneFileFromBuffer (buffer, file) {
    return new File([buffer], (file && file.name) || 'file', {
      type: (file && file.type) || 'application/octet-stream',
      lastModified: (file && file.lastModified) || Date.now()
    })
  }

  function materializeFile (file) {
    return readFileArrayBuffer(file).then(function (buffer) {
      return cloneFileFromBuffer(buffer, file)
    })
  }

  function materializeSelection (selection) {
    if (!selection) return Promise.reject(new Error('Nothing to upload'))
    if (selection.fromSnapshot) return Promise.resolve(selection)
    if (selection.archive) {
      return materializeFile(selection.archive).then(function (archive) {
        selection.archive = archive
        selection.files = [archive]
        selection.totalBytes = archive.size || 0
        return selection
      })
    }
    var files = selection.files || []
    var paths = selection.paths || []
    var chain = Promise.resolve([])
    files.forEach(function (file, index) {
      chain = chain.then(function (out) {
        return materializeFile(file).then(function (copy) {
          out.push(copy)
          return out
        }).catch(function (err) {
          err.failedPath = paths[index] || (file && file.name) || 'file'
          throw err
        })
      })
    })
    return chain.then(function (copies) {
      selection.files = copies
      selection.totalBytes = copies.reduce(function (sum, copy) {
        return sum + ((copy && copy.size) || 0)
      }, 0)
      return selection
    })
  }

  function relativeUpdatePath (file) {
    var rel = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/')
    var parts = rel.split('/').filter(Boolean)
    if (parts.length > 1) {
      parts.shift()
    }
    return parts.join('/')
  }

  function supportsDirectoryPicker () {
    return !!(window.isSecureContext && typeof window.showDirectoryPicker === 'function')
  }

  function normalizeUploadSourceKey (key) {
    return String(key || 'default').trim() || 'default'
  }

  function resolveUploadSourceKey (opts) {
    opts = opts || {}
    if (opts.sourceKey) return normalizeUploadSourceKey(opts.sourceKey)
    if (opts.pathHint) {
      return normalizeUploadSourceKey(
        'path:' + String(opts.pathHint).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      )
    }
    if (opts.projectId) return normalizeUploadSourceKey('project:' + opts.projectId)
    if (opts.pmId != null) return normalizeUploadSourceKey('process:' + opts.pmId)
    return 'default'
  }

  function readUploadSourceMetaMap () {
    try {
      var raw = window.localStorage.getItem(UPLOAD_SOURCE_LS_KEY)
      var parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (err) {
      return {}
    }
  }

  function writeUploadSourceMetaMap (map) {
    try {
      window.localStorage.setItem(UPLOAD_SOURCE_LS_KEY, JSON.stringify(map || {}))
    } catch (err) {}
  }

  function getUploadSourceMeta (sourceKey) {
    var key = normalizeUploadSourceKey(sourceKey)
    var entry = readUploadSourceMetaMap()[key]
    if (!entry || typeof entry !== 'object') return null
    var folderName = String(entry.folderName || entry.displayPath || '').trim()
    if (!folderName) return null
    return {
      folderName: folderName,
      displayPath: String(entry.displayPath || folderName).trim() || folderName,
      updatedAt: entry.updatedAt || null
    }
  }

  function setUploadSourceMeta (sourceKey, meta) {
    var key = normalizeUploadSourceKey(sourceKey)
    var map = readUploadSourceMetaMap()
    map[key] = {
      folderName: meta.folderName,
      displayPath: meta.displayPath || meta.folderName,
      updatedAt: Date.now()
    }
    writeUploadSourceMetaMap(map)
  }

  function openUploadSourceDb () {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'))
        return
      }
      var req = window.indexedDB.open(UPLOAD_SOURCE_IDB_NAME, UPLOAD_SOURCE_IDB_VERSION)
      req.onupgradeneeded = function () {
        var db = req.result
        if (!db.objectStoreNames.contains(UPLOAD_SOURCE_HANDLE_STORE)) {
          db.createObjectStore(UPLOAD_SOURCE_HANDLE_STORE)
        }
        if (!db.objectStoreNames.contains(UPLOAD_SOURCE_SNAPSHOT_STORE)) {
          db.createObjectStore(UPLOAD_SOURCE_SNAPSHOT_STORE)
        }
      }
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')) }
    })
  }

  function idbStoreRequest (storeName, mode, fn) {
    return openUploadSourceDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        if (!db.objectStoreNames.contains(storeName)) {
          try { db.close() } catch (closeErr) {}
          reject(new Error('IndexedDB store missing: ' + storeName))
          return
        }
        var tx = db.transaction(storeName, mode)
        var store = tx.objectStore(storeName)
        var req
        try {
          req = fn(store)
        } catch (err) {
          try { db.close() } catch (closeErr) {}
          reject(err)
          return
        }
        var settled = false
        function finish (err, value) {
          if (settled) return
          settled = true
          try { db.close() } catch (closeErr) {}
          if (err) reject(err)
          else resolve(value)
        }
        if (req && typeof req.onsuccess !== 'undefined') {
          req.onsuccess = function () {}
          req.onerror = function () {
            finish(req.error || new Error('IndexedDB request failed'))
          }
        }
        tx.oncomplete = function () {
          finish(null, req && typeof req.result !== 'undefined' ? req.result : undefined)
        }
        tx.onerror = function () {
          finish(tx.error || new Error('IndexedDB transaction failed'))
        }
        tx.onabort = function () {
          finish(tx.error || new Error('IndexedDB transaction aborted'))
        }
      })
    })
  }

  function saveUploadSourceHandle (sourceKey, dirHandle) {
    var key = normalizeUploadSourceKey(sourceKey)
    if (!dirHandle) {
      return clearUploadSourceHandle(key)
    }
    return idbStoreRequest(UPLOAD_SOURCE_HANDLE_STORE, 'readwrite', function (store) {
      return store.put(dirHandle, key)
    }).catch(function () { return null })
  }

  function clearUploadSourceHandle (sourceKey) {
    var key = normalizeUploadSourceKey(sourceKey)
    return idbStoreRequest(UPLOAD_SOURCE_HANDLE_STORE, 'readwrite', function (store) {
      return store.delete(key)
    }).catch(function () { return null })
  }

  function loadUploadSourceHandle (sourceKey) {
    var key = normalizeUploadSourceKey(sourceKey)
    return idbStoreRequest(UPLOAD_SOURCE_HANDLE_STORE, 'readonly', function (store) {
      return store.get(key)
    }).catch(function () { return null })
  }

  function fileToSnapshotEntry (file, relPath) {
    return readFileArrayBuffer(file).then(function (buffer) {
      return {
        relPath: relPath,
        name: file.name || 'file',
        type: file.type || 'application/octet-stream',
        lastModified: file.lastModified || Date.now(),
        buffer: buffer
      }
    })
  }

  function selectionToSnapshot (selection) {
    var files = selection.files || []
    var paths = selection.paths || []
    var chain = Promise.resolve([])
    files.forEach(function (file, index) {
      var rel = paths[index] || file.name || ('file-' + index)
      if (isExcludedUpdatePath(rel)) return
      chain = chain.then(function (entries) {
        return fileToSnapshotEntry(file, rel).then(function (entry) {
          entries.push(entry)
          return entries
        })
      })
    })
    return chain.then(function (entries) {
      return {
        folderName: selection.folderName || 'project',
        displayPath: selection.displayPath || selection.folderName || 'project',
        mode: selection.mode || 'files',
        totalBytes: entries.reduce(function (sum, entry) {
          return sum + ((entry.buffer && entry.buffer.byteLength) || 0)
        }, 0),
        paths: entries.map(function (entry) { return entry.relPath }),
        entries: entries,
        savedAt: Date.now()
      }
    })
  }

  function snapshotToSelection (snapshot) {
    if (!snapshot || !(snapshot.entries || []).length) return null
    var files = []
    var paths = []
    snapshot.entries.forEach(function (entry) {
      if (!entry || entry.buffer == null) return
      var bytes = entry.buffer instanceof ArrayBuffer
        ? new Uint8Array(entry.buffer)
        : (ArrayBuffer.isView(entry.buffer)
          ? new Uint8Array(entry.buffer.buffer, entry.buffer.byteOffset, entry.buffer.byteLength)
          : null)
      if (!bytes || !bytes.byteLength) return
      var rel = entry.relPath || entry.name || 'file'
      if (isExcludedUpdatePath(rel)) return
      files.push(new File([bytes], entry.name || 'file', {
        type: entry.type || 'application/octet-stream',
        lastModified: entry.lastModified || Date.now()
      }))
      paths.push(rel)
    })
    if (!files.length) return null
    return {
      folderName: snapshot.folderName || 'project',
      displayPath: snapshot.displayPath || snapshot.folderName || 'project',
      dirHandle: null,
      mode: 'files',
      files: files,
      paths: paths,
      totalBytes: files.reduce(function (sum, file) { return sum + (file.size || 0) }, 0),
      archive: null,
      fromSnapshot: true
    }
  }

  function crc32Table () {
    if (crc32Table.cache) return crc32Table.cache
    var table = new Uint32Array(256)
    for (var i = 0; i < 256; i++) {
      var c = i
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      }
      table[i] = c >>> 0
    }
    crc32Table.cache = table
    return table
  }

  function crc32 (bytes) {
    var table = crc32Table()
    var crc = 0xffffffff
    for (var i = 0; i < bytes.length; i++) {
      crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  function u16 (value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff])
  }

  function u32 (value) {
    return new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    ])
  }

  function encodeZipPath (relPath) {
    var cleaned = String(relPath || 'file').replace(/\\/g, '/').replace(/^\/+/, '')
    var bytes = []
    for (var i = 0; i < cleaned.length; i++) {
      var code = cleaned.charCodeAt(i)
      bytes.push(code < 0x80 ? code : 0x5f)
    }
    return new Uint8Array(bytes)
  }

  function buildStoredZipFile (files, paths, zipName) {
    var localParts = []
    var centralParts = []
    var offset = 0
    var count = 0

    function appendParts (target, chunks) {
      for (var i = 0; i < chunks.length; i++) target.push(chunks[i])
    }

    var chain = Promise.resolve()
    files.forEach(function (file, index) {
      chain = chain.then(function () {
        return readFileArrayBuffer(file).then(function (buffer) {
          var data = new Uint8Array(buffer)
          var nameBytes = encodeZipPath(paths[index] || file.name || ('file-' + index))
          var checksum = crc32(data)
          var localHeader = []
          appendParts(localHeader, [
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(checksum),
            u32(data.length),
            u32(data.length),
            u16(nameBytes.length),
            u16(0),
            nameBytes,
            data
          ])
          var localSize = 30 + nameBytes.length + data.length
          appendParts(localParts, localHeader)

          var central = []
          appendParts(central, [
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(checksum),
            u32(data.length),
            u32(data.length),
            u16(nameBytes.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(offset),
            nameBytes
          ])
          appendParts(centralParts, central)
          offset += localSize
          count += 1
        })
      })
    })

    return chain.then(function () {
      if (!count) {
        throw new Error('No files available to package for upload')
      }
      var centralSize = centralParts.reduce(function (sum, part) {
        return sum + part.byteLength
      }, 0)
      var end = [
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(count),
        u16(count),
        u32(centralSize),
        u32(offset),
        u16(0)
      ]
      var blob = new Blob(localParts.concat(centralParts, end), {
        type: 'application/zip'
      })
      return new File([blob], zipName || 'project-update.zip', {
        type: 'application/zip'
      })
    })
  }

  function selectionForTransport (selection, zipName) {
    if (!selection) return Promise.reject(new Error('Nothing to upload'))
    if (selection.mode === 'zip' || selection.archive) {
      return Promise.resolve(selection)
    }
    var files = selection.files || []
    var paths = selection.paths || []
    if (!files.length) {
      return Promise.reject(new Error('No files selected for upload'))
    }

    // Snapshot/reused uploads are more reliable as a single zip (one multipart
    // part) than hundreds of reconstructed File blobs.
    var shouldZip = !!selection.fromSnapshot || files.length > 40
    if (!shouldZip) {
      return Promise.resolve(selection)
    }

    return buildStoredZipFile(files, paths, zipName).then(function (zipFile) {
      return {
        folderName: selection.folderName,
        displayPath: selection.displayPath,
        dirHandle: selection.dirHandle || null,
        mode: 'zip',
        archive: zipFile,
        files: [zipFile],
        paths: [],
        totalBytes: zipFile.size,
        servicePort: selection.servicePort,
        fromSnapshot: selection.fromSnapshot
      }
    })
  }

  function saveUploadSourceSnapshot (sourceKey, selection) {
    var key = normalizeUploadSourceKey(sourceKey)
    if (!selection || !(selection.files || []).length) {
      return clearUploadSourceSnapshot(key)
    }
    return selectionToSnapshot(selection).then(function (snapshot) {
      return idbStoreRequest(UPLOAD_SOURCE_SNAPSHOT_STORE, 'readwrite', function (store) {
        return store.put(snapshot, key)
      })
    }).catch(function (err) {
      console.warn('[upload-source] could not persist folder snapshot:', err && err.message)
      return null
    })
  }

  function clearUploadSourceSnapshot (sourceKey) {
    var key = normalizeUploadSourceKey(sourceKey)
    return idbStoreRequest(UPLOAD_SOURCE_SNAPSHOT_STORE, 'readwrite', function (store) {
      return store.delete(key)
    }).catch(function () { return null })
  }

  function loadUploadSourceSnapshot (sourceKey) {
    var key = normalizeUploadSourceKey(sourceKey)
    return idbStoreRequest(UPLOAD_SOURCE_SNAPSHOT_STORE, 'readonly', function (store) {
      return store.get(key)
    }).then(function (snapshot) {
      return snapshotToSelection(snapshot)
    }).catch(function () { return null })
  }

  function rememberUploadSource (sourceKey, selection) {
    if (!sourceKey || !selection) return Promise.resolve(null)
    var key = normalizeUploadSourceKey(sourceKey)
    var folderName = selection.folderName || 'project'
    setUploadSourceMeta(sourceKey, {
      folderName: folderName,
      displayPath: selection.displayPath || folderName
    })
    if (selection.dirHandle) {
      saveUploadSourceHandle(sourceKey, selection.dirHandle)
    } else if (!selection.fromSnapshot) {
      clearUploadSourceHandle(sourceKey)
    }
    // Keep the last FileList in memory and IndexedDB so Upload can reuse it
    // across reloads when the browser cannot reopen a directory handle
    // (common on plain HTTP LAN dashboards).
    state.uploadSelectionCache[key] = {
      folderName: selection.folderName,
      displayPath: selection.displayPath || selection.folderName,
      dirHandle: selection.dirHandle || null,
      mode: selection.mode || 'files',
      files: selection.files || [],
      paths: selection.paths || [],
      totalBytes: selection.totalBytes || 0,
      archive: selection.archive || null
    }
    refreshFolderLastSourceUi(sourceKey)
    clearUploadSourceSnapshot(sourceKey)
    return Promise.resolve(null)
  }

  function finishFolderPickResolve (selection) {
    var modal = document.getElementById('folder-pick-modal')
    if (modal) modal.hidden = true
    var status = document.getElementById('folder-dropzone-status')
    if (status) status.textContent = ''
    var dropzone = document.getElementById('folder-dropzone')
    if (dropzone) dropzone.classList.remove('is-dragover')
    var resolver = state.folderPickResolver
    state.folderPickResolver = null
    state.folderPickAskPort = false
    if (resolver) resolver(selection || null)
  }

  function resolveFolderPick (selection) {
    if (!selection) {
      finishFolderPickResolve(null)
      return Promise.resolve(null)
    }

    attachFolderPickPort(selection)
    var sourceKey = state.folderPickSourceKey
    if (!sourceKey) {
      finishFolderPickResolve(selection)
      return Promise.resolve(selection)
    }

    if (!selection.fromSnapshot) {
      setFolderPickStatus('Saving folder for next Upload…')
    }

    return Promise.resolve(rememberUploadSource(sourceKey, selection)).then(function () {
      finishFolderPickResolve(selection)
      return selection
    }).catch(function () {
      // Still continue the upload even if persistence fails.
      finishFolderPickResolve(selection)
      return selection
    })
  }

  function refreshFolderLastSourceUi (sourceKey) {
    var wrap = document.getElementById('folder-last-source')
    var pathEl = document.getElementById('folder-last-source-path')
    if (!wrap || !pathEl) return
    var meta = getUploadSourceMeta(sourceKey)
    if (!meta) {
      wrap.hidden = true
      pathEl.textContent = ''
      return
    }
    pathEl.textContent = meta.displayPath || meta.folderName
    pathEl.title = meta.displayPath || meta.folderName
    wrap.hidden = false
  }

  function configureFolderPickPortUi (options) {
    options = options || {}
    var wrap = document.getElementById('folder-pick-port-wrap')
    var input = document.getElementById('folder-pick-port')
    var hint = document.getElementById('folder-pick-port-hint')
    state.folderPickAskPort = !!options.askPort
    if (!wrap || !input) return
    if (!options.askPort) {
      wrap.hidden = true
      input.value = ''
      return
    }
    wrap.hidden = false
    input.value = ''
    var current = options.currentPort ? String(options.currentPort) : ''
    if (options.portPlaceholder) {
      input.placeholder = options.portPlaceholder
    } else {
      input.placeholder = current
        ? ('Leave blank to keep ' + current)
        : 'e.g. 3044'
    }
    if (hint) {
      hint.textContent = options.portHint || (
        current
          ? ('Leave blank to keep port ' + current + '. Enter a number only if you want to change it.')
          : 'Leave blank to use the port already defined in the project. Enter a number only if you want to set one.'
      )
    }
  }

  function readFolderPickPortValue () {
    if (!state.folderPickAskPort) return ''
    var input = document.getElementById('folder-pick-port')
    return input ? String(input.value || '').trim() : ''
  }

  function attachFolderPickPort (selection) {
    if (!selection) return selection
    selection.servicePort = readFolderPickPortValue()
    return selection
  }

  function ensureDirectoryPermission (dirHandle) {
    if (!dirHandle) return Promise.resolve(false)
    var canRequest = typeof dirHandle.requestPermission === 'function'
    // Always re-request on the user click. Chrome can report "granted" for a
    // persisted handle whose file descriptors are already dead.
    if (canRequest) {
      return dirHandle.requestPermission({ mode: 'read' }).then(function (status) {
        return status === 'granted'
      }).catch(function () { return false })
    }
    if (typeof dirHandle.queryPermission !== 'function') {
      return Promise.resolve(true)
    }
    return dirHandle.queryPermission({ mode: 'read' }).then(function (status) {
      return status === 'granted'
    }).catch(function () { return false })
  }

  function selectionFromDirHandle (dirHandle) {
    var collected = []
    return collectFilesFromDirHandle(dirHandle, '', collected).then(function () {
      return prepareUploadSelection(collected.map(function (item) {
        return { file: item.file, relPath: item.relPath }
      }), dirHandle.name, dirHandle)
    })
  }

  function cloneCachedSelection (cached) {
    if (!cached || !(cached.files || []).length) return null
    return {
      folderName: cached.folderName || 'project',
      displayPath: cached.displayPath || cached.folderName || 'project',
      dirHandle: cached.dirHandle || null,
      mode: cached.mode || 'files',
      files: cached.files.slice(),
      paths: (cached.paths || []).slice(),
      totalBytes: cached.totalBytes || 0,
      archive: cached.archive || null
    }
  }

  function tryLiveHandleSelection (sourceKey) {
    return loadUploadSourceHandle(sourceKey).then(function (dirHandle) {
      if (!dirHandle) return null
      return ensureDirectoryPermission(dirHandle).then(function (granted) {
        if (!granted) return null
        return selectionFromDirHandle(dirHandle)
      })
    }).then(function (selection) {
      if (!selection) return null
      return materializeSelection(selection).catch(function (err) {
        console.warn('[upload-source] live folder unreadable:', err && err.message)
        clearUploadSourceHandle(sourceKey)
        return null
      })
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err
      console.warn('[upload-source] live handle failed:', err && err.message)
      clearUploadSourceHandle(sourceKey)
      return null
    })
  }

  function tryCachedSelection (sourceKey) {
    var cached = cloneCachedSelection(
      state.uploadSelectionCache[normalizeUploadSourceKey(sourceKey)]
    )
    if (!cached) return Promise.resolve(null)
    return materializeSelection(cached).catch(function () { return null })
  }

  function uploadFromSavedFolderSource () {
    var sourceKey = state.folderPickSourceKey
    var meta = getUploadSourceMeta(sourceKey)
    if (!sourceKey || !meta) {
      toast('No saved folder yet. Use Browse folder or drop a folder first.', 'error')
      return
    }

    setFolderPickStatus('Reading current files in “' + meta.folderName + '”…')

    tryLiveHandleSelection(sourceKey).then(function (selection) {
      if (selection) {
        return resolveFolderPick(selection)
      }
      // IndexedDB snapshots / leftover FileLists are frozen copies (this is
      // how self-update kept installing pm2-gui 0.6.12). Re-open the folder
      // so we always upload what is on disk now.
      setFolderPickStatus('Re-open “' + meta.folderName + '” to upload current files…')
      browseFolderFromPickModal()
    }).catch(function (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        setFolderPickStatus('')
        return
      }
      setFolderPickStatus('')
      toast(friendlyFolderReadError(err, meta.folderName), 'error')
    })
  }

  function collectFilesFromDirHandle (dirHandle, prefix, out) {
    return (async function walk () {
      for await (var entry of dirHandle.values()) {
        var name = entry.name
        if (UPDATE_EXCLUDE_RE.test(name)) continue
        var rel = prefix ? (prefix + '/' + name) : name
        if (entry.kind === 'directory') {
          await collectFilesFromDirHandle(entry, rel, out)
        } else if (entry.kind === 'file') {
          try {
            var file = await entry.getFile()
            var buffer = await readFileArrayBuffer(file)
            out.push({ file: cloneFileFromBuffer(buffer, file), relPath: rel })
          } catch (err) {
            if (isUnreadableFileError(err)) {
              console.warn('[upload-source] skip unreadable file:', rel)
              continue
            }
            throw err
          }
        }
      }
      return out
    })()
  }

  // Prefer File System Access API when HTTPS (no Chrome "Upload N files?" dialog).
  // On HTTP, use the app folder-pick modal with drag-and-drop (also avoids that dialog).
  function pickLocalProjectFolder () {
    return showFolderPickModal({
      title: 'Choose project folder',
      message: 'Drop a folder below, or browse. node_modules and .git are skipped.',
      sourceKey: 'create'
    })
  }

  function showFolderPickModal (options) {
    options = options || {}
    return new Promise(function (resolve) {
      if (state.folderPickResolver) {
        state.folderPickResolver(null)
      }
      state.folderPickResolver = resolve
      state.folderPickSourceKey = normalizeUploadSourceKey(options.sourceKey || 'default')

      var modal = document.getElementById('folder-pick-modal')
      var title = document.getElementById('folder-pick-title')
      var message = document.getElementById('folder-pick-message')
      var status = document.getElementById('folder-dropzone-status')
      if (title) title.textContent = options.title || 'Choose project folder'
      if (message) message.textContent = options.message || ''
      if (status) status.textContent = ''
      configureFolderPickPortUi(options)
      refreshFolderLastSourceUi(state.folderPickSourceKey)
      bindFolderDropzoneOnce()
      if (modal) modal.hidden = false
    })
  }

  function setFolderPickStatus (text) {
    var status = document.getElementById('folder-dropzone-status')
    if (status) status.textContent = text || ''
  }

  function bindFolderDropzoneOnce () {
    if (state.folderPickBound) return
    var dropzone = document.getElementById('folder-dropzone')
    if (!dropzone) return
    state.folderPickBound = true

    ;['dragenter', 'dragover'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (event) {
        event.preventDefault()
        event.stopPropagation()
        dropzone.classList.add('is-dragover')
      })
    })

    ;['dragleave', 'drop'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (evt === 'dragleave') dropzone.classList.remove('is-dragover')
      })
    })

    dropzone.addEventListener('drop', function (event) {
      dropzone.classList.remove('is-dragover')
      handleFolderDrop(event).catch(function (err) {
        toast(friendlyFolderReadError(err, 'dropped folder'), 'error')
        setFolderPickStatus('')
      })
    })
  }

  function handleFolderDrop (event) {
    var dt = event.dataTransfer
    if (!dt) return Promise.reject(new Error('Nothing was dropped'))

    var handlePromise = Promise.resolve(null)
    if (dt.items && dt.items.length && typeof DataTransferItem !== 'undefined') {
      for (var i = 0; i < dt.items.length; i++) {
        var item = dt.items[i]
        if (!item || item.kind !== 'file') continue
        if (typeof item.getAsFileSystemHandle === 'function') {
          handlePromise = Promise.resolve(item.getAsFileSystemHandle()).then(function (handle) {
            if (handle && handle.kind === 'directory') return handle
            return null
          }).catch(function () { return null })
          break
        }
      }
    }

    return handlePromise.then(function (dirHandle) {
      if (dirHandle) {
        setFolderPickStatus('Reading ' + dirHandle.name + '…')
        return selectionFromDirHandle(dirHandle).then(function (selection) {
          setFolderPickStatus('Ready: ' + selection.files.length + ' files')
          resolveFolderPick(selection)
        })
      }

      var dirEntry = null
      if (dt.items && dt.items.length) {
        for (var j = 0; j < dt.items.length; j++) {
          var dropItem = dt.items[j]
          if (!dropItem || dropItem.kind !== 'file') continue
          var entry = dropItem.webkitGetAsEntry ? dropItem.webkitGetAsEntry() : null
          if (entry && entry.isDirectory) {
            dirEntry = entry
            break
          }
        }
      }

      if (!dirEntry) {
        return Promise.reject(new Error('Drop a folder (not individual files)'))
      }

      setFolderPickStatus('Reading ' + dirEntry.name + '…')
      var collected = []
      return readDirectoryEntry(dirEntry, '', collected).then(function () {
        var selection = prepareUploadSelection(collected, dirEntry.name, null)
        setFolderPickStatus('Ready: ' + selection.files.length + ' files')
        resolveFolderPick(selection)
      })
    })
  }

  function readDirectoryEntry (dirEntry, prefix, out) {
    return new Promise(function (resolve, reject) {
      var reader = dirEntry.createReader()
      function readBatch () {
        reader.readEntries(function (entries) {
          if (!entries.length) {
            resolve(out)
            return
          }
          var chain = Promise.resolve()
          entries.forEach(function (entry) {
            chain = chain.then(function () {
              if (!entry || UPDATE_EXCLUDE_RE.test(entry.name)) return null
              var rel = prefix ? (prefix + '/' + entry.name) : entry.name
              if (entry.isDirectory) {
                return readDirectoryEntry(entry, rel, out)
              }
              return new Promise(function (fileResolve, fileReject) {
                entry.file(function (file) {
                  out.push({ file: file, relPath: rel })
                  fileResolve()
                }, fileReject)
              })
            })
          })
          chain.then(readBatch).catch(reject)
        }, reject)
      }
      readBatch()
    })
  }

  function browseFolderFromPickModal () {
    setFolderPickStatus('Opening folder picker…')
    var sourceKey = state.folderPickSourceKey
    var pickerPromise = Promise.resolve(null)
    if (supportsDirectoryPicker() && sourceKey) {
      pickerPromise = loadUploadSourceHandle(sourceKey).catch(function () { return null })
    }

    var picker = pickerPromise.then(function (savedHandle) {
      if (supportsDirectoryPicker()) {
        var opts = { mode: 'read' }
        if (savedHandle) opts.startIn = savedHandle
        return window.showDirectoryPicker(opts).then(function (dirHandle) {
          return selectionFromDirHandle(dirHandle)
        })
      }
      return pickLocalProjectFolderViaInput()
    })

    Promise.resolve(picker).then(function (selection) {
      if (!selection) {
        setFolderPickStatus('')
        return
      }
      resolveFolderPick(selection)
    }).catch(function (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        setFolderPickStatus('')
        return
      }
      toast(friendlyFolderReadError(err, 'folder'), 'error')
      setFolderPickStatus('')
    })
  }

  function pickLocalProjectFolderViaInput () {
    return new Promise(function (resolve) {
      var input = document.getElementById('project-update-folder') ||
        document.getElementById('project-create-folder')
      if (!input) {
        input = document.createElement('input')
        input.type = 'file'
        input.setAttribute('webkitdirectory', '')
        input.setAttribute('directory', '')
        input.multiple = true
        input.style.display = 'none'
        document.body.appendChild(input)
      }
      input.value = ''
      input.onchange = function () {
        var files = Array.prototype.slice.call(input.files || [])
        input.onchange = null
        input.value = ''
        if (!files.length) {
          resolve(null)
          return
        }
        var folderName = folderNameFromFiles(files)
        var collected = files.map(function (file) {
          return { file: file, relPath: relativeUpdatePath(file) }
        })
        try {
          resolve(prepareUploadSelection(collected, folderName, null))
        } catch (err) {
          toast(err.message, 'error')
          resolve(null)
        }
      }
      input.click()
    })
  }

  function prepareUploadSelection (collected, folderName, dirHandle) {
    var paths = []
    var uploadFiles = []
    var totalBytes = 0

    collected.forEach(function (item) {
      var rel = item.relPath
      if (!rel || isExcludedUpdatePath(rel)) return
      totalBytes += (item.file && item.file.size) || 0
      if (totalBytes > MAX_UPLOAD_BYTES) {
        throw new Error('Folder is larger than 200 MB after exclusions')
      }
      paths.push(rel)
      uploadFiles.push(item.file)
    })

    if (!uploadFiles.length) {
      throw new Error('No uploadable files found in that folder (after exclusions)')
    }

    return {
      folderName: folderName || 'project',
      displayPath: folderName || 'project',
      dirHandle: dirHandle || null,
      mode: 'files',
      files: uploadFiles,
      paths: paths,
      totalBytes: totalBytes
    }
  }

  function projectPickConfirmMessage (root, forUpdate) {
    if (forUpdate) {
      return 'Drag the updated project folder into the next dialog, or browse to select it.\n\n' +
        'It will overwrite matching files on the NAS. node_modules and .git are skipped.'
    }
    return 'Drag the project folder into the next dialog, or browse to select it.\n\n' +
      'It will be uploaded to:\n' + root + '/<folder-name>\n\n' +
      'then registered and started with PM2.\n\n' +
      'If that folder already exists, it will be overwritten.\n' +
      'node_modules and .git are skipped.'
  }

  function beginProjectUpdate (opts) {
    if (window.GUI.readonly) {
      toast('Server is in read-only mode', 'error')
      return
    }
    if (state.updating) {
      toast('An update is already in progress', 'error')
      return
    }

    var pathHint = opts.pathHint || ''
    if (opts.projectId) {
      var project = (state.savedProjects || []).find(function (p) { return p.id === opts.projectId })
      if (project) pathHint = project.path
    }

    var currentPort = ''
    if (opts.projectId) {
      var proj = (state.savedProjects || []).find(function (p) { return p.id === opts.projectId })
      if (proj && proj.servicePort) currentPort = String(proj.servicePort)
    } else if (opts.pmId != null) {
      var proc = findProcessByPmId(opts.pmId)
      var linked = findProjectForProcess(proc)
      if (linked && linked.servicePort) currentPort = String(linked.servicePort)
      else {
        var envPort = resolveProcessPort(proc, linked)
        if (envPort != null) currentPort = String(envPort)
      }
    }

    var message = pathHint
      ? ('Replace files in:\n' + pathHint + '\n\nDrop the folder from your laptop below, or browse.')
      : 'Drop the updated project folder below, or browse. Matching files on the NAS will be overwritten.'

    showFolderPickModal({
      title: 'Update project from laptop',
      message: message,
      askPort: true,
      currentPort: currentPort,
      sourceKey: resolveUploadSourceKey({
        projectId: opts.projectId,
        pmId: opts.pmId,
        pathHint: pathHint
      })
    }).then(function (selection) {
      if (!selection) return
      uploadProjectUpdate({
        projectId: opts.projectId || null,
        pmId: opts.pmId != null ? opts.pmId : null,
        button: opts.button || null,
        pathHint: pathHint,
        servicePort: String(selection.servicePort || '').trim()
      }, selection)
    }).catch(function (err) {
      toast(friendlyFolderReadError(err, pathHint), 'error')
    })
  }

  function setProjectActionsLocked (locked) {
    state.updating = !!locked
    var app = document.getElementById('app')
    if (app) {
      app.classList.toggle('is-updating', !!locked)
    }
  }

  function showUpdateProgressModal (title, subtitle) {
    var modal = document.getElementById('update-progress-modal')
    var titleEl = document.getElementById('update-progress-title')
    var subEl = document.getElementById('update-progress-subtitle')
    if (titleEl) titleEl.textContent = title || 'Updating project'
    if (subEl) subEl.textContent = subtitle || ''
    setUpdateProgress(0, 'Starting…')
    if (modal) modal.hidden = false
  }

  function hideUpdateProgressModal () {
    var modal = document.getElementById('update-progress-modal')
    if (modal) modal.hidden = true
  }

  function setUpdateProgress (percent, detail) {
    var fill = document.getElementById('update-progress-fill')
    var pct = document.getElementById('update-progress-percent')
    var detailEl = document.getElementById('update-progress-detail')
    var value = Math.max(0, Math.min(100, Math.round(percent || 0)))
    if (fill) fill.style.width = value + '%'
    if (pct) pct.textContent = value + '%'
    if (detailEl && detail != null) detailEl.textContent = detail
  }

  function uploadProjectUpdate (ctx, selection) {
    var url
    if (ctx.projectId) {
      url = '/projects_api/' + encodeURIComponent(ctx.projectId) + '/update'
    } else if (ctx.pmId != null) {
      url = '/processes_api/' + encodeURIComponent(ctx.pmId) + '/update'
    } else {
      toast('Missing project or process id', 'error')
      return
    }

    setProjectActionsLocked(true)
    showUpdateProgressModal(
      'Updating ' + (ctx.pathHint ? ctx.pathHint.split('/').pop() : 'project'),
      'Preparing upload…'
    )

    materializeSelection(selection).then(function (copied) {
      return selectionForTransport(copied, 'project-update.zip')
    }).then(function (ready) {
      var form = new FormData()
      if (ctx.servicePort) {
        form.append('servicePort', ctx.servicePort)
      }
      var isZip = ready && (ready.mode === 'zip' || ready.archive)
      var totalBytes = (ready && ready.totalBytes) || 0
      var labelCount
      if (isZip) {
        var zipFile = ready.archive || ready.files[0]
        form.append('archive', zipFile, zipFile.name || 'project.zip')
        labelCount = '1 ZIP'
      } else {
        form.append('paths', JSON.stringify(ready.paths || []))
        ;(ready.files || []).forEach(function (file, index) {
          var rel = (ready.paths && ready.paths[index]) || file.name
          form.append('file', file, rel)
        })
        labelCount = (ready.files || []).length + ' files'
      }

      setUpdateProgress(0, 'Uploading ' + labelCount + ' (' + formatBytes(totalBytes) + ')')

      var xhr = new XMLHttpRequest()
      var uploadFinished = false
      xhr.open('POST', url)
      xhr.withCredentials = true
      xhr.timeout = 0

      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) {
          setUpdateProgress(0, 'Uploading…')
          return
        }
        var pct = (event.loaded / event.total) * 90
        setUpdateProgress(pct, formatBytes(event.loaded) + ' / ' + formatBytes(event.total))
      }

      xhr.upload.onload = function () {
        uploadFinished = true
        setUpdateProgress(92, 'Upload complete — installing packages, then restarting…')
        var subEl = document.getElementById('update-progress-subtitle')
        if (subEl) subEl.textContent = 'Running pnpm/npm install for new dependencies…'
      }

      xhr.onerror = function () {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        toast(
          uploadFinished
            ? 'Connection lost while installing on the NAS. Check Logs / process status.'
            : 'Upload failed (network error). Try Browse folder again, or upload a smaller folder.',
          'error'
        )
      }

      xhr.ontimeout = function () {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        toast('Upload timed out', 'error')
      }

      xhr.onload = function () {
        var body = null
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : {}
        } catch (err) {
          setProjectActionsLocked(false)
          hideUpdateProgressModal()
          toast('Server returned non-JSON (HTTP ' + xhr.status + '). Restart pm2-gui if you just deployed.', 'error')
          return
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          setProjectActionsLocked(false)
          hideUpdateProgressModal()
          toast((body && body.error) || 'Update failed', 'error')
          return
        }

        setUpdateProgress(100, 'Done')
        var written = 0
        ;(body.steps || []).forEach(function (step) {
          if (step.step === 'merge') written = step.filesWritten || 0
        })

        setTimeout(function () {
          setProjectActionsLocked(false)
          hideUpdateProgressModal()
          toast('Updated ' + written + ' file(s) and restarted ' + (ctx.pathHint || 'app'))
          if (state.sockets.process && state.sockets.process.connected) {
            state.sockets.process.emit(EVENTS.PULL_PROCESSES)
          }
          loadSavedProjects()
        }, 400)
      }

      xhr.send(form)
    }).catch(function (err) {
      setProjectActionsLocked(false)
      hideUpdateProgressModal()
      toast(friendlyFolderReadError(err, ctx.pathHint || 'project'), 'error')
    })
  }

  function getProjectsRoot () {
    return (window.GUI.projectsRoot || '').trim()
  }

  function beginCreateProjectFromLaptop () {
    if (window.GUI.readonly) {
      toast('Server is in read-only mode', 'error')
      return
    }
    if (state.updating) {
      toast('Wait for the current upload to finish', 'error')
      return
    }

    var root = getProjectsRoot()
    if (!root) {
      toast('Set Default projects path in Settings → General first', 'error')
      showSettingsModal()
      switchSettingsTab('general')
      return
    }

    showFolderPickModal({
      title: 'Add project from laptop',
      message: 'Uploads to ' + root + '/<folder-name>, then installs and starts with PM2.\n' +
        'If that folder already exists, it will be overwritten.\n\n' +
        'Drop the project folder below (recommended), or browse.',
      sourceKey: 'create',
      askPort: true,
      currentPort: '',
      portPlaceholder: 'e.g. 3044',
      portHint: 'Leave blank to use the port already defined in the project (.env / ecosystem). Enter a number only if you want to set one.'
    }).then(function (selection) {
      if (!selection) return
      var targetHint = root.replace(/\/$/, '') + '/' + selection.folderName
      uploadCreateProject({
        folderName: selection.folderName,
        targetHint: targetHint,
        servicePort: String(selection.servicePort || '').trim(),
        mode: selection.mode,
        archive: selection.archive || null,
        files: selection.files,
        paths: selection.paths,
        totalBytes: selection.totalBytes
      })
    }).catch(function (err) {
      toast(friendlyFolderReadError(err, 'project'), 'error')
    })
  }

  function folderNameFromFiles (files) {
    for (var i = 0; i < files.length; i++) {
      var rel = (files[i].webkitRelativePath || files[i].name || '').replace(/\\/g, '/')
      var parts = rel.split('/').filter(Boolean)
      if (parts.length) return parts[0]
    }
    return ''
  }

  function uploadCreateProject (ctx) {
    var form = new FormData()
    form.append('folderName', ctx.folderName)
    form.append('start', '1')
    if (ctx.servicePort) {
      form.append('servicePort', ctx.servicePort)
    }

    var isZip = ctx.mode === 'zip' || ctx.archive
    var uploadLabel
    if (isZip) {
      var zipFile = ctx.archive || ctx.files[0]
      form.append('archive', zipFile, zipFile.name || (ctx.folderName + '.zip'))
      uploadLabel = '1 ZIP (' + formatBytes(ctx.totalBytes) + ')'
    } else {
      form.append('paths', JSON.stringify(ctx.paths || []))
      ;(ctx.files || []).forEach(function (file) {
        form.append('file', file, file.name)
      })
      uploadLabel = (ctx.files || []).length + ' files (' + formatBytes(ctx.totalBytes) + ')'
    }

    setProjectActionsLocked(true)
    showUpdateProgressModal(
      'Adding ' + ctx.folderName,
      'Uploading ' + uploadLabel + ' → ' + ctx.targetHint
    )

    var xhr = new XMLHttpRequest()
    xhr.open('POST', '/projects_api/create_from_upload')
    xhr.withCredentials = true

    xhr.upload.onprogress = function (event) {
      if (!event.lengthComputable) {
        setUpdateProgress(0, 'Uploading…')
        return
      }
      var pct = (event.loaded / event.total) * 90
      setUpdateProgress(pct, formatBytes(event.loaded) + ' / ' + formatBytes(event.total))
    }

    xhr.upload.onload = function () {
      setUpdateProgress(92, 'Upload complete — installing dependencies, then starting…')
      var subEl = document.getElementById('update-progress-subtitle')
      if (subEl) subEl.textContent = 'Running pnpm/npm install and registering the project…'
    }

    xhr.onerror = function () {
      setProjectActionsLocked(false)
      hideUpdateProgressModal()
      toast('Upload failed (network error)', 'error')
    }

    xhr.onload = function () {
      var body = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {}
      } catch (err) {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        toast('Server returned non-JSON (HTTP ' + xhr.status + '). Restart pm2-gui if you just deployed.', 'error')
        return
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        toast((body && body.error) || 'Could not create project', 'error')
        return
      }

      setUpdateProgress(100, 'Done')
      setTimeout(function () {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        var name = (body.project && body.project.name) || ctx.folderName
        var overwritten = Array.isArray(body.steps) && body.steps.some(function (s) {
          return s && s.step === 'overwrite'
        })
        if (body.warning) {
          toast(body.warning, 'error')
        } else if (overwritten) {
          toast('Overwrote existing folder and started ' + name)
        } else {
          toast('Added and started ' + name)
        }
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
        loadSavedProjects()
      }, 400)
    }

    xhr.send(form)
  }

  function loadSetupStatus () {
    fetch('/status_api', { credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        state.setupData = data
        renderSetupStatus(data)
      })
      .catch(function () {
        if (els.setupStatus) {
          els.setupStatus.innerHTML = '<div class="setup-alert">Could not load setup status from the server.</div>'
        }
      })
  }

  function renderSetupStatus (data) {
    if (!els.setupSteps || !data) {
      return
    }

    var checks = [
      { ok: data.homeExists, label: 'PM2 home exists', detail: data.pm2Home },
      { ok: data.socketsExist, label: 'PM2 daemon is running', detail: data.socketsExist ? 'rpc.sock and pub.sock found' : 'Run `pm2 ls` to start the daemon' },
      { ok: data.pm2Connected, label: 'PM2 API reachable', detail: data.pm2Error || (data.pm2Version ? 'PM2 v' + data.pm2Version : 'Connected') }
    ]

    els.setupStatus.innerHTML = checks.map(function (item) {
      return '<div class="setup-check ' + (item.ok ? 'ok' : 'fail') + '"><strong>' + escapeHtml(item.label) + '</strong><span>' + escapeHtml(item.detail || '') + '</span></div>'
    }).join('')

    if (Array.isArray(data.steps)) {
      els.setupSteps.innerHTML = data.steps.map(function (step, index) {
        return (
          '<li class="' + (step.done ? 'done' : '') + '">' +
            '<span class="step-num">' + (index + 1) + '</span>' +
            '<div><strong>' + escapeHtml(step.title) + '</strong>' +
            '<code>' + escapeHtml(step.command) + '</code></div>' +
          '</li>'
        )
      }).join('')
    }
  }

  function showSetupModal (message) {
    if (!els.setupModal) {
      return
    }
    els.setupSummary.textContent = message || 'Additional setup is required before pm2-gui can connect to PM2.'
    els.setupModal.hidden = false
    loadSetupStatus()
  }

  function hideSetupModal () {
    if (els.setupModal) {
      els.setupModal.hidden = true
    }
  }

  function copySetupCommands () {
    var commands = [
      'npm install -g pm2',
      'pm2 ls',
      'cd /path/to/pm2-gui && npm install && npm start'
    ]
    if (state.setupData && Array.isArray(state.setupData.steps)) {
      commands = state.setupData.steps.map(function (step) { return step.command })
    }
    navigator.clipboard.writeText(commands.join('\n')).then(function () {
      toast('Setup commands copied to clipboard.')
    }).catch(function () {
      toast('Could not copy commands automatically.', 'error')
    })
  }

  function showFatal (message) {
    if (els.processList) {
      els.processList.innerHTML = '<tr><td colspan="9"><div class="empty-state">' + escapeHtml(message) + '</div></td></tr>'
    }
    showSetupModal(message)
  }

  function openProcessModal (pmId) {
    var proc = findProcessByPmId(pmId)
    if (!proc) {
      return
    }

    state.selectedProc = proc
    els.modalTitle.textContent = proc.name || 'Process'
    els.modalSubtitle.textContent = 'ID ' + proc.pm_id + ' · PID ' + (proc.pid || '—')
    els.modalInfo.textContent = formatProcessInfo(proc)
    els.modalLog.textContent = 'Waiting for logs...'
    state.monitorData = []
    state.logAutoScroll = true
    els.modal.hidden = false
    switchTab('info')
    startLogTail(proc.pm_id)
    startMonitor(proc.pid)
  }

  function closeModal () {
    els.modal.hidden = true
    state.selectedProc = null
    closeLogSocket()
    stopMonitor()
  }

  function switchTab (tabName) {
    document.querySelectorAll('#process-modal .tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === tabName)
    })
    document.querySelectorAll('#process-modal .tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'tab-' + tabName)
    })

    if (tabName === 'monitor' && state.selectedProc) {
      drawMonitorChart()
    }
  }

  function formatProcessInfo (proc) {
    var env = proc.pm2_env || {}
    return [
      'name: ' + (proc.name || ''),
      'pm_id: ' + proc.pm_id,
      'pid: ' + (proc.pid || 0),
      'status: ' + (env.status || ''),
      'mode: ' + (env.exec_mode || ''),
      'restarts: ' + (env.restart_time || 0),
      'exec path: ' + (env.pm_exec_path || ''),
      'user: ' + (env.user || env.USER || ''),
      'created: ' + (env.created_at ? new Date(env.created_at).toLocaleString() : '—')
    ].join('\n')
  }

  function startLogTail (pmId) {
    closeLogSocket()
    state.sockets.log = connectSocket(getCurrentConnection(), NSP.LOG)
    state.sockets.log.on(EVENTS.CONNECT, function () {
      state.sockets.log.emit(EVENTS.PULL_LOGS, pmId, true)
    })
    state.sockets.log.on(EVENTS.DATA, function (payload) {
      if (!state.selectedProc || String(payload.id) !== String(state.selectedProc.pm_id)) {
        return
      }
      appendLog(payload.text || '')
    })
    state.sockets.log.on(EVENTS.ERROR, function (payload) {
      if (payload && payload.error) {
        appendLog(payload.error)
      }
    })
  }

  function closeLogSocket () {
    if (state.sockets.log) {
      state.sockets.log.emit(EVENTS.PULL_LOGS_END)
      state.sockets.log.disconnect()
      state.sockets.log = null
    }
  }

  function getLastLogLines (text, count) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop()
    }
    return lines.slice(-count).join('\n')
  }

  function copyProcessLog () {
    var text = els.modalLog ? els.modalLog.textContent : ''
    var trimmed = (text || '').trim()
    if (!trimmed || /^waiting for logs/i.test(trimmed)) {
      toast('Nothing to copy', 'error')
      return
    }
    var snippet = getLastLogLines(text, 50)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(snippet).then(function () {
        toast('Last 50 log lines copied')
      }).catch(function () {
        fallbackCopyText(snippet)
      })
      return
    }
    fallbackCopyText(snippet)
  }

  function appendLog (text) {
    if (!text) {
      return
    }
    var current = els.modalLog.textContent || ''
    if (/waiting for logs/i.test(current.trim())) {
      els.modalLog.textContent = ''
    }
    els.modalLog.appendChild(document.createTextNode(text + '\n'))
    if (state.logAutoScroll) {
      els.modalLog.scrollTop = els.modalLog.scrollHeight
    }
  }

  function startMonitor (pid) {
    stopMonitor()
    if (!pid) {
      return
    }

    state.sockets.monitor = connectSocket(getCurrentConnection(), NSP.PROCESS)
    state.sockets.monitor.on(EVENTS.CONNECT, function () {
      state.sockets.monitor.emit(EVENTS.PULL_USAGE, pid)
    })
    state.sockets.monitor.on(EVENTS.DATA_USAGE, function (payload) {
      if (!state.selectedProc || payload.pid !== state.selectedProc.pid) {
        return
      }
      state.monitorData.push(payload)
      if (state.monitorData.length > 60) {
        state.monitorData.shift()
      }
      if (document.querySelector('#tab-monitor.active')) {
        drawMonitorChart()
      }
    })
  }

  function stopMonitor () {
    if (state.sockets.monitor) {
      state.sockets.monitor.disconnect()
      state.sockets.monitor = null
    }
    state.monitorData = []
  }

  function drawMonitorChart () {
    var canvas = els.monitorChart
    if (!canvas) {
      return
    }
    var ctx = canvas.getContext('2d')
    var width = canvas.width
    var height = canvas.height
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, width, height)

    if (!state.monitorData.length) {
      ctx.fillStyle = '#64748b'
      ctx.font = '14px Inter, sans-serif'
      ctx.fillText('Collecting metrics...', 20, 40)
      return
    }

    var padding = 30
    var chartWidth = width - padding * 2
    var chartHeight = height - padding * 2

    function plotLine (key, color) {
      ctx.beginPath()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      state.monitorData.forEach(function (point, index) {
        var x = padding + (index / Math.max(state.monitorData.length - 1, 1)) * chartWidth
        var value = key === 'cpu' ? (point.usage.cpu || 0) : (point.usage.memory || 0)
        var y = padding + chartHeight - (Math.min(value, 100) / 100) * chartHeight
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)'
    for (var i = 0; i <= 4; i++) {
      var y = padding + (chartHeight / 4) * i
      ctx.beginPath()
      ctx.moveTo(padding, y)
      ctx.lineTo(width - padding, y)
      ctx.stroke()
    }

    plotLine('cpu', '#6366f1')
    plotLine('memory', '#22d3ee')
  }

  function getCurrentConnection () {
    if (els.agentSelect) {
      return els.agentSelect.value
    }
    return window.GUI.connections[window.GUI.connections.length - 1].value
  }

  function toast (message, type) {
    var node = document.createElement('div')
    node.className = 'toast' + (type ? ' ' + type : '')
    node.textContent = message
    els.toastContainer.appendChild(node)
    setTimeout(function () { node.remove() }, 5000)
  }

  function showConfirmModal (options) {
    options = options || {}
    return new Promise(function (resolve) {
      if (state.confirmResolver) {
        state.confirmResolver(false)
      }
      state.confirmRunOnConfirm = typeof options.runOnConfirm === 'function'
        ? options.runOnConfirm
        : null
      state.confirmResolver = resolve

      var modal = document.getElementById('confirm-modal')
      var title = document.getElementById('confirm-title')
      var message = document.getElementById('confirm-message')
      var okBtn = document.getElementById('confirm-ok')
      if (title) title.textContent = options.title || 'Confirm'
      if (message) message.textContent = options.message || ''
      if (okBtn) {
        okBtn.textContent = options.confirmLabel || 'Confirm'
        okBtn.classList.toggle('btn-confirm-danger', !!options.danger)
        okBtn.classList.toggle('btn-primary', !options.danger)
      }
      if (modal) modal.hidden = false
    })
  }

  function resolveConfirm (ok) {
    var modal = document.getElementById('confirm-modal')
    if (modal) modal.hidden = true
    var resolver = state.confirmResolver
    var runOnConfirm = state.confirmRunOnConfirm
    state.confirmResolver = null
    state.confirmRunOnConfirm = null
    var okBtn = document.getElementById('confirm-ok')
    if (okBtn) {
      okBtn.classList.remove('btn-confirm-danger')
      okBtn.classList.add('btn-primary')
    }
    if (!resolver) return
    if (!ok) {
      resolver(false)
      return
    }
    if (!runOnConfirm) {
      resolver(true)
      return
    }
    // Run picker synchronously inside the click stack so showDirectoryPicker keeps user activation.
    try {
      Promise.resolve(runOnConfirm()).then(function (result) {
        resolver(result)
      }, function (err) {
        toast((err && err.message) || String(err), 'error')
        resolver(false)
      })
    } catch (err) {
      toast((err && err.message) || String(err), 'error')
      resolver(false)
    }
  }

  function showPromptModal (options) {
    options = options || {}
    return new Promise(function (resolve) {
      if (state.promptResolver) {
        state.promptResolver(null)
      }
      state.promptResolver = resolve

      var modal = document.getElementById('prompt-modal')
      var title = document.getElementById('prompt-title')
      var message = document.getElementById('prompt-message')
      var input = document.getElementById('prompt-input')
      if (title) title.textContent = options.title || 'Input required'
      if (message) message.textContent = options.message || ''
      if (input) {
        input.type = options.inputType || 'text'
        input.placeholder = options.placeholder || ''
        input.value = options.defaultValue != null ? options.defaultValue : (options.value || '')
        input.autocomplete = options.autocomplete || 'off'
      }
      if (modal) modal.hidden = false
      setTimeout(function () {
        if (input) input.focus()
      }, 50)
    })
  }

  var editProcessContext = null

  function hideEditProcessModal () {
    editProcessContext = null
    var modal = document.getElementById('edit-process-modal')
    if (modal) modal.hidden = true
    var saveBtn = document.getElementById('edit-process-save')
    if (saveBtn) {
      saveBtn.disabled = false
      saveBtn.textContent = 'Save & restart'
    }
  }

  function beginEditProcess (opts) {
    opts = opts || {}
    if (window.GUI.readonly) {
      toast('Server is in read-only mode', 'error')
      return
    }

    var name = ''
    var port = ''
    var subtitle = ''

    if (opts.projectId) {
      var project = (state.savedProjects || []).find(function (p) { return p.id === opts.projectId })
      if (!project) {
        toast('Saved project not found', 'error')
        return
      }
      name = project.name || ''
      port = project.servicePort != null ? String(project.servicePort) : ''
      subtitle = project.path || ''
      editProcessContext = { projectId: project.id }
    } else if (opts.pmId != null) {
      var proc = state.processes.find(function (p) { return String(p.pm_id) === String(opts.pmId) })
      if (!proc) {
        toast('Process not found', 'error')
        return
      }
      var linked = findProjectForProcess(proc)
      // Prefer PM2 display name (bold label in the table), not the folder basename.
      name = proc.name || (linked && linked.name) || ''
      var resolvedPort = resolveProcessPort(proc, linked)
      port = resolvedPort != null ? String(resolvedPort) : ''
      subtitle = (linked && linked.path) || (proc.pm2_env && proc.pm2_env.pm_cwd) || ('ID ' + proc.pm_id)
      editProcessContext = { pmId: proc.pm_id }
    } else {
      toast('Missing process or project', 'error')
      return
    }

    var titleEl = document.getElementById('edit-process-title')
    var subEl = document.getElementById('edit-process-subtitle')
    var nameInput = document.getElementById('edit-process-name')
    var portInput = document.getElementById('edit-process-port')
    var modal = document.getElementById('edit-process-modal')
    if (titleEl) titleEl.textContent = 'Edit process'
    if (subEl) subEl.textContent = subtitle
    if (nameInput) nameInput.value = name
    if (portInput) portInput.value = port
    if (modal) modal.hidden = false
    setTimeout(function () {
      if (nameInput) nameInput.focus()
    }, 50)
  }

  function saveEditProcess () {
    if (!editProcessContext || window.GUI.readonly) return

    var nameInput = document.getElementById('edit-process-name')
    var portInput = document.getElementById('edit-process-port')
    var name = nameInput ? nameInput.value.trim() : ''
    var port = portInput ? portInput.value.trim() : ''
    if (!name) {
      toast('Name is required', 'error')
      if (nameInput) nameInput.focus()
      return
    }

    var url
    if (editProcessContext.projectId) {
      url = '/projects_api/' + encodeURIComponent(editProcessContext.projectId) + '/edit'
    } else if (editProcessContext.pmId != null) {
      url = '/processes_api/' + encodeURIComponent(editProcessContext.pmId) + '/edit'
    } else {
      toast('Missing process or project', 'error')
      return
    }

    var saveBtn = document.getElementById('edit-process-save')
    if (saveBtn) {
      saveBtn.disabled = true
      saveBtn.textContent = 'Saving…'
    }

    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, servicePort: port })
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not save changes')
        }
        hideEditProcessModal()
        if (result.body.warning) {
          toast(result.body.warning, 'error')
        } else {
          toast('Saved and restarted ' + name)
        }
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message || 'Could not save changes', 'error')
        if (saveBtn) {
          saveBtn.disabled = false
          saveBtn.textContent = 'Save & restart'
        }
      })
  }

  function resolvePrompt (value) {
    var modal = document.getElementById('prompt-modal')
    if (modal) modal.hidden = true
    var resolver = state.promptResolver
    state.promptResolver = null
    if (resolver) resolver(value)
  }

  function formatBytes (bytes) {
    bytes = Number(bytes) || 0
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
    return (bytes / 1073741824).toFixed(2) + ' GB'
  }

  function formatPercent (value) {
    return (Number(value) || 0).toFixed(1) + '%'
  }

  function formatDuration (seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0))
    var days = Math.floor(seconds / 86400)
    var hours = Math.floor((seconds % 86400) / 3600)
    var minutes = Math.floor((seconds % 3600) / 60)
    var secs = seconds % 60
    if (days > 0) return days + 'd ' + hours + 'h'
    if (hours > 0) return hours + 'h ' + minutes + 'm'
    if (minutes > 0) return minutes + 'm ' + secs + 's'
    return secs + 's'
  }

  function showSettingsModal () {
    if (!els.settingsModal) return
    els.settingsModal.hidden = false
    switchSettingsTab('general')
    loadSettings()
  }

  function hideSettingsModal () {
    if (els.settingsModal) els.settingsModal.hidden = true
  }

  function switchSettingsTab (name) {
    document.querySelectorAll('#settings-tabs .tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.settingsTab === name)
    })
    document.querySelectorAll('#settings-modal .settings-body .tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'settings-tab-' + name)
    })
  }

  function loadSettings () {
    fetch('/settings_api', {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not load settings')
        fillSettingsForm(result.body)
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function fillSettingsForm (data) {
    var s = data.settings || {}
    var a = data.auth || {}
    var t = data.telegram || {}

    setVal('setting-public-host', s.public_host || '')
    setVal('setting-public-protocol', s.public_protocol || 'http')
    setVal('setting-projects-root', s.projects_root || '')
    setVal('setting-refresh', s.refresh || '5s')
    setVal('setting-process-refresh', s.process_refresh || '3s')
    setChecked('setting-readonly', !!s.readonly)
    setChecked('setting-debug-enabled', !!s.debug_enabled)
    syncDebugLogButton(!!s.debug_enabled)

    setChecked('setting-auth-enabled', !!a.enabled)
    setChecked('setting-require-2fa', !!a.require2fa)
    setVal('setting-session-hours', a.sessionTimeoutHours || 24)
    setVal('setting-max-attempts', a.maxLoginAttempts || 5)
    setVal('setting-lockout', a.lockoutMinutes || 15)

    setChecked('setting-tg-enabled', !!t.enabled)
    setVal('setting-tg-token', t.botToken || '')
    setVal('setting-tg-chat', t.chatId || '')
    setChecked('setting-tg-restart', t.notifyRestart !== false)
    setChecked('setting-tg-error', t.notifyError !== false)
    setChecked('setting-tg-stop', t.notifyStop !== false)
    setChecked('setting-tg-exit', t.notifyExit !== false)
    setChecked('setting-tg-online', !!t.notifyOnline)

    var hint = document.getElementById('settings-data-dir')
    if (hint) {
      hint.textContent = 'Database: ' + (data.dbPath || '—')
    }

    var list = document.getElementById('settings-user-list')
    if (list) {
      list.innerHTML = (data.users || []).map(function (u) {
        return '<li><span><strong>' + escapeHtml(u.username) + '</strong>' +
          (u.totpEnabled ? ' · 2FA on' : ' · 2FA off') +
          '</span></li>'
      }).join('') || '<li><span>No users yet</span></li>'
    }

    renderApiKeyPanel(data.api)

    window.GUI.publicHost = s.public_host || ''
    window.GUI.publicProtocol = s.public_protocol || 'http'
    window.GUI.projectsRoot = s.projects_root || ''
    if (data.startup) {
      state.startup = data.startup
    }
    renderStartupPanel(state.startup)
  }

  function renderApiKeyPanel (api) {
    var statusEl = document.getElementById('api-key-status')
    var listEl = document.getElementById('api-key-list')
    api = api || { configured: false, keys: [] }

    if (statusEl) {
      if (api.configured && api.keys && api.keys.length) {
        statusEl.innerHTML = '<p class="add-project-hint">' +
          escapeHtml(String(api.keys.length)) + ' active key' + (api.keys.length === 1 ? '' : 's') +
          '. Auth header: <code>' + escapeHtml(api.header || 'Authorization: Bearer <key>') + '</code></p>'
      } else {
        statusEl.innerHTML = '<p class="add-project-hint">No API key configured yet.</p>'
      }
    }

    if (listEl) {
      listEl.innerHTML = (api.keys || []).map(function (key) {
        return '<li><span><strong>' + escapeHtml(key.name || 'default') + '</strong>' +
          ' · <code>' + escapeHtml(key.prefix || '') + '</code>' +
          (key.createdAt ? ' · created ' + escapeHtml(key.createdAt.slice(0, 10)) : '') +
          (key.lastUsedAt ? ' · last used ' + escapeHtml(key.lastUsedAt.slice(0, 10)) : '') +
          '</span><button type="button" class="btn btn-danger btn-sm" data-api-key-revoke="' +
          escapeHtml(key.id) + '">Revoke</button></li>'
      }).join('') || ''
    }
  }

  function showCreatedApiKey (created) {
    var panel = document.getElementById('api-key-created')
    var input = document.getElementById('setting-api-key-value')
    var preview = document.getElementById('api-key-env-preview')
    if (!created || !created.apiKey) return
    if (panel) panel.hidden = false
    if (input) input.value = created.apiKey
    if (preview) preview.textContent = created.envExample || ('PM2_GUI_API_KEY=' + created.apiKey)
  }

  function generateApiKey () {
    var btn = document.getElementById('setting-api-key-generate')
    if (btn) btn.disabled = true
    fetch('/settings_api/api_key/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ name: 'default' })
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not generate API key')
        renderApiKeyPanel(result.body.api)
        showCreatedApiKey(result.body.created)
        toast('API key generated — copy it now')
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        if (btn) btn.disabled = false
      })
  }

  function revokeApiKey (id) {
    if (!id) return
    showConfirmModal({
      title: 'Revoke API key',
      message: 'Clients using this key will immediately lose API access.'
    }).then(function (ok) {
      if (!ok) return
      return fetch('/settings_api/api_key/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ id: id })
      })
        .then(parseApiResponse)
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'Could not revoke key')
          renderApiKeyPanel(result.body.api)
          var panel = document.getElementById('api-key-created')
          if (panel) panel.hidden = true
          toast('API key revoked')
        })
    }).catch(function (err) {
      toast(err.message, 'error')
    })
  }

  function revokeAllApiKeys () {
    showConfirmModal({
      title: 'Revoke all API keys',
      message: 'All machine clients will lose API access until you generate a new key.'
    }).then(function (ok) {
      if (!ok) return
      return fetch('/settings_api/api_key/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ all: true })
      })
        .then(parseApiResponse)
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'Could not revoke keys')
          renderApiKeyPanel(result.body.api)
          var panel = document.getElementById('api-key-created')
          if (panel) panel.hidden = true
          toast('All API keys revoked')
        })
    }).catch(function (err) {
      toast(err.message, 'error')
    })
  }

  function copyApiKeyValue () {
    var input = document.getElementById('setting-api-key-value')
    var value = input && input.value
    if (!value) {
      toast('Generate a key first', 'error')
      return
    }
    copyToClipboard(value, 'API key copied')
  }

  function copyApiKeyEnvLine () {
    var input = document.getElementById('setting-api-key-value')
    var preview = document.getElementById('api-key-env-preview')
    var line = (preview && preview.textContent) ||
      (input && input.value ? 'PM2_GUI_API_KEY=' + input.value : '')
    if (!line) {
      toast('Generate a key first', 'error')
      return
    }
    copyToClipboard(line, '.env line copied')
  }

  function renderStartupPanel (startup) {
    var statusEl = document.getElementById('startup-status-text')
    var metaEl = document.getElementById('startup-meta')
    var stepsEl = document.getElementById('startup-instructions')
    if (!statusEl) return

    if (!startup || startup.error) {
      statusEl.textContent = (startup && startup.error) || 'Could not load startup status.'
      return
    }

    if (metaEl) {
      metaEl.innerHTML =
        '<div class="startup-kv"><span>App dir</span><code>' + escapeHtml(startup.appDir || '') + '</code></div>' +
        '<div class="startup-kv"><span>User home</span><code>' + escapeHtml(startup.userHome || '') + '</code></div>' +
        '<div class="startup-kv"><span>User</span><code>' + escapeHtml(startup.owner || '') + '</code></div>' +
        '<div class="startup-kv"><span>Command</span><code id="startup-command">' + escapeHtml(startup.command || '') + '</code></div>' +
        '<div class="startup-kv"><span>Script</span><code>' + escapeHtml(startup.scriptPath || '') + '</code></div>'
    }

    setVal('setting-startup-app-dir', startup.appDir || '')
    setVal('setting-startup-user-home', startup.userHome || '')

    if (startup.warning) {
      statusEl.textContent = startup.warning
    } else if (startup.existingTask) {
      statusEl.textContent = 'Boot task already exists in Task Scheduler ("' + startup.taskName + '", id ' + startup.existingTask.id + ').'
    } else if (startup.bootEnabled) {
      statusEl.textContent = 'Boot start was configured earlier via ' + (startup.lastMethod || 'an automated method') + '.'
    } else if (startup.synology) {
      statusEl.textContent = 'Synology detected. You can try automatic creation, or follow the manual steps.'
    } else {
      statusEl.textContent = 'Not running on Synology. Set Synology paths below only if you will copy the script to the NAS; prefer generating it on the NAS.'
    }

    if (stepsEl && startup.instructions && Array.isArray(startup.instructions.steps)) {
      stepsEl.innerHTML = startup.instructions.steps.map(function (step, index) {
        return '<li><span class="step-num">' + (index + 1) + '</span><div><strong>' + escapeHtml(step) + '</strong></div></li>'
      }).join('')
    }
  }

  function createStartupTask () {
    var btn = document.getElementById('setting-startup-create')
    var resultEl = document.getElementById('startup-result')
    if (btn) {
      btn.disabled = true
      btn.textContent = 'Creating…'
    }
    fetch('/settings_api/startup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        appDir: getVal('setting-startup-app-dir').trim(),
        userHome: getVal('setting-startup-user-home').trim()
      })
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not create boot task')
        if (resultEl) {
          resultEl.hidden = false
          if (result.body.ok) {
            resultEl.className = 'startup-result ok'
            resultEl.textContent = 'Boot start configured via ' + (result.body.method || 'automation') +
              (result.body.note ? '. ' + result.body.note : '')
            toast('Boot start configured')
          } else {
            resultEl.className = 'startup-result fail'
            resultEl.textContent = (result.body.error || result.body.note || 'Automatic creation failed.') +
              ' Follow the manual steps below.'
            toast(result.body.error || 'Automatic creation failed — see manual steps', 'error')
          }
        }
        loadSettings()
      })
      .catch(function (err) {
        if (resultEl) {
          resultEl.hidden = false
          resultEl.className = 'startup-result fail'
          resultEl.textContent = err.message
        }
        toast(err.message, 'error')
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false
          btn.textContent = 'Create / update boot task'
        }
      })
  }

  function copyStartupCommand () {
    var commandEl = document.getElementById('startup-command')
    var command = commandEl ? commandEl.textContent : (state.startup && state.startup.command) || ''
    if (!command) {
      toast('No command available yet.', 'error')
      return
    }
    navigator.clipboard.writeText(command).then(function () {
      toast('Boot command copied')
    }).catch(function () {
      toast('Could not copy automatically.', 'error')
    })
  }

  function setVal (id, value) {
    var el = document.getElementById(id)
    if (el) el.value = value
  }

  function setChecked (id, value) {
    var el = document.getElementById(id)
    if (el) el.checked = !!value
  }

  function getVal (id) {
    var el = document.getElementById(id)
    return el ? el.value : ''
  }

  function getChecked (id) {
    var el = document.getElementById(id)
    return !!(el && el.checked)
  }

  function syncDebugLogButton (enabled) {
    var btn = document.getElementById('setting-debug-view-log')
    if (btn) btn.hidden = !enabled
  }

  function hideDebugLogModal () {
    var modal = document.getElementById('debug-log-modal')
    if (modal) modal.hidden = true
  }

  function openDebugLogModal () {
    if (!getChecked('setting-debug-enabled')) {
      toast('Enable Debug and Save settings first', 'error')
      return
    }
    fetch('/settings_api/debug_log?lines=100', { credentials: 'same-origin' })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) {
          throw new Error((result.body && result.body.error) || 'Could not load log')
        }
        var data = result.body || {}
        var pathEl = document.getElementById('debug-log-path')
        var textEl = document.getElementById('debug-log-text')
        if (pathEl) {
          pathEl.textContent = (data.path || 'no log file') +
            ' · ' + (data.lineCount || 0) + ' lines'
        }
        if (textEl) textEl.textContent = data.text || ''
        var modal = document.getElementById('debug-log-modal')
        if (modal) modal.hidden = false
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function copyDebugLog () {
    var textEl = document.getElementById('debug-log-text')
    var text = textEl ? textEl.textContent : ''
    if (!text) {
      toast('Nothing to copy', 'error')
      return
    }
    copyToClipboard(text, 'Log copied')
  }

  function copyToClipboard (text, successMessage) {
    successMessage = successMessage || 'Copied'
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(successMessage)
      }).catch(function () {
        fallbackCopyText(text, successMessage)
      })
      return
    }
    fallbackCopyText(text, successMessage)
  }

  function fallbackCopyText (text, successMessage) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.padding = '0'
    ta.style.border = 'none'
    ta.style.outline = 'none'
    ta.style.boxShadow = 'none'
    ta.style.background = 'transparent'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    try {
      var ok = document.execCommand('copy')
      if (ok) toast(successMessage || 'Copied')
      else toast('Could not copy — select the key and copy manually', 'error')
    } catch (err) {
      toast('Could not copy — select the key and copy manually', 'error')
    }
    document.body.removeChild(ta)
  }

  function beginSelfUpdate () {
    if (window.GUI.readonly) {
      toast('Server is in read-only mode', 'error')
      return
    }
    if (state.updating) {
      toast('Wait for the current upload to finish', 'error')
      return
    }

    showFolderPickModal({
      title: 'Update pm2-gui',
      message: 'Drop the pm2-gui project folder below, or browse.\n\n' +
        'Files are overwritten, npm install runs, then synology-start.sh restarts the dashboard.',
      sourceKey: 'self-update'
    }).then(function (selection) {
      if (!selection) return
      uploadSelfUpdate(selection)
    }).catch(function (err) {
      toast(friendlyFolderReadError(err, 'pm2-gui'), 'error')
    })
  }

  function uploadSelfUpdate (selection) {
    var form = new FormData()
    var isZip = selection && (selection.mode === 'zip' || selection.archive)
    var totalBytes = (selection && selection.totalBytes) || 0
    var labelCount
    if (isZip) {
      var zipFile = selection.archive || selection.files[0]
      form.append('archive', zipFile, zipFile.name || 'pm2-gui.zip')
      labelCount = '1 ZIP'
    } else {
      form.append('paths', JSON.stringify(selection.paths || []))
      ;(selection.files || []).forEach(function (file) {
        form.append('file', file, file.name)
      })
      labelCount = (selection.files || []).length + ' files'
    }

    setProjectActionsLocked(true)
    showUpdateProgressModal(
      'Updating pm2-gui',
      'Uploading ' + labelCount + ' (' + formatBytes(totalBytes) + ')'
    )

    var xhr = new XMLHttpRequest()
    xhr.open('POST', '/settings_api/self_update')
    xhr.withCredentials = true

    xhr.upload.onprogress = function (event) {
      if (!event.lengthComputable) {
        setUpdateProgress(0, 'Uploading…')
        return
      }
      var pct = (event.loaded / event.total) * 85
      setUpdateProgress(pct, formatBytes(event.loaded) + ' / ' + formatBytes(event.total))
    }

    xhr.upload.onload = function () {
      setUpdateProgress(90, 'Upload complete — installing and scheduling restart…')
    }

    xhr.onerror = function () {
      setProjectActionsLocked(false)
      hideUpdateProgressModal()
      toast('Self-update failed (network error)', 'error')
    }

    xhr.onload = function () {
      var body = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {}
      } catch (err) {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        toast('Server returned non-JSON (HTTP ' + xhr.status + ')', 'error')
        return
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        setProjectActionsLocked(false)
        hideUpdateProgressModal()
        toast((body && body.error) || 'Self-update failed', 'error')
        return
      }

      setUpdateProgress(100, 'Restarting dashboard…')
      toast(body.message || 'pm2-gui updated — restarting in 5s…')
      setTimeout(function () {
        hideUpdateProgressModal()
        window.location.reload()
      }, 5000)
    }

    xhr.send(form)
  }

  function parseApiResponse (res) {
    return res.text().then(function (text) {
      var body = null
      var raw = text || ''
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch (err) {
        var snippet = raw.replace(/\s+/g, ' ').slice(0, 120)
        throw new Error(
          'Server returned non-JSON (HTTP ' + res.status + '). ' +
          'Restart pm2-gui so the settings API is loaded. ' +
          (snippet ? 'Got: ' + snippet : '')
        )
      }
      return { ok: res.ok, status: res.status, body: body }
    })
  }

  function saveSettings () {
    var payload = {
      settings: {
        public_host: getVal('setting-public-host').trim(),
        public_protocol: getVal('setting-public-protocol'),
        projects_root: getVal('setting-projects-root').trim(),
        refresh: getVal('setting-refresh').trim() || '5s',
        process_refresh: getVal('setting-process-refresh').trim() || '3s',
        readonly: getChecked('setting-readonly'),
        debug_enabled: getChecked('setting-debug-enabled')
      },
      auth: {
        enabled: getChecked('setting-auth-enabled'),
        require2fa: getChecked('setting-require-2fa'),
        sessionTimeoutHours: parseInt(getVal('setting-session-hours'), 10) || 24,
        maxLoginAttempts: parseInt(getVal('setting-max-attempts'), 10) || 5,
        lockoutMinutes: parseInt(getVal('setting-lockout'), 10) || 15
      },
      telegram: {
        enabled: getChecked('setting-tg-enabled'),
        botToken: getVal('setting-tg-token').trim(),
        chatId: getVal('setting-tg-chat').trim(),
        notifyRestart: getChecked('setting-tg-restart'),
        notifyError: getChecked('setting-tg-error'),
        notifyStop: getChecked('setting-tg-stop'),
        notifyExit: getChecked('setting-tg-exit'),
        notifyOnline: getChecked('setting-tg-online')
      }
    }

    fetch('/settings_api/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not save settings')
        fillSettingsForm(result.body)
        toast('Settings saved')
        if (payload.settings.readonly !== window.GUI.readonly) {
          toast('Read-only mode change applies after reload')
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function createSettingsUser () {
    fetch('/settings_api/users', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: getVal('setting-new-username').trim(),
        password: getVal('setting-new-password')
      })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not create user')
        setVal('setting-new-username', '')
        setVal('setting-new-password', '')
        toast('User created')
        loadSettings()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function testTelegram () {
    fetch('/settings_api/telegram/test', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Telegram test failed')
        toast('Test message sent')
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function changeSettingsPassword () {
    fetch('/settings_api/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: getVal('setting-cur-password'),
        newPassword: getVal('setting-new-password')
      })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not change password')
        setVal('setting-cur-password', '')
        setVal('setting-new-password', '')
        toast('Password updated')
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function begin2faSetup () {
    fetch('/settings_api/2fa/begin', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not start 2FA setup')
        var setup = document.getElementById('settings-2fa-setup')
        var qr = document.getElementById('setting-2fa-qr')
        var secret = document.getElementById('setting-2fa-secret')
        if (setup) setup.hidden = false
        if (qr) qr.src = result.body.qrDataUrl
        if (secret) secret.textContent = 'Secret: ' + result.body.secret
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function confirm2faSetup () {
    fetch('/settings_api/2fa/confirm', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: getVal('setting-2fa-code') })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not confirm 2FA')
        toast('2FA enabled')
        var setup = document.getElementById('settings-2fa-setup')
        if (setup) setup.hidden = true
        loadSettings()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function disable2fa () {
    showPromptModal({
      title: 'Disable 2FA',
      message: 'Enter your password to disable two-factor authentication.',
      inputType: 'password',
      placeholder: 'Password',
      autocomplete: 'current-password'
    }).then(function (password) {
      if (password == null || password === '') return
      return showPromptModal({
        title: 'Disable 2FA',
        message: 'Enter a current authenticator code.',
        inputType: 'text',
        placeholder: '6-digit code',
        autocomplete: 'one-time-code'
      }).then(function (code) {
        if (code == null || code === '') return
        return fetch('/settings_api/2fa/disable', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password, code: code })
        })
          .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'Could not disable 2FA')
            toast('2FA disabled')
            loadSettings()
          })
      })
    }).catch(function (err) {
      toast(err.message, 'error')
    })
  }

  function logout () {
    fetch('/auth_api/logout', {
      method: 'POST',
      credentials: 'same-origin'
    }).finally(function () {
      window.location.href = '/auth'
    })
  }

  function escapeHtml (value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function escapeAttr (value) {
    return escapeHtml(value)
  }
})()
