# 0.2.0

**Breaking Changes**
- Requires Node.js 18+ and PM2 5.x+
- Replaced legacy axon RPC integration with the official PM2 programmatic API
- Replaced Jade/jQuery/D3 frontend with a modern Pug + vanilla JS dashboard
- Socket.IO upgraded from v1 to v4

**Enhancements**
- Responsive dark-theme web UI with process table and detail modal
- Live CPU/memory chart per process (fixed legacy `pull.process` event bug)
- PM2 log streaming via `log:out` / `log:err` bus events
- Session secret configurable via `PM2_GUI_SESSION_SECRET`

**Bugs**
- Fixed `delete` action guard referencing wrong variable in `lib/pm.js`
- Fixed Socket.IO v4 namespace socket iteration

# 0.1.4-rc.1
**Bugs**
- clean ANSI.

**Enhancements**
- `readonly` property.
- Hide connection string.
- Code style: standard.
- Update dependecies

# 0.1.4-alpha
**Bugs**
- `keepANSI` bug.
- Get real path of symbolic links when `npm install -g`.

# 0.1.2
**Breaking Changes**
- `.ini` properties.
- Daemonize `pm2-gui`.

**Enhancements**
- Run like a daemonized server.
- Remoting agents support.
- Commands.
- Tailing logs.
- Logger system.

**Bugs**
- #19
- #27
- #28
- #29

# 0.1.1
**Enhancements**
- Terminal dashboard processes amount.

# 0.1.0
**Enhancements**
- Terminal dashboard.

# 0.0.9
**Breaking Changes**
- Using `.ini` config file instead of `.json`.

**Bugs**
- Warning messages of initialization.
- Running behind proxy / sub-domain.

**Enhancements**
- Restart / Delete / Stop / Save all processes.