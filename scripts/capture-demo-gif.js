#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const FRAMES_DIR = path.join(__dirname, '..', 'screenshots', '.demo-frames')
const OUTPUT_GIF = path.join(__dirname, '..', 'screenshots', 'pm2-gui.gif')
const URL = process.env.PM2_GUI_DEMO_URL || 'http://127.0.0.1:8088/?demo=1'
const WIDTH = 1280
const HEIGHT = 800

async function main () {
  const puppeteer = require('puppeteer')

  fs.mkdirSync(FRAMES_DIR, { recursive: true })
  fs.readdirSync(FRAMES_DIR).forEach(function (file) {
    fs.unlinkSync(path.join(FRAMES_DIR, file))
  })

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 }
  })

  const page = await browser.newPage()

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(function () {
    var version = document.getElementById('pm2-version')
    return version && version.textContent && version.textContent.indexOf('Connecting') === -1
  }, { timeout: 15000 })
  await sleep(1500)

  await maskPersonalInfo(page)
  await injectDemoProjects(page)

  var frame = 0
  async function shot (label) {
    frame += 1
    var file = path.join(FRAMES_DIR, 'frame-' + String(frame).padStart(3, '0') + '.png')
    await page.screenshot({ path: file })
    console.log('Captured', label, '->', path.basename(file))
  }

  await shot('dashboard-overview')
  await page.evaluate(function () { window.scrollTo(0, 420) })
  await sleep(600)
  await maskPersonalInfo(page)
  await shot('process-table')

  await page.evaluate(function () {
    var row = document.querySelector('[data-pmid]')
    if (row) row.click()
  })
  await sleep(800)
  await maskPersonalInfo(page)
  await maskModalInfo(page)
  await shot('process-modal-info')

  await page.evaluate(function () {
    var tab = document.querySelector('[data-tab="monitor"]')
    if (tab) tab.click()
  })
  await sleep(1200)
  await maskPersonalInfo(page)
  await maskModalInfo(page)
  await shot('process-modal-monitor')

  await page.evaluate(function () {
    var tab = document.querySelector('[data-tab="log"]')
    if (tab) tab.click()
  })
  await sleep(800)
  await maskPersonalInfo(page)
  await maskModalInfo(page)
  await shot('process-modal-logs')

  await page.evaluate(function () {
    var close = document.querySelector('[data-close="modal"]')
    if (close) close.click()
    window.scrollTo(0, 0)
  })
  await sleep(500)
  await maskPersonalInfo(page)
  await shot('dashboard-final')

  await browser.close()
  buildGif()
}

function maskPersonalInfo (page) {
  return page.evaluate(function () {
    var hostname = document.getElementById('stat-hostname')
    if (hostname) hostname.textContent = 'demo-server.local'

    var platform = document.getElementById('stat-platform')
    if (platform) platform.textContent = 'linux 6.8.0'

    document.querySelectorAll('.process-path').forEach(function (el) {
      el.textContent = '/home/demo/projects/sample-app'
      el.title = '/home/demo/projects/sample-app'
    })
  })
}

function maskModalInfo (page) {
  return page.evaluate(function () {
    var subtitle = document.getElementById('modal-subtitle')
    if (subtitle) subtitle.textContent = 'ID 0 · PID 12345'

    var info = document.getElementById('modal-info')
    if (info) {
      info.textContent = [
        'name: demo-api',
        'pm_id: 0',
        'pid: 12345',
        'status: online',
        'mode: fork_mode',
        'restarts: 0',
        'exec path: /home/demo/projects/sample-app/index.js',
        'user: demo',
        'created: 2026-01-01 12:00:00'
      ].join('\n')
    }

    var log = document.getElementById('modal-log')
    if (log) {
      log.textContent = '[out] demo-api ready on port 3000\n[out] listening for requests...\n[out] health check ok'
    }
  })
}

function injectDemoProjects (page) {
  return page.evaluate(function () {
    var list = document.getElementById('process-list')
    var count = document.getElementById('process-count')
    if (!list) return

    list.innerHTML = '' +
      '<tr class="is-saved" data-project-id="demo">' +
        '<td><span class="status-badge saved"><span class="status-dot"></span>saved</span></td>' +
        '<td><strong>sample-app</strong>' +
          '<span class="process-path" title="/home/demo/projects/sample-app">/home/demo/projects/sample-app</span>' +
          '<span class="process-entry">Entry: index.js</span></td>' +
        '<td>—</td><td><span class="mode-badge">—</span></td>' +
        '<td>—</td><td>—</td><td>—</td><td>—</td>' +
        '<td class="row-actions">' +
          '<button class="btn btn-icon" title="start">▶</button>' +
          '<button class="btn btn-icon" title="delete">✕</button>' +
        '</td>' +
      '</tr>'

    if (count) count.textContent = '1 app'
  })
}

function buildGif () {
  var palette = path.join(FRAMES_DIR, 'palette.png')

  execSync(
    'ffmpeg -y -framerate 1 -i "' + path.join(FRAMES_DIR, 'frame-%03d.png') + '" -vf "fps=8,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" -frames:v 1 -update 1 "' + palette + '"',
    { stdio: 'inherit' }
  )
  execSync(
    'ffmpeg -y -framerate 1 -i "' + path.join(FRAMES_DIR, 'frame-%03d.png') + '" -i "' + palette + '" -lavfi "fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" -loop 0 "' + OUTPUT_GIF + '"',
    { stdio: 'inherit' }
  )

  var stats = fs.statSync(OUTPUT_GIF)
  console.log('Wrote', OUTPUT_GIF, '(' + Math.round(stats.size / 1024) + ' KB)')
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true })
}

function sleep (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

main().catch(function (err) {
  console.error(err)
  process.exit(1)
})
