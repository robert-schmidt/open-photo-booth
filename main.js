const { app, BrowserWindow, ipcMain, dialog, shell, session, powerSaveBlocker, systemPreferences } = require('electron')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const userTemplates = () => path.join(app.getPath('userData'), 'templates')
const safe = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Event'
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layout'
const exists = p => fs.stat(p).then(() => true, () => false)
const dataUrl = async file => `data:${MIME[path.extname(file).toLowerCase()] || 'image/png'};base64,${(await fs.readFile(file)).toString('base64')}`
const defaults = () => ({
  eventName: 'My Event', startText: 'Touch to start', cameraId: '', mirror: true, templateId: 'builtin:classic-strip', filter: 'none',
  countdown: 3, betweenShots: 2, reviewSeconds: 20,
  outputDir: path.join(app.getPath('pictures'), 'Open Photo Booth'),
  printer: '', copies: 1, autoPrint: false, print2up: true, kiosk: false, pin: '',
})
const picked = new Set() // image files the user chose in a dialog; only these may be copied into templates
const gotLock = app.requestSingleInstanceLock()
let win

async function readSettings() {
  try { return { ...defaults(), ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) } } catch { return defaults() }
}
const eventDir = s => path.join(s.outputDir, safe(s.eventName))

// Windows tools sometimes save template.xml as UTF-16.
async function readXml(file) {
  const b = await fs.readFile(file)
  return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')
}

async function listTemplates() {
  const out = []
  for (const [kind, root] of [['builtin', path.join(__dirname, 'templates')], ['user', userTemplates()]]) {
    for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      const dir = path.join(root, d.name)
      const xml = await readXml(path.join(dir, 'template.xml')).catch(() => null)
      if (xml) out.push({ id: `${kind}:${d.name}`, dir, xml })
    }
  }
  return out
}

async function print(file, widthIn, heightIn) {
  const s = await readSettings()
  if (!path.resolve(file).startsWith(path.resolve(s.outputDir) + path.sep)) return 'not a booth photo'
  const html = path.join(os.tmpdir(), `opb-print-${Date.now()}.html`)
  await fs.writeFile(html, `<!doctype html><style>@page{margin:0}html,body{margin:0;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}</style><img src="${pathToFileURL(file)}">`)
  const pw = new BrowserWindow({ show: false })
  try {
    await pw.loadFile(html)
    return await new Promise(resolve => pw.webContents.print({
      silent: !!s.printer, deviceName: s.printer || undefined, copies: s.copies, printBackground: true,
      margins: { marginType: 'none' }, landscape: widthIn > heightIn,
      pageSize: { width: Math.round(Math.min(widthIn, heightIn) * 25400), height: Math.round(Math.max(widthIn, heightIn) * 25400) },
    }, (ok, reason) => resolve(ok ? null : reason)))
  } finally {
    pw.destroy()
    fs.rm(html, { force: true })
  }
}

ipcMain.handle('settings:get', readSettings)
ipcMain.handle('settings:set', async (_e, s) => {
  const next = { ...defaults(), ...s }
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2))
  win.setKiosk(!!next.kiosk)
  return next
})
ipcMain.handle('templates:list', listTemplates)
ipcMain.handle('templates:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder containing template.xml', properties: ['openDirectory'] })
  if (r.canceled) return null
  const src = r.filePaths[0]
  if (!(await exists(path.join(src, 'template.xml')))) return null
  await fs.cp(src, path.join(userTemplates(), path.basename(src)), { recursive: true })
  return `user:${path.basename(src)}`
})
// Saves editor output. Overwrites a user template by id; otherwise creates a new folder, optionally seeded from copyFrom.
ipcMain.handle('templates:save', async (_e, { id, name, xml, copyFrom, files }) => {
  const all = await listTemplates()
  let dir = id?.startsWith('user:') ? all.find(t => t.id === id)?.dir : null
  if (!dir) {
    const base = path.join(userTemplates(), slug(name))
    dir = base
    for (let n = 2; await exists(dir); n++) dir = `${base}-${n}`
    const src = all.find(t => t.id === copyFrom)
    if (src) await fs.cp(src.dir, dir, { recursive: true })
    else await fs.mkdir(dir, { recursive: true })
  }
  for (const [file, from] of Object.entries(files || {})) {
    if (picked.has(from)) await fs.copyFile(from, path.join(dir, path.basename(file)))
  }
  await fs.writeFile(path.join(dir, 'template.xml'), xml)
  return `user:${path.basename(dir)}`
})
ipcMain.handle('templates:delete', async (_e, id) => {
  const t = id.startsWith('user:') && (await listTemplates()).find(t => t.id === id)
  if (t) await fs.rm(t.dir, { recursive: true, force: true })
})
ipcMain.handle('template:asset', async (_e, id, rel) => {
  const t = (await listTemplates()).find(t => t.id === id)
  if (!t || !rel) return null
  // Imported templates may store absolute Windows paths; fall back to the file name inside the template folder.
  for (const p of [path.resolve(t.dir, rel), path.join(t.dir, path.basename(rel.replace(/\\/g, '/')))]) {
    if (p.startsWith(t.dir + path.sep) && (await exists(p))) return dataUrl(p)
  }
  return null
})
ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
  if (r.canceled) return null
  const file = r.filePaths[0]
  picked.add(file)
  return { name: path.basename(file), path: file, dataUrl: await dataUrl(file) }
})
ipcMain.handle('confirm', async (_e, message) => {
  const r = await dialog.showMessageBox(win, { type: 'question', message, buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1 })
  return r.response === 0
})
ipcMain.handle('photo:save', async (_e, name, data) => {
  const dir = eventDir(await readSettings())
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, path.basename(name))
  await fs.writeFile(file, Buffer.from(data))
  return file
})
ipcMain.handle('printers:list', async () => (await win.webContents.getPrintersAsync()).map(p => ({ name: p.name, displayName: p.displayName })))
ipcMain.handle('print', (_e, file, w, h) => print(file, w, h))
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('shell:open', async () => {
  const dir = eventDir(await readSettings())
  await fs.mkdir(dir, { recursive: true })
  return shell.openPath(dir)
})
ipcMain.handle('app:quit', () => app.quit())

if (!gotLock) app.quit()
app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
})
app.whenReady().then(async () => {
  if (!gotLock) return
  if (process.platform === 'darwin' && app.isPackaged) await systemPreferences.askForMediaAccess('camera')
  powerSaveBlocker.start('prevent-display-sleep')
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media')
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, backgroundColor: '#000', autoHideMenuBar: true,
    kiosk: (await readSettings()).kiosk,
    // spellcheck off: on Windows it would download dictionaries, and the booth makes no network requests
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  })
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile('index.html')
})
app.on('window-all-closed', () => app.quit())
