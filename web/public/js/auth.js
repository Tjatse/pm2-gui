document.addEventListener('DOMContentLoaded', function () {
  'use strict'
  var form = document.getElementById('auth-form')
  var usernameEl = document.getElementById('auth-username')
  var passwordEl = document.getElementById('auth-password')
  var password2El = document.getElementById('auth-password2')
  var totpWrap = document.getElementById('auth-totp')
  var totpEl = document.getElementById('auth-totp-input')
  var errorEl = document.getElementById('auth-error')
  var mode = (document.getElementById('auth-mode') || {}).value || 'login'

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    errorEl.hidden = true

    if (mode === 'setup') {
      if (passwordEl.value !== password2El.value) {
        errorEl.textContent = 'Passwords do not match.'
        errorEl.hidden = false
        return
      }
      fetch('/auth_api/setup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameEl.value,
          password: passwordEl.value
        })
      })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
        .then(function (result) {
          if (!result.ok) {
            throw new Error(result.body.error || 'Setup failed')
          }
          window.location.href = '/'
        })
        .catch(function (err) {
          errorEl.textContent = err.message
          errorEl.hidden = false
        })
      return
    }

    fetch('/auth_api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameEl.value,
        password: passwordEl.value,
        totp: totpEl ? totpEl.value : ''
      })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body } }) })
      .then(function (result) {
        if (result.body.status === 200) {
          window.location.href = '/'
          return
        }
        if (result.body.needs2fa || result.body.needs2faSetup) {
          if (totpWrap) totpWrap.hidden = false
          if (totpEl) totpEl.focus()
          errorEl.textContent = result.body.needs2faSetup
            ? '2FA is required. Enter a code after enabling 2FA in Settings, or ask an admin.'
            : 'Enter your authentication code.'
          errorEl.hidden = false
          return
        }
        throw new Error(result.body.error || 'Authorization failed.')
      })
      .catch(function (err) {
        errorEl.textContent = err.message || 'Unable to reach the server.'
        errorEl.hidden = false
      })
  })
})
