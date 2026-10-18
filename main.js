const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const userTemplates = () => path.join(app.getPath('userData'), 'templates')
const safe = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Event'
const defaults = () => ({
  eventName: 'My Event', cameraId: '', mirror: true, templateId: 'builtin:classic-strip', filter: 'none',
  countdown: 3, betweenShots: 2, reviewSeconds: 20,
  outputDir: path.join(app.getPath('pictures'), 'Open Photo Booth'),
  printer: '', copies: 1, autoPrint: false, print2up: true, kiosk: false,
})
let win

async function readSettings() {
  try { return { ...defaults(), ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) } } catch { return defaults() }
}
const eventDir = s => path.join(s.outputDir, safe(s.eventName))

async function listTemplates() {
  const out = []
  for (const [kind, root] of [['builtin', path.join(__dirname, 'templates')], ['user', userTemplates()]]) {
    for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      const dir = path.join(root, d.name)
      const xml = await fs.readFile(path.join(dir, 'template.xml'), 'utf8').catch(() => null)
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
  if (!(await fs.stat(path.join(src, 'template.xml')).catch(() => null))) return null
  await fs.cp(src, path.join(userTemplates(), path.basename(src)), { recursive: true })
  return `user:${path.basename(src)}`
})
ipcMain.handle('template:asset', async (_e, id, rel) => {
  const t = (await listTemplates()).find(t => t.id === id)
  if (!t || !rel) return null
  // Imported templates may store absolute Windows paths; fall back to the file name inside the template folder.
  for (const p of [path.resolve(t.dir, rel), path.join(t.dir, path.basename(rel.replace(/\\/g, '/')))]) {
    if (!p.startsWith(t.dir + path.sep)) continue
    const buf = await fs.readFile(p).catch(() => null)
    if (buf) return `data:${MIME[path.extname(p).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`
  }
  return null
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

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media')
  win = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#000', autoHideMenuBar: true, kiosk: (await readSettings()).kiosk,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile('index.html')
})
app.on('window-all-closed', () => app.quit())
