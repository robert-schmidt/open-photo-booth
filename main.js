const { app, BrowserWindow, ipcMain, dialog, shell, session, powerSaveBlocker, systemPreferences, protocol, net } = require('electron')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const Events = require('./events.js')
const Cameras = require('./cameras.js')
const LocalShare = require('./local-share.js')
const Update = require('./update.js')
const crypto = require('node:crypto')

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const userTemplates = () => path.join(app.getPath('userData'), 'templates')
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layout'
const exists = p => fs.stat(p).then(() => true, () => false)
const dataUrl = async file => `data:${MIME[path.extname(file).toLowerCase()] || 'image/png'};base64,${(await fs.readFile(file)).toString('base64')}`
const defaults = () => ({
  eventName: 'My Event', startText: 'Touch to start', cameraId: '', micId: '', mirror: true, templateId: 'builtin:classic-strip', filter: 'none',
  countdown: 3, betweenShots: 2, reviewSeconds: 45, enhance: true, guestRetake: true, guestLooks: true, guestStickers: true, stickerDir: '', glam: 'light', noBlink: true, guestBackgrounds: true, backgroundDir: '', background: 'none', lutDir: '', attractDir: '', attractOwn: false, lang: 'en', guestDraw: false, localShare: false,
  brandColor: '#ff4f6d', guestForm: 'off', formName: true, formEmail: true, formQuestion: '', formChoices: '', formConsent: 'I agree that the host of this event may contact me by email.',
  modePhoto: true, modeBoomerang: false, modeVideo: false, videoSeconds: 10, greenScreen: false, chromaTolerance: 50, guestSwap: false, swapDir: '', swapLive: false,
  outputDir: path.join(app.getPath('pictures'), 'Open Photo Booth'),
  printer: '', copies: 1, autoPrint: false, print2up: true, kiosk: false, pin: '', autoInstall: false,
})
const picked = new Set() // image files the user chose in a dialog; only these may be copied into templates
const gotLock = app.requestSingleInstanceLock()
// The app is served from app://booth/ rather than file://: a standard, secure origin where fetch, module
// workers, WebGPU and Cache Storage behave as on the web (on-device face swap needs all four).
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])
let win

// Face swap models (InsightFace's; see THIRD_PARTY_NOTICES.md). They aren't in the installer: the booth fetches them
// once, when face swap is first turned on, and keeps them in <userData>/face-models, so it swaps offline after that.
// From package.json "booth".models, or BOOTH_MODELS (a folder URL; file:// works for development and the tests).
// Each is kept only if it matches the fingerprint browser-inswapper checks (KNOWN_SHA256; test.js).
const FACE_MODELS = {
  'inswapper_128_fp16.onnx': 'c4eccca86ad177586c85c28bf1a64a9d9ed237e283a15818d831f7facfd3f420',
  'inswapper_128.onnx': 'a290273ed497312095dac48cdef20feec9d5208298223dd01288ab202b54bea7',
  'w600k_r50.onnx': '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
}
const modelsUrl = process.env.BOOTH_MODELS || require('./package.json').booth?.models
const modelsDir = () => path.join(app.getPath('userData'), 'face-models')
// Ready with the identity model and either swap model (which one a booth uses depends on its GPU).
const swapReady = async () => (await exists(path.join(modelsDir(), 'w600k_r50.onnx'))) && ((await exists(path.join(modelsDir(), 'inswapper_128_fp16.onnx'))) || (await exists(path.join(modelsDir(), 'inswapper_128.onnx'))))

// app://booth/face-models/<name>: from disk, or else from the server, streamed to the page while a copy is saved.
// The page's read finishes only once the copy is checked and in place, so "ready" is true when the load is done.
async function faceModel(name) {
  const file = path.join(modelsDir(), name), part = `${file}.part`
  if (await exists(file)) return net.fetch(pathToFileURL(file).toString())
  const r = modelsUrl && await net.fetch(new URL(name, modelsUrl.replace(/\/?$/, '/')).toString()).catch(() => null)
  if (!r?.ok || !r.body) return new Response('Not found', { status: 404 })
  await fs.mkdir(modelsDir(), { recursive: true })
  const out = await fs.open(part, 'w'), hash = crypto.createHash('sha256'), length = !r.headers.get('content-encoding') && r.headers.get('content-length')
  const keep = new TransformStream({
    async transform(chunk, c) { hash.update(chunk); await out.write(chunk); c.enqueue(chunk) },
    async flush() {
      await out.close()
      if (hash.digest('hex') !== FACE_MODELS[name]) { await fs.rm(part, { force: true }); throw new Error(`${name} didn't match its fingerprint`) }
      await fs.rename(part, file)
    },
    cancel: () => out.close(), // the page stopped reading or the download broke off: tried again next time
  })
  return new Response(r.body.pipeThrough(keep), { headers: length ? { 'content-length': length } : {} })
}

