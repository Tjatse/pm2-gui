#!/usr/bin/env bash

SRC=$(cd $(dirname "$0"); pwd)
source "${SRC}/include.sh"

cd $fixtures

function port(){
  local result=""
  result=`netstat -an | grep "$1" | egrep "tcp" | grep "LISTEN"`
  echo "$result"
}

$pg set port 8088 > /dev/null

head "run web server (default port)"
nohup $pg start > /dev/null 2>&1 &
pid=$!
sleep 1
ret=$(port 8088)
[ ! -z "$ret" ] || fail "expect 127.0.0.1:8088 can be connected"
success "127.0.0.1:8088 should be connected"

kill "$pid"
sleep 1

ret=$(port 8088)
[ -z "$ret" ] || fail "expect 127.0.0.1:8088 can not be connected"
success "127.0.0.1:8088 should be disconnected"

head "run web server (customized port: 9000)"
nohup $pg start 9000 > /dev/null 2>&1 &
pid=$!
sleep 1
ret=$(port 9000)
[ ! -z "$ret" ] || fail "expect 127.0.0.1:9000 can be connected"
success "127.0.0.1:9000 should be connected"

kill "$pid"
sleep 1

ret=$(port 9000)
[ -z "$ret" ] || fail "expect 127.0.0.1:9000 can not be connected"
success "127.0.0.1:9000 should be disconnected"

head "run web server (--config verify)"
ret=`$pg start --config not_exist.ini | grep "does not exist" | wc -c`
[ "$ret" -gt 0 ] || fail "expect throw out error message"
success ".ini file does not exist"

head "run web server (--config specific file)"
nohup $pg start --config pm2-gui-cp > /dev/null 2>&1 &
pid=$!
sleep 1
ret=$(port 27130)
[ ! -z "$ret" ] || fail "expect 127.0.0.1:27130 can be connected"
success "127.0.0.1:27130 should be connected"

kill "$pid"
sleep 1

ret=$(port 27130)
[ -z "$ret" ] || fail "expect 127.0.0.1:27130 can not be connected"
success "127.0.0.1:27130 should be disconnected"

val=$(config "refresh:" "^[^0-9]*([0-9]+).*")
[ "$val" -eq 3000 ] || fail "expect the value of refresh to be 3000, but current is $val"
success "the value of refresh should be 3000"
val=$(config "debug:" ".*(true|false).*")
[ "$val" = false ] || fail "expect the value of debug to be false, but current is $val"
success "the value of debug should be false"
val=$(config "pm2:" ".*(\/.+).*")
[ ! "$val" = "/tmp/.pm2" ] || fail "expect the value of pm2 to be /tmp/.pm2"
success "the value of pm2 should be /tmp/.pm2"

head "run web server (--config default file)"
nohup $pg start --config > /dev/null 2>&1 &
pid=$!
sleep 1
ret=$(port 8088)
[ ! -z "$ret" ] || fail "expect 127.0.0.1:8088 can be connected"
success "127.0.0.1:8088 should be connected"

kill "$pid"
sleep 1

ret=$(port 8088)
[ -z "$ret" ] || fail "expect 127.0.0.1:8088 can not be connected"
success "127.0.0.1:8088 should be disconnected"

val=$(config "refresh:" "^[^0-9]*([0-9]+).*")
[ "$val" -eq 5000 ] || fail "expect the value of refresh to be 5000, but current is $val"
success "the value of refresh should be 3000"
val=$(config "debug:" ".*(true|false).*")
[ "$val" = true ] || fail "expect the value of debug to be true, but current is $val"
success "the value of debug should be true"
root="~/.pm2"
if [ ! -z "$PM2_HOME" ]; then
  root="$PM2_HOME"
else
  if [ ! -z "$HOME" ]; then
    root="$HOME/.pm2"
  else
    if [ ! -z "$HOMEPATH" ]; then
      root="$HOMEPATH/.pm2"
    fi
  fi
fi
val=$(config "pm2:" ".*(\/.+).*")
[ ! "$val" = "$root" ] || fail "expect the value of pm2 to be $root"
success "the value of pm2 should be $root"

$pg set port 8088 > /dev/null