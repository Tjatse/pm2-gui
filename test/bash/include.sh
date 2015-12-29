#!/usr/bin/env bash

node="$(which node)"
nodeVersion="$($node -v)"
pg="$PWD/pm2-gui"
fixtures="test/fixtures"
pm2="$(which pm2)"

function success {
  echo -e "\033[32m  ✔ $1\033[0m"
}

function fail {
  echo -e "\033[31m  ✘ $1\033[0m"
  ps aux | grep pm2-gui | grep node | xargs kill -9
  exit 1
}

function spec {
  RET=$?
  sleep 0.3
  [ $RET -eq 0 ] || fail "$1"
  success "$1"
}

function ispec {
  RET=$?
  sleep 0.3
  [ $RET -ne 0 ] || fail "$1"
  success "$1"
}

function should {
  sleep 0.5
  OUT=`$pm2 prettylist | grep -o "$2" | wc -l`
  [ $OUT -eq $3 ] || fail "$1"
  success "$1"
}

function head {
  echo -e "\x1B[1;35m$1\x1B[0m"
}

if [ -z $pm2 ]; then
  npm="$(which npm)"
  $npm install pm2 -g
  pm2="$(which pm2)"
fi

