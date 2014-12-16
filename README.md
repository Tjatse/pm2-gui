pm2-gui [![NPM version](https://badge.fury.io/js/pm2-gui.svg)](http://badge.fury.io/js/pm2-gui)
=======

An elegant web interface for Unitech/PM2.

> Compatible with PM2 v0.12.2.

# Guide
- [Installation](#ins)
- [CLI](#cli)
  - [Run Web Interface](#cli_web)
  - [Configs](#cli_confs)
    - [Set](#cli_conf_set)
    - [Remove](#cli_conf_remove)
- [Features](#feats)
- [Cautions](#cauts)
- [UI/UX](#ui)
  - [Backend](#back)
  - [Home](#home)
  - [Empty List](#no_proc)
  - [Processes](#procs)
  - [Describe Complete Information](#info)
  - [Tail Logs](#tail_logs)
  - [Tips](#tip)
- [TODO](#todo)


<a name="ins" />
# Installation
```
$ npm install -g pm2-gui
```

<a name="cli" />
# CLI
```
  Usage: pm2-gui [cmd] [options]

  Commands:

    start [options] [port]  Launch the web server, port default by 8088
    config                  show all configs
    set <key> <value>       set config by key-value pairs
    rm <key>                remove config by key

  Options:

    -h, --help     output usage information
    -v, --version  output the version number

  Basic Examples:

    Start the web server, by default port (8088):
    $ pm2-gui start

    Start the web server, by specific port (8090):
    $ pm2-gui start 8090

```

<a name="cli_web" />
## Run Web Interface
```bash
  Usage: start [options] [port]

  Options:

    -h, --help  output usage information
    --no-debug  hide stdout/stderr information
```

<a name="cli_confs" />
## Configs
```javascript
{
  "refresh": 3000
  "manipulation": true
  "pm2": "~/.pm2"
}
```

- **refresh** The heartbeat duration of monitor (backend), `5000` by default.
- **manupulation** A value indicates whether the client has permission to restart/stop processes, `true` by default.
- **PM2** Root directory of Unitech/PM2, `~/.pm2` by default.

<a name="cli_conf_set">
### Set Config
Usage
```bash
$ pm2-gui set <key> <value>
```

Example
```bash
$ pm2-gui set refresh 2000
```

Above command will set `refresh` to two second.

<a name="cli_conf_remove">
### Remove Config
Usage
```bash
$ pm2-gui rm <key>
```

Example
```bash
$ pm2-gui rm refresh
```

Above command will remove `refresh` config and it will be set to `5000` by default.


<a name="feats" />
# Feature
- All the heartbeats (no matter **monitor** or **tail (logs)**) are automatic destroyed.
- The `PM2` processes are watched by a subscribed emitter.
- Communicated with `PM2` through **RPC** socket directly.
- Socket.io between client and server.
- Monitor CPU and Memory usage of server in a real-time.
- Monitor `PM2` processes in a real-time.
- PM2 restart/stop/delete.
- Supports [ANSI color codes](#tail_logs) by [ansi-html](https://github.com/Tjatse/ansi-html).

<a name="cauts" />
# Cautions
- Web Interface is wrote by CSS3 && HTML5, so view it with the latest version of the browser (WebGL, Animation, WebSocket supports), e.g. Chrome, Safari and Firefox.
- I've never test it on Internet Explorer / Windows.

<a name="ui" />
# UI/UX
- Amazing and smooth animations.
- High performance.

<a name="back" />
Backend (without `--no-debug` option):

![image](screenshots/term.jpg)

<a name="home" />
Home

![image](screenshots/home.jpg)

<a name="no_proc" />
Empty List

![image](screenshots/no-proc.jpg)

<a name="procs" />
Processes

![image](screenshots/procs.jpg)

<a name="info" />
Describe Complete Information

![image](screenshots/proc-info.jpg)

<a name="tail_logs" />
Tail Logs

![image](screenshots/tail-logs.jpg)

<a name="tip" />
Tips

![image](screenshots/tip.jpg)

<a name="todo" />
# TODO
- [ ] Authentication
- [ ] Multiple operations.
- [ ] Configured JSON files.
- [ ] Memory and CPU usage gauge of each process.
- [ ] Test on Windows (need environment).
- [ ] Need feedback/test.


## License
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