// swapReady: the face swap models are on this booth.
async function readSettings() {
  const saved = await fs.readFile(settingsFile(), 'utf8').then(JSON.parse).catch(() => ({}))
  return { ...(await Events.merge({ ...defaults(), ...saved })), swapReady: await swapReady() }
}

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
ipcMain.handle('settings:set', async (_e, { swapReady: _ready, ...s }) => {
  const next = { ...defaults(), ...s }
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  // Flushed and then renamed over the old file, so a power cut can't leave the booth without its PIN or photos folder.
  await fs.writeFile(settingsFile() + '.tmp', JSON.stringify(Events.machine(next), null, 2), { flush: true })
  await fs.rename(settingsFile() + '.tmp', settingsFile())
  await Events.update(next)
  win.setKiosk(!!next.kiosk)
  Update.automatic(next.autoInstall)
  await localBase() // sharing starts or stops with the event's setting
  return readSettings()
})
ipcMain.handle('events:list', async () => Events.list((await readSettings()).outputDir))
ipcMain.handle('events:new', async () => { await Events.create(await readSettings()); return readSettings() })
ipcMain.handle('events:switch', async (_e, id) => { await Events.activate(id); return readSettings() })
ipcMain.handle('events:remove', async (_e, id) => { await Events.remove(id); return readSettings() })
// Photos to phones on the same network (local-share.js), when the event has it on. localBase: where a photo's page
// is (its key goes on the end), or '' when sharing is off or the computer isn't on a network. Only files from the
// photos folder are handed over, so the renderer can't put anything else on the network.
const localBase = async () => {
  const s = await readSettings()
  if (s.localShare) return LocalShare.base(s.lang, s.brandColor)
  LocalShare.stop()
  return ''
}
ipcMain.handle('share:local', localBase)
ipcMain.handle('share:base', localBase)
ipcMain.handle('share:photo', async (_e, { key, file }) => {
  const s = await readSettings()
  if (!s.localShare || !/^[a-z0-9]{12}$/.test(key) || !/\.(jpg|mp4|webm)$/.test(file) || !path.resolve(file).startsWith(path.resolve(s.outputDir) + path.sep)) return false
  LocalShare.add(key, file, s.eventName)
  return true
})
// On-device AI models bundled in models/ (see ai.js). Read here because the sandboxed renderer can't fetch file:// URLs.
const MODELS = ['face_landmarker.task', 'selfie_segmenter.tflite']
ipcMain.handle('model:load', (_e, name) => (MODELS.includes(name) ? fs.readFile(path.join(__dirname, 'models', name)) : null))
// Images from one of the active event's folders (stickers, backgrounds, scenes, start screen pictures), read here so
// the renderer can't pick the path.
// 'own' is the event's own finished photos, newest first, for its start screen (when the event shows them).
// ponytail: sent whole, like the pictures of the other kinds: twelve photos of about 1 MB. Thumbnails if a booth feels it.
ipcMain.handle('images:list', async (_e, kind) => {
  const s = await readSettings(), own = kind === 'own'
  const dir = own ? s.attractOwn && (await Events.dir(s)) : ['stickerDir', 'backgroundDir', 'swapDir', 'attractDir'].includes(kind) && s[kind]
  if (!dir) return []
  const names = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(f => f.isFile() && (own ? /^\d{8}-\d{6}\.jpg$/ : /\.(png|webp|gif|jpe?g)$/i).test(f.name)).map(f => f.name).sort()
  return Promise.all((own ? names.reverse().slice(0, 12) : names.slice(0, 60)).map(f => dataUrl(path.join(dir, f))))
})
// The active event's .cube colour presets (extra looks, see fx.js), as text. A 65-point table is about 8 MB of it.
ipcMain.handle('luts:list', async () => {
  const dir = (await readSettings()).lutDir, out = []
  for (const f of dir ? (await fs.readdir(dir).catch(() => [])).filter(f => /\.cube$/i.test(f)).sort().slice(0, 24) : []) {
    const file = path.join(dir, f), size = await fs.stat(file).then(s => s.size, () => Infinity)
    if (size < 32e6) out.push({ name: path.basename(f, path.extname(f)), text: await fs.readFile(file, 'utf8') })
  }
  return out
})
// Cameras the booth controls (cameras.js). Frames and comings and goings go to the page that opened the camera.
ipcMain.handle('camera:list', () => Cameras.list())
ipcMain.handle('camera:open', (e, id) => {
  const send = (channel, v) => { if (!e.sender.isDestroyed()) e.sender.send(channel, v) }
  return Cameras.open(String(id), jpeg => send('camera:frame', jpeg), s => send('camera:state', s))
})
ipcMain.handle('camera:close', () => Cameras.close())
ipcMain.handle('camera:shoot', () => Cameras.shoot())
ipcMain.handle('camera:focus', () => Cameras.focus())
ipcMain.handle('camera:live', (_e, on) => Cameras.live(!!on))
ipcMain.handle('camera:status', () => Cameras.status())
ipcMain.handle('camera:props', () => Cameras.props())
ipcMain.handle('camera:set', (_e, key, index) => Cameras.set(String(key), Number(index)))
ipcMain.handle('camera:sim', (_e, what) => Cameras.sim(String(what)))
ipcMain.handle('session:log', async (_e, entry) => Events.log(await readSettings(), { ...entry }))
ipcMain.handle('guest:save', async (_e, guest) => Events.guest(await readSettings(), { ...guest }))
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
    await fs.mkdir(dir, { recursive: true })
    // File by file, not fs.cp: built-in layouts live inside app.asar in a release build, and fs.cp can't read from there.
    for (const f of src ? await fs.readdir(src.dir) : []) await fs.copyFile(path.join(src.dir, f), path.join(dir, f))
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
  // Filed by type inside the event's folder: the finished layouts on top, the rest in folders of their own.
  name = path.basename(name)
  const kind = /_print\.\w+$/.test(name) ? 'Prints' : /_\d+\.\w+$/.test(name) ? 'Originals' : /\.(mp4|webm)$/.test(name) ? 'Videos' : ''
  const dir = path.join(await Events.dir(await readSettings()), kind)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
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
  const dir = await Events.dir(await readSettings(), false)
  await fs.mkdir(dir, { recursive: true })
  return shell.openPath(dir)
})
ipcMain.handle('app:quit', () => app.quit())
// The project's page, in the computer's browser. The address is fixed here: the page can't open any other.
ipcMain.handle('app:repo', () => shell.openExternal('https://github.com/robert-schmidt/open-photo-booth'))
ipcMain.handle('app:more', () => shell.openExternal('https://boothini.com/'))

