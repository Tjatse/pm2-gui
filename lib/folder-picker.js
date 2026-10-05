'use strict'

var execFile = require('child_process').execFile
var os = require('os')

/**
 * Open a native folder picker dialog (local machine only).
 * @param {Object} options
 * @param {Function} fn callback(err, folderPath|null)
 */
function pickFolder (options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }
  options = options || {}

  var prompt = options.prompt || 'Select a project folder'

  if (process.platform === 'darwin') {
    var script = 'POSIX path of (choose folder with prompt "' + prompt.replace(/"/g, '\\"') + '")'
    return execFile('osascript', ['-e', script], { timeout: 300000 }, function (err, stdout) {
      if (err) {
        if (/User canceled/i.test(String(err.message || err))) {
          return fn(null, null)
        }
        return fn(err)
      }
      var folder = (stdout || '').trim()
      fn(null, folder || null)
    })
  }

  if (process.platform === 'win32') {
    var ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "' + prompt.replace(/"/g, '`"') + '"',
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  Write-Output $dialog.SelectedPath',
      '}'
    ].join('; ')
    return execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 300000 }, function (err, stdout) {
      if (err) {
        return fn(err)
      }
      var folder = (stdout || '').trim()
      fn(null, folder || null)
    })
  }

  execFile('zenity', ['--file-selection', '--directory', '--title=' + prompt], { timeout: 300000 }, function (err, stdout) {
    if (err) {
      if (err.code === 1) {
        return fn(null, null)
      }
      return fn(new Error('Native folder picker is unavailable on this host. Enter the folder path manually instead.'))
    }
    fn(null, (stdout || '').trim() || null)
  })
}

module.exports = {
  pickFolder: pickFolder
}
