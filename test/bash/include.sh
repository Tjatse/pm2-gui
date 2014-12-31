#!/usr/bin/env bash

node="`type -P node`"
nodeVersion="`$node -v`"

pg="`type -P node` `pwd`/bin/pm2-gui"

fixtures="test/fixtures"

function config(){
  local result=""
  if [[ "$OSTYPE" =~ ^darwin ]]; then
    result=`$pg config | grep "$1" | sed -E "s/$2/\1/"`
  else
    result=`$pg config | grep "$1" | sed -r "s/$2/\1/"`
  fi
  echo "$result"
}

function success {
  echo -e "\033[32m  ✔ $1\033[0m"
}

function fail {
  echo -e "######## \033[31m  ✘ $1\033[0m"
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
