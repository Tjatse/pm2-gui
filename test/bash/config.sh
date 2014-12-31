#!/usr/bin/env bash

SRC=$(cd $(dirname "$0"); pwd)
source "${SRC}/include.sh"

cd $fixtures

head "set config (Number)(refresh)"
$pg set refresh 4000 > /dev/null
val=$(config "refresh:" "^[^0-9]*([0-9]+).*")

[ "$val" -eq 4000 ] || fail "expect the value to be 4000, but current is $val"
success "the value should be 4000"

head "set config (Number)(port)"
$pg set port 9000 > /dev/null
val=$(config "port:" "^[^0-9]*([0-9]+).*")

[ "$val" -eq 9000 ] || fail "expect the value to be 9000, but current is $val"
success "the value should be 9000"

head "set config (Boolean)"
$pg set manipulation false > /dev/null
val=$(config "manipulation:" ".*(true|false).*")

[ "$val" = false ] || fail "expect the value to be false, but current is $val"
success "the value should be false"

head "set config (String)"
tmpPM2="/tmp/.pm2"

if [ ! -d "$tmpPM2" ]; then
  mkdir "$tmpPM2"
fi

$pg set pm2 "$tmpPM2" > /dev/null
val=$(config "pm2:" ".*(\/.+).*")

[ ! "$val" = "$tmpPM2" ] || fail "expect the value to be /tmp/.pm2"
success "the value should be /tmp/.pm2"

$pg set pm2 "~/.pm2" > /dev/null
$pg set port 8088 > /dev/null
