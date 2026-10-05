'use strict'

var fs = require('fs')
var path = require('path')
var pm = require('./pm')

function resolvePm2Home (pm2Home) {
  if (pm2Home && pm2Home.indexOf('~/') === 0) {
    return process.env.PM2_HOME || path.resolve(process.env.HOME || process.env.HOMEPATH, pm2Home.slice(2))
  }
  return pm2Home || process.env.PM2_HOME || path.resolve(process.env.HOME || process.env.HOMEPATH, '.pm2')
}

function getSetupStatus (options) {
  options = options || {}
  var pm2Home = resolvePm2Home(options.pm2)
  var rpcSock = path.join(pm2Home, 'rpc.sock')
  var pubSock = path.join(pm2Home, 'pub.sock')
  var homeExists = fs.existsSync(pm2Home)
  var socketsExist = fs.existsSync(rpcSock) && fs.existsSync(pubSock)

  return {
    pm2Home: pm2Home,
    homeExists: homeExists,
    socketsExist: socketsExist,
    daemonRunning: socketsExist,
    port: options.port || 8088,
    nodeVersion: process.version,
    steps: buildSteps(homeExists, socketsExist)
  }
}

function buildSteps (homeExists, socketsExist) {
  return [
    {
      id: 'node',
      title: 'Node.js 18+ installed',
      done: Number(process.version.slice(1).split('.')[0]) >= 18,
      command: 'node -v'
    },
    {
      id: 'pm2-install',
      title: 'Install PM2 globally',
      done: homeExists,
      command: 'npm install -g pm2'
    },
    {
      id: 'pm2-daemon',
      title: 'Start the PM2 daemon',
      done: socketsExist,
      command: 'pm2 ls'
    },
    {
      id: 'pm2-gui',
      title: 'Start pm2-gui',
      done: true,
      command: 'npm start'
    },
    {
      id: 'browser',
      title: 'Open the dashboard',
      done: false,
      command: 'open http://127.0.0.1:8088'
    }
  ]
}

function getSetupStatusAsync (options, fn) {
  var status = getSetupStatus(options)

  if (!status.socketsExist) {
    status.pm2Version = null
    status.processCount = 0
    status.pm2Connected = false
    return fn(null, status)
  }

  pm.list({ pm2Home: status.pm2Home }, function (err, procs) {
    status.pm2Connected = !err
    status.processCount = err ? 0 : (procs || []).length
    status.pm2Error = err ? err.message : null

    pm.getVersionInfo({ pm2Home: status.pm2Home }, function (verErr, info) {
      status.pm2Version = verErr ? null : (info && info.version)
      status.pm2DaemonVersion = verErr ? null : (info && info.daemon)
      status.pm2UpdateRecommended = !verErr && info && info.updateRecommended
      fn(null, status)
    })
  })
}

module.exports = {
  getSetupStatus: getSetupStatus,
  getSetupStatusAsync: getSetupStatusAsync
}
