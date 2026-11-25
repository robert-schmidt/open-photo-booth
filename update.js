// Updates. A release build asks where its releases are published ("publish" in package.json's build settings;
// BOOTH_UPDATES points the tests at a folder instead) for a new version, downloads it in the background and installs
// it when the operator quits, or when the page finds the booth idle on its start screen (update-ui.js). Never
// mid-session. macOS installs only updates signed with the same Developer ID as the running app.
const { app, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let status = { state: 'off' }, install = () => {}
// on: the "Get new versions automatically" setting, as it was when the app started.
function start(win, on = true) {
  const test = process.env.BOOTH_UPDATES
  if (!on || (!test && !(app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))))) return // off, or a build with nowhere to ask
  const { autoUpdater } = require('electron-updater')
  if (test) {
    const yml = path.join(app.getPath('userData'), 'update-test.yml')
    fs.writeFileSync(yml, `provider: generic\nurl: ${test}\nupdaterCacheDirName: booth-updater-test\n`)
    Object.assign(autoUpdater, { forceDevUpdateConfig: true, updateConfigPath: yml })
  }
  const send = s => { status = s; win.webContents.send('update:status', s) }
  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => send({ state: 'latest' }))
  autoUpdater.on('update-available', i => send({ state: 'downloading', version: i.version, percent: 0 }))
  autoUpdater.on('download-progress', p => send({ ...status, percent: Math.floor(p.percent) }))
  autoUpdater.on('update-downloaded', i => send({ state: 'ready', version: i.version }))
  autoUpdater.on('error', e => { console.warn('Update:', e.message); send({ state: 'failed', version: status.version }) })
  const check = () => autoUpdater.checkForUpdates().catch(() => {}) // reported through 'error'
  setTimeout(check, test ? 3000 : 3600000) // an hour in, not while the booth is busy starting up
  setInterval(check, 4 * 3600000)
  install = () => autoUpdater.quitAndInstall(true, true)
  send({ state: 'on' })
}
ipcMain.handle('update:status', () => ({ ...status, current: app.getVersion() }))
ipcMain.handle('update:install', () => { if (status.state === 'ready') install() })

module.exports = { start }
