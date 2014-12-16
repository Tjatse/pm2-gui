pm2-gui [![NPM version](https://badge.fury.io/js/pm2-gui.svg)](http://badge.fury.io/js/pm2-gui)
=======

An elegant web interface for Unitech/PM2.

> In progress.

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
- [TODO](#todo)


<a name="ins" />
# Installation
```
$ npm install -g PM2-gui
```

<a name="cli" />
# CLI
```
  Usage: PM2-gui [cmd] [options]

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
  "PM2": "~/.PM2"
}
```

- **refresh** The heartbeat duration of monitor (backend), `5000` by default.
- **manupulation** A value indicates whether the client has permission to restart/stop processes, `true` by default.
- **PM2** Root directory of Unitech/PM2, `~/.PM2` by default.

<a name="cli_conf_set">
### Set Config
Usage
```bash
$ PM2-gui set <key> <value>
```

Example
```bash
$ PM2-gui set refresh 2000
```

Above command will set `refresh` to two second.

<a name="cli_conf_remove">
### Remove Config
Usage
```bash
$ PM2-gui rm <key>
```

Example
```bash
$ PM2-gui rm refresh
```

Above command will remove `refresh` config and it will be set to `5000` by default.


<a name="feats" />
# Feature
- All the heartbeats (no matter **monitor** or **tail (logs)**) are automatic destroyed.
- The `PM2` processes are watched by a FSWatcher ([chokidar](https://www.npmjs.org/package/chokidar)), but not manually polling.
- Communicated with `PM2` through **RPC** socket directly, but not `PM2` programmatic API and no more **sub/sub-emitter** bullshit (consumes memory and CPU usage).
- Socket.io between client and server.
- Monitor CPU and Memory usage of server in a real-time.
- Monitor `PM2` processes in a real-time.
- Supports: process memory monitor, PM2 restart/stop.
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

<a name="home" />
Home

<a name="no_proc" />
Empty List

<a name="procs" />
Processes

<a name="info" />
Describe Complete Information

<a name="tail_logs" />
Tail Logs

<a name="todo" />
# TODO
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