if (!gotLock) app.quit()
app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
})
app.whenReady().then(async () => {
  if (!gotLock) return
  if (process.platform === 'darwin' && app.isPackaged) await systemPreferences.askForMediaAccess('camera')
  protocol.handle('app', async req => {
    const pathname = decodeURIComponent(new URL(req.url).pathname)
    if (pathname.startsWith('/face-models/')) {
      const name = pathname.slice('/face-models/'.length)
      return Object.hasOwn(FACE_MODELS, name) ? faceModel(name) : new Response('Not found', { status: 404 })
    }
    const file = path.join(__dirname, pathname)
    if (!file.startsWith(__dirname + path.sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  powerSaveBlocker.start('prevent-display-sleep')
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media')
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, backgroundColor: '#000', autoHideMenuBar: true,
    kiosk: (await readSettings()).kiosk,
    show: !process.env.BOOTH_BACKGROUND, // the tests' window opens behind whatever you're working in (see below)
    // spellcheck off: on Windows it would download dictionaries, and the booth makes no network requests of its own
    // beyond the ones the settings name (new versions, the face swap models)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  })
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL('app://booth/index.html')
  Update.start(win, (await readSettings()).autoInstall)
  LocalShare.keep(path.join(app.getPath('userData'), 'shares.json'))
  localBase() // links handed out before a restart work again at once
  if (process.env.BOOTH_BACKGROUND) win.showInactive() // shown, but your typing doesn't land in it
})
app.on('window-all-closed', () => app.quit())
