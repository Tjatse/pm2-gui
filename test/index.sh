#!/usr/bin/env bash

SRC=$(cd $(dirname "$0"); pwd)
source "${SRC}/bash/include.sh"

set -e

echo -e "\x1B[1m############ TEST SUITE ############\x1B[0m"
echo -e "\x1B[1mNode version = $nodeVersion\x1B[0m"
$node -e "var os = require('os'); console.log('\x1B[1march : %s\nplatform : %s\nrelease : %s\ntype : %s\nmem : %d\x1B[0m', os.arch(), os.platform(), os.release(), os.type(), os.totalmem())"
echo -e "\x1B[1m####################################\x1B[0m"
echo -e ""

bash ./test/bash/interface.sh
