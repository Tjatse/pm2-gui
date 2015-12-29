#!/usr/bin/env bash

SRC=$(cd $(dirname "$0"); pwd)
pipeFile="$SRC/pm2-gui"
iniConf="$SRC/pm2-gui.ini"
source "$SRC/include.sh"

cd $fixtures

function initConf(){
  (
    cat <<EOF
pm2 = ~/.pm2
refresh = 5000
port = 9000
daemonize = true
[log]
dir = ./logs
prefix = true
date = false
level = debug
[agent]
authorization = AuTh
;offline = true
[remotes]
fake_pm2_server = P@sswd@127.0.0.2:7000
EOF
  ) > $iniConf
}

function initNoAgentConf(){
  (
    cat <<EOF
pm2 = ~/.pm2
refresh = 5000
port = 9000
daemonize = true
[log]
dir = ./logs
prefix = true
date = false
level = debug
[agent]
offline = true
[remotes]
EOF
  ) > $iniConf
}

function safeExit(){
  ps x | grep pm2-gui | cut -c 1-5 | xargs kill -9;
  sleep 1;
}

function stop(){
  head "Stopping web and agent"
  $pg stop;
  sleep 1
  line=`netstat -an | grep 9000 | egrep "tcp" | grep "LISTEN" | wc -l`
  [ $line -eq 0 ] || fail "still running"
  success "stopped"
}

head "Make sure pm2 is daemonized"
$pm2 ls
echo ""

initConf;
stop;

head "Starting web and agent"
$pg start $iniConf;
sleep 1
line=`netstat -an | grep 9000 | egrep "tcp" | grep "LISTEN" | wc -l`
[ $line -eq 1 ] || fail "connect failed"
success "connected"

head "Accessing via http"
wget -q --spider "http://localhost:9000"
if [ $? -eq 0 ]; then
  success "connected"
else
  fail "connect failed"
fi

head "Checking status"
line=`$pg status | grep 'running' | wc -l`
[ $line -gt 0 ] || fail "wrong result"
success "running"

stop;

head "Starting agent only"
$pg agent $iniConf;
sleep 1
line=`netstat -an | grep 9000 | egrep "tcp" | grep "LISTEN" | wc -l`
[ $line -eq 1 ] || fail "connect failed"
success "connected"

head "Accessing via http"
wget -q --spider "http://localhost:9000"
if [ $? -eq 0 ]; then
  fail "still accessible"
else
  success "refused"
fi

stop;

head "Checking status"
line=`$pg status | grep 'stopped' | wc -l`
[ $line -gt 0 ] || fail "wrong result"
success "stopped"

head "Logger"
if [ -f $pipeFile ];then
  rm $pipeFile
fi
mkfifo $pipeFile
exec 6<>$pipeFile
$pg logs >&6 &
read line<&6
line=`echo $line | grep 'Logs from' | wc -l`
[ $line -eq 1 ] || fail "is not working"
exec 6>&-
rm $pipeFile
sleep 0.5

mkfifo $pipeFile
exec 6<>$pipeFile
$pg logs /var/log>&6 &
read log<&6
line=`echo $log | grep 'can not be found' | wc -l`
[ $line -eq 1 ] || fail "is not working"
success "works fine"
exec 6>&-
rm $pipeFile
safeExit

head "Running dashboard"
mkfifo $pipeFile
exec 6<>$pipeFile
$pg mon $iniConf>&6 &
count=0
localAvailable=0
remoteAvailable=0
while read log<&6
do
  if [ $count -gt 20 ]; then
    fail 'resolve localhost server failed'
    break;
  fi
  if [ $localAvailable -eq 0 ]; then
    localAvailable=`echo $log | grep '\[localhost' | wc -l`
  fi
  if [ $remoteAvailable -eq 0 ]; then
    remoteAvailable=`echo $log | grep '\[fake_pm2' | wc -l`
  fi
  if [ $localAvailable -gt 0 ] && [ $remoteAvailable -gt 0 ]; then
    success 'servers available'
    break;
  fi
  count=`expr $count + 1`
done
exec 6>&-
rm $pipeFile
safeExit

initNoAgentConf
head "Running dashboard(no agent)"
mkfifo $pipeFile
exec 6<>$pipeFile
$pg mon $iniConf>&6 &
count=0
while read log<&6
do
  if [ $count -gt 20 ]; then
    fail 'lookup agent failed'
    break;
  fi
  line=`echo $log | grep 'stopped' | wc -l`
  if [ $line -eq 1 ]; then
    success 'no agent online'
    break;
  fi
  count=`expr $count + 1`
done
exec 6>&-
rm $pipeFile
rm $iniConf
safeExit



