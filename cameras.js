// Cameras the booth controls itself, next to the webcams the page finds on its own: live view comes in as JPEG
// frames, and a photo is taken with the camera's own shutter (and flash) and arrives as the camera's full-resolution
// JPEG. The camera makers' SDKs (Sony's and Nikon's so far) run in camera-helper (camera-helper/main.cpp), a program of
// its own, so a crash or hang in one can't take the booth down: when it crashes or stops answering, it's restarted and
// the camera opened again.
// BOOTH_SIM_CAMERA=<photo.jpg> adds a simulated camera showing that photo, for development and tests.
const { app, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const EXE = process.platform === 'win32' ? 'camera-helper.exe' : 'camera-helper'
const bin = () => path.join(...(app.isPackaged ? [process.resourcesPath, 'camera-helper'] : [__dirname, 'camera-helper', 'build', process.platform === 'win32' ? 'win' : 'mac']), 'bin', EXE)
const TIMEOUT = Number(process.env.BOOTH_CAMERA_TIMEOUT) || 15000 // for any answer, a shot included
const dir = path.join(os.tmpdir(), `booth-camera-${process.pid}`) // the camera's photos, until the page has them

let helper = null, calls = new Map(), seq = 0
let want = null // the camera the page has open: { id, frame, state, ready }

// The simulated camera's pictures: its live view at 1024 px wide, and photos at 20 megapixels. Made once.
let simmed
const simFiles = () => (simmed ??= makeSimFiles())
async function makeSimFiles() {
  const img = nativeImage.createFromPath(process.env.BOOTH_SIM_CAMERA), { width, height } = img.getSize()
  if (img.isEmpty()) throw new Error(`BOOTH_SIM_CAMERA: can't read ${process.env.BOOTH_SIM_CAMERA}`)
  const k = Math.sqrt(20e6 / (width * height)), live = path.join(dir, 'sim-live.jpg'), photo = path.join(dir, 'sim-photo.jpg')
  await fs.writeFile(live, img.resize({ width: 1024 }).toJPEG(80))
  await fs.writeFile(photo, img.resize({ width: Math.round(width * k), height: Math.round(height * k) }).toJPEG(90))
  return [live, photo]
}

async function start() {
  if (helper) return helper
  await fs.mkdir(dir, { recursive: true })
  const args = ['--dir', dir, ...(process.env.BOOTH_SIM_CAMERA ? ['--sim', ...(await simFiles())] : [])]
  if (helper) return helper // started meanwhile
  const p = (helper = spawn(bin(), args, { stdio: ['pipe', 'pipe', 'inherit'] }))
  let buf = Buffer.alloc(0)
  p.stdout.on('data', d => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0), kind = buf[4], body = buf.subarray(5, 5 + n)
      buf = buf.subarray(5 + n)
      if (kind === 1) { if (want?.ready) want.frame(body) } else message(JSON.parse(body))
    }
  })
  p.on('error', () => {}) // not built (or not for this platform): 'exit' follows
  p.on('exit', () => {
    if (helper === p) helper = null
    for (const c of calls.values()) c.reject(new Error('camera-helper stopped'))
    calls.clear()
    if (want) lost()
  })
  p.stdin.on('error', () => {})
  return p
}

function message(m) {
  if (m.event === 'lost') return lost()
  const c = calls.get(m.id)
  if (!c) return
  calls.delete(m.id)
  clearTimeout(c.timer)
  if (m.ok) c.resolve(m)
  else c.reject(Object.assign(new Error(m.message), { code: m.error }))
}

// One command to the helper. One that isn't answered in time means the helper is stuck: it's stopped (and started again
// on the next call).
async function call(op, arg = '') {
  const p = await start()
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`camera-helper didn't answer ${op}`)); p.kill('SIGKILL') }, TIMEOUT)
    calls.set(id, { resolve, reject, timer })
    p.stdin.write(`${id} ${op} ${arg}\n`)
  })
}

// The camera went away (cable, battery, helper crash). The page uses the webcam meanwhile; every 2 s the booth looks
// for the camera again and opens it once it's back.
async function lost() {
  if (!want?.ready) return
  const w = want
  w.ready = false
  w.state('lost')
  while (want === w) {
    await sleep(2000)
    if (want !== w) return
    try {
      const { cameras } = await call('list')
      if (!cameras.some(c => `tether:${c.id}` === w.id)) continue
      await call('open', w.id.slice(7))
      await call('live', '1')
      if (want !== w) return call('close').catch(() => {})
      w.ready = true
      return w.state('ready')
    } catch {}
  }
}

async function list() {
  try {
    return (await call('list')).cameras.map(c => ({ id: `tether:${c.id}`, name: c.name }))
  } catch {
    return [] // no helper on this platform
  }
}

// Starts live view. frame(jpeg) gets each frame; state(s) hears 'lost' when the camera goes away and 'ready' when it's back.
async function open(id, frame, state) {
  await close()
  if (!id.startsWith('tether:')) throw new Error('camera not found')
  await call('open', id.slice(7))
  await call('live', '1')
  want = { id, frame, state, ready: true }
}

async function close() {
  if (!want) return
  want = null
  await call('close').catch(() => {})
}

async function shoot() {
  if (!want?.ready) throw new Error('camera not connected')
  const { file } = await call('shoot')
  try { return await fs.readFile(file) } finally { fs.rm(file, { force: true }) }
}

const ready = () => { if (!want?.ready) throw new Error('camera not connected') }
async function focus() { ready(); await call('focus') }
async function live(on) { ready(); await call('live', on ? '1' : '0') }
// The open camera's name and battery ("AC", "80%" or "").
async function status() { ready(); const { name, battery } = await call('status'); return { name, battery } }

// Tests only (the simulated camera): unplug, plug, crash or hang.
const sim = what => call('sim', what)

app.on('will-quit', () => { helper?.stdin.end(); fs.rm(dir, { recursive: true, force: true }) }) // the helper lets go of the camera and exits

module.exports = { list, open, close, shoot, focus, live, status, sim }
