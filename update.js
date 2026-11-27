// Updates. A release build asks where its releases are published ("publish" in package.json's build settings;
// BOOTH_UPDATES points the tests at a folder instead) every few hours whether there is a new version. It then only
// says so: the settings show it and the ⚙️ gets a dot (update-ui.js), and the operator starts the update there, which
// downloads it, installs it and restarts the app. Only with "Install new versions automatically" on does it download
// a new version by itself, and install it when the operator quits or when the page finds the booth idle on its start
// screen. Never mid-session. macOS installs only updates signed with the same Developer ID as the running app.
const { app, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let status = { state: 'off' }, updater = null, send = () => {}
let auto = false, asked = false // the setting; the operator pressed "Update" for the version on offer
const check = () => { if (updater && !['checking', 'downloading', 'ready'].includes(status.state)) updater.checkForUpdates().catch(() => {}) } // failures come through 'error'
const download = version => { send({ state: 'downloading', version, percent: 0 }); updater.downloadUpdate().catch(() => {}) }

function start(win, automatic) {
  auto = !!automatic
  const test = process.env.BOOTH_UPDATES
  if (!test && !(app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')))) return // a build with nowhere to ask
  updater = require('electron-updater').autoUpdater
  if (test) {
    const yml = path.join(app.getPath('userData'), 'update-test.yml')
    fs.writeFileSync(yml, `provider: generic\nurl: ${test}\nupdaterCacheDirName: booth-updater-test\n`)
    Object.assign(updater, { forceDevUpdateConfig: true, updateConfigPath: yml })
  }
  send = s => { status = s; win.webContents.send('update:status', s) }
  Object.assign(updater, { logger: null, autoDownload: false }) // whether to download is decided below
  updater.on('checking-for-update', () => send({ state: 'checking' }))
  updater.on('update-not-available', () => send({ state: 'latest' }))
  updater.on('update-available', i => (auto || asked ? download(i.version) : send({ state: 'available', version: i.version })))
  updater.on('download-progress', p => send({ ...status, percent: Math.floor(p.percent) }))
  updater.on('update-downloaded', i => {
    send({ state: 'ready', version: i.version })
    if (asked) updater.quitAndInstall(true, true) // the operator is waiting for it
  })
  updater.on('error', e => { console.warn('Update:', e.message); asked = false; send({ state: 'failed', version: status.version }) })
  setTimeout(check, test ? 3000 : 3600000) // an hour in, not while the booth is busy starting up
  setInterval(check, 4 * 3600000)
  send({ state: 'on' })
}
// The setting changed: turned on with a version on offer, its download starts now.
function automatic(on) {
  auto = !!on
  if (auto && status.state === 'available') download(status.version)
}
ipcMain.handle('update:status', () => ({ ...status, current: app.getVersion() }))
ipcMain.handle('update:check', check)
// "Update to …": download, install, restart. "Restart and update": a version that is already downloaded.
ipcMain.handle('update:install', () => {
  if (status.state === 'ready') updater.quitAndInstall(true, true)
  else if (status.state === 'available') { asked = true; download(status.version) }
})

module.exports = { start, automatic }
