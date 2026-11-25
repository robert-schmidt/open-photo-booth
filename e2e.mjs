// End-to-end check: drives the real app over CDP with Chromium's fake camera through a photo session, the settings PIN
// and the layout editor. Runs in a throwaway profile, so your own settings, layouts and photos are never touched.
// Usage: npm run e2e [-- <dir>]   saves screenshots to <dir>; `npm run e2e -- docs` refreshes the README images.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert'
import electron from 'electron'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-e2e-'))
const outDir = path.join(tmp, 'photos'), profile = path.join(tmp, 'profile'), shots = process.argv[2] || tmp
const sleep = ms => new Promise(r => setTimeout(r, ms))
await fs.mkdir(shots, { recursive: true })
// Settings from the single-event version, with photos already taken: the upgrade must keep using that folder.
await fs.mkdir(path.join(outDir, 'Anna & Ben'), { recursive: true })
await fs.mkdir(profile, { recursive: true })
await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ eventName: 'Anna & Ben', outputDir: outDir }))
const d = new Date(), day = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const jpgs = async dir => (await fs.readdir(dir, { recursive: true })).filter(f => f.endsWith('.jpg'))
const log = async dir => (await fs.readFile(path.join(dir, 'sessions.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))

// BOOTH_FACE_MODELS (a folder with the InsightFace models) stands in for the address the booth downloads them from.
// Without it the face swap checks are skipped, and the address leads nowhere: the tests never use the network.
process.env.BOOTH_MODELS = pathToFileURL(process.env.BOOTH_FACE_MODELS || path.join(tmp, 'no-models')).href
// A camera the booth controls, simulated: it shows this photo, and takes it again at 20 megapixels.
process.env.BOOTH_SIM_CAMERA = path.join(import.meta.dirname, 'test', 'portrait.jpg')
process.env.BOOTH_BACKGROUND = '1' // the window doesn't take the keyboard from whoever is at this computer
process.env.BOOTH_CAMERA_TIMEOUT = '4000' // a stuck camera-helper is restarted after this long

// BOOTH_APP runs a built app instead, fuses and all (e.g. "dist/mac-arm64/Open Photo Booth.app/Contents/MacOS/Open Photo Booth").
const built = process.env.BOOTH_APP
const proc = spawn(built || electron, [...(built ? [] : [import.meta.dirname]), `--user-data-dir=${profile}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-mock-keychain', '--remote-debugging-port=9333'], { stdio: ['ignore', 'ignore', 'pipe'] })
let errors = '', finished = false
proc.stderr.on('data', d => { errors += d })
proc.on('exit', code => {
  if (finished) return
  console.error(`electron exited early (code ${code})\n${errors.slice(-3000)}`)
  process.exit(1)
})
let page
for (let i = 0; i < 60 && !page; i++) {
  await sleep(500)
  page = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json()).then(l => l.find(p => p.type === 'page' && p.url.endsWith('index.html'))).catch(() => null)
}
assert.ok(page, 'app window not found on the debugging port')
// The app's window over CDP.
async function attach(target, onEvent) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    onEvent?.(m)
    pending.get(m.id)?.(m); pending.delete(m.id)
  })
  const cdp = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.error) throw new Error(`${expr} -> ${r.error.message}`) // e.g. mid-navigation
    if (r.result.exceptionDetails) throw new Error(expr + ' -> ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails))
    return r.result.result.value
  }
  // Errors count as "not yet": until app.js runs, `settings` is the #settings dialog (named element access).
  const until = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await evaluate(expr).catch(() => false)) return; await sleep(200) } throw new Error('timeout: ' + expr) }
  const shot = async file => fs.writeFile(path.join(shots, file), Buffer.from((await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 })).result.data, 'base64'))
  return { ws, cdp, evaluate, until, shot }
}
const consoleErrors = [], warnings = []
const { ws, cdp, evaluate, until, shot } = await attach(page, m => {
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) warnings.push(m.params.args.map(a => a.value ?? a.description).join(' '))
})
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }) // the page behaves as if its window had the keyboard
const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
const key = (k, modifiers = 0) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: 'Key' + k.toUpperCase(), modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) })
const clean = () => evaluate(`clearTimeout(toast.timer); document.querySelector('#toast').classList.remove('on')`)
const mod = process.platform === 'darwin' ? 4 : 2 // Cmd on macOS, Ctrl elsewhere
try {
  await cdp('Runtime.enable')
  await until('typeof Setup === "object"')
  // The test portrait comes from here, not from the app's files: a built app doesn't have test/.
  await evaluate(`window.PORTRAIT = 'data:image/jpeg;base64,${(await fs.readFile(path.join(import.meta.dirname, 'test/portrait.jpg'))).toString('base64')}'`)
  // First launch: the setup guide, over the welcome screen, names the event, picks its layout and what guests can do.
  // It starts from the event's settings, so going straight through changes nothing.
  await until('document.querySelector("#setup").open')
  assert.ok(await evaluate(`!stream && screen() === 'welcome'`), 'no camera before the setup guide is done')
  assert.equal(await evaluate(`document.querySelector('#setupName').value`), 'Anna & Ben', 'the upgraded event keeps its name')
  await clean(); await shot('setup.jpg')
  await evaluate(`document.querySelector('#setupNext').click()`)
  assert.equal(await evaluate(`document.querySelectorAll('#setupLayouts .look').length`), await evaluate('templates.length'))
  assert.equal(await evaluate(`document.querySelectorAll('#setupLayouts .look.on').length`), 1, 'the current layout is picked')
  await evaluate(`document.querySelector('#setupNext').click()`)
  const tool = label => `[...document.querySelectorAll('.setup-tool')].find(r => r.textContent.includes('${label}'))`
  assert.ok(await evaluate(`document.querySelectorAll('.setup-tool input').length === 8 && !document.querySelector('.setup-tool input:disabled')`), 'every tool is on offer')
  await evaluate(`${tool('Boomerangs')}.querySelector('input').click()`)
  await clean(); await shot('setup-guests.jpg')
  await evaluate(`document.querySelector('#setupNext').click()`)
  assert.equal(await evaluate(`document.querySelector('#setupNext').textContent`), 'Start the booth')
  await evaluate(`document.querySelector('#setupNext').click()`)
  await until(`!document.querySelector('#setup').open && settings.modeBoomerang === true && settings.eventName === 'Anna & Ben'`)
  await until(`!!stream && video.videoWidth > 0 && screen() === 'attract'`)
  assert.ok(await evaluate(`!document.querySelector('#settingsHint').hidden`), 'the start screen says how to open the settings')
  await clean(); await shot('start.jpg')
  await evaluate(`booth.saveSettings({ ...settings, modeBoomerang: false }).then(s => { settings = s; return applySettings() })`)
  console.log('setup guide ok')
  await evaluate(`booth.saveSettings({ ...settings, outputDir: ${JSON.stringify(outDir)}, countdown: 1, betweenShots: 0, eventName: 'Anna & Ben', templateId: 'builtin:classic-strip' }).then(s => { settings = s; return applySettings() })`)
  await until('video.videoWidth > 0')

  // 1. Session: files must exist while still on the review screen (saved before "Done").
  await evaluate('document.querySelector("#attract").click()')
  await until('screen() === "review"')
  await evaluate('current.saved')
  const saved = await jpgs(path.join(outDir, 'Anna & Ben'))
  assert.equal(saved.length, 5, 'four shots + layout saved before Done: ' + saved)
  assert.deepEqual((await log(path.join(outDir, 'Anna & Ben'))).map(l => [l.type, l.shots]), [['session', 4]])
  await evaluate('Review.finish()')
  console.log('session ok:', saved.join(', '))

  // 1a. A camera the booth controls (the simulated one, through camera-helper). Its live view is the preview, and its
  // photos are its own files, edited at up to 4K's size. When its cable comes out or the helper crashes, the booth carries
  // on with the webcam until it's back; a shot that hangs is given up on, and a frame of the live view stands in.
  // The operator's way in: a real click on the ⚙️ of the start screen. It opens the settings, not a photo session.
  const gear = await evaluate(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.querySelector('#corner').getBoundingClientRect())`)
  await mouse('mousePressed', gear.x, gear.y)
  await mouse('mouseReleased', gear.x, gear.y)
  await until(`document.querySelector('#settings').open`, 3000)
  assert.equal(await evaluate('screen()'), 'attract', 'the settings button starts no session')
  await until(`[...form.cameraId.options].some(o => o.value === 'tether:sim' && o.text.includes('controlled over USB'))`)
  assert.ok(await evaluate(`['Sony: ', 'α7 IV', 'Nikon: ', 'Z6III', 'Canon: '].every(s => document.querySelector('#supportedCameras').textContent.includes(s))`), 'the supported cameras are listed')
  await evaluate('document.querySelector("#settings").close()')
  await evaluate(`booth.saveSettings({ ...settings, cameraId: 'tether:sim' }).then(s => { settings = s; return applySettings() })`)
  await until('Camera.controlled() && video.videoWidth === 1024')
  await evaluate('requestSettings()')
  await until(`document.querySelector('#cameraInfo').textContent.includes("Simulated camera (full-resolution photos), on mains power. Photos at the camera's full resolution, live view at 1024")`)
  await evaluate('document.querySelector("#testShot").click()')
  await until(`!document.querySelector('#testShotImg').hidden && document.querySelector('#cameraInfo').textContent.startsWith('Test shot: ')`)
  // The camera's own settings are in the panel and change on the camera. In Auto the (simulated) camera picks its ISO
  // itself; in manual the booth sets it, and test shots then move it to suit the scene. Auto hands the exposure back
  // to the camera, with its flash on.
  const prop = k => `document.querySelector('#camPropList select[data-prop=${k}]')`
  const propShown = k => evaluate(`${prop(k)}.selectedOptions[0].text`)
  const onCamera = k => evaluate(`booth.camera.props().then(r => r.props.find(p => p.key === '${k}')).then(p => p.options[p.value])`)
  const choose = (k, text) => evaluate(`(s => { s.value = [...s.options].find(o => o.text === ${JSON.stringify(text)}).value; s.dispatchEvent(new Event('change')) })(${prop(k)})`)
  const note = `document.querySelector('#camPropsNote').textContent`
  await until(`!document.querySelector('#camProps').hidden && document.querySelectorAll('#camPropList select').length === 8`)
  assert.ok(await evaluate(`${prop('iso')}.disabled && !${prop('mode')}.disabled && ${note}.startsWith('Flash: ready.')`), 'in Auto the camera decides the ISO; its flash is found')
  await choose('mode', 'M (manual)')
  await until(`${prop('iso')} && !${prop('iso')}.disabled`)
  await choose('iso', '400')
  await until(`${prop('iso')}.selectedOptions[0].text === '400' && !${prop('iso')}.disabled`)
  assert.deepEqual([await onCamera('mode'), await onCamera('iso')], ['M (manual)', '400'])
  assert.equal(await evaluate(`booth.camera.set('iso 1\\n9 sim crash', 0).then(() => 'taken', () => 'refused')`), 'refused', 'only a setting name reaches the helper')
  await evaluate(`document.querySelector('#camMatch').click()`)
  await until(`!document.querySelector('#camMatch').disabled && /looks right|as far as it goes|after 4 test shots/.test(${note})`, 30000)
  if (!(await evaluate(`${note}.includes('looks right')`))) assert.notEqual(await onCamera('iso'), '400', 'test shots moved the ISO')
  await evaluate(`document.querySelector('#camAuto').click()`)
  await until(`${note}.includes('works out the exposure itself')`, 8000)
  assert.deepEqual([await propShown('mode'), await onCamera('iso'), await onCamera('flash'), await onCamera('ev')], ['P (program auto)', 'Auto', 'On (fill)', '0'])
  await evaluate(`showSetting(document.querySelector('#camProps')); document.querySelector('#camProps').scrollIntoView({ block: 'center' })`)
  await clean(); await shot('camera-settings.jpg')
  await evaluate('document.querySelector("#settings").close()')
  // After 10 quiet minutes on the start screen live view pauses, and a touch brings it back.
  const frames = 'video.getVideoPlaybackQuality().totalVideoFrames', moving = async () => { const a = await evaluate(frames); await sleep(600); return (await evaluate(frames)) > a }
  assert.ok(await evaluate('Camera.idle(Date.now() + 11 * 60000)'), 'live view pauses')
  await sleep(300)
  assert.ok(!(await moving()), 'no frames while paused')
  await evaluate(`document.querySelector('#attract').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  await sleep(300)
  assert.ok(await moving(), 'frames again after a touch')
  await evaluate('document.querySelector("#attract").click()')
  await until(`screen() === 'capture' && document.body.classList.contains('framed')`)
  const slotShape = `(e => e.w / e.h)(template.elements.find(e => e.type === 'Photo'))`, shown = `(r => r.width / r.height)(video.getBoundingClientRect())`
  assert.ok(Math.abs(await evaluate(`${shown} - ${slotShape}`)) < 0.02, 'the countdown preview has the photo\'s shape')
  await until(`parseFloat(video.style.objectPosition.split(' ')[1]) < 30`, 5000) // the face is near the top of this photo
  await sleep(500) // eased into place
  await shot('capture-framed.jpg')
  await until('screen() === "review"', 30000)
  assert.ok(await evaluate(`!document.body.classList.contains('framed')`), 'the full preview is back after the countdown')
  const tethered = await evaluate('current.saved.then(r => r.stamp)')
  const original = await fs.readFile(path.join(outDir, 'Anna & Ben', 'Originals', `${tethered}_1.jpg`))
  assert.equal(original.length, await evaluate('current.shots[0].original.length'), "the camera's own file is saved")
  assert.ok(original.length > 1e6, `a 20 MP photo: ${original.length} bytes`)
  assert.ok(await evaluate('current.shots.every(s => s.width * s.height <= 3840 * 2160 && s.height > 2000)'), 'edited at up to 4K')
  await evaluate('Review.finish()')
  const backOnWebcam = '!Camera.controlled() && video.videoWidth > 0 && video.videoWidth !== 1024', backOnCamera = 'Camera.controlled() && video.videoWidth === 1024'
  await evaluate(`booth.camera.sim('unplug')`)
  await until(backOnWebcam)
  await evaluate('requestSettings()')
  await until(`form.cameraId.selectedOptions[0]?.text === 'Controlled camera (not connected)'`)
  await evaluate('document.querySelector("#settings").close()')
  await evaluate(`booth.camera.sim('plug')`)
  await until(backOnCamera)
  await evaluate(`booth.camera.sim('crash').catch(() => {})`)
  await until(backOnWebcam)
  await until(backOnCamera)
  await evaluate(`booth.camera.sim('hang')`)
  await evaluate('document.querySelector("#attract").click()')
  await until('screen() === "review"', 40000)
  assert.ok(await evaluate('!current.shots[0].original && current.shots[0].width > 0'), 'a hung shot: a live view frame stands in')
  await evaluate('current.saved')
  await evaluate('Review.finish()')
  await until(backOnCamera)
  await evaluate(`booth.saveSettings({ ...settings, cameraId: '' }).then(s => { settings = s; return applySettings() })`)
  await until('!Camera.controlled() && video.videoWidth > 0 && video.videoWidth !== 1024')
  console.log('controlled camera ok')

  // 1b. Events: a new event gets its own dated folder; the settings picker switches back to the first event and its settings.
  const first = await evaluate('settings.eventId')
  await evaluate(`booth.newEvent().then(s => booth.saveSettings({ ...s, eventName: 'Gala', countdown: 0 })).then(s => { settings = s; return applySettings() })`)
  await until('video.videoWidth > 0')
  const gala = await evaluate('settings.eventId')
  assert.notEqual(gala, first)
  await evaluate('document.querySelector("#attract").click()')
  await until('screen() === "review"')
  await evaluate('current.saved')
  await evaluate('Review.finish()')
  assert.equal((await jpgs(path.join(outDir, `${day} Gala`))).length, 5, 'new event saves to its own dated folder: ' + (await jpgs(path.join(outDir, `${day} Gala`))))
  await evaluate('requestSettings()')
  await until('document.querySelector("#eventId").options.length === 2')
  await evaluate(`(p => { p.value = ${JSON.stringify(first)}; p.dispatchEvent(new Event('change')) })(document.querySelector('#eventId'))`)
  await until(`settings.eventId === ${JSON.stringify(first)} && document.querySelector('#eventId').value === ${JSON.stringify(first)} && form.eventName.value !== 'Gala'`) // the settings refilled
  assert.equal(await evaluate('form.eventName.value + "|" + form.countdown.value'), 'Anna & Ben|1')
  assert.equal(await evaluate('document.querySelector("#eventStats").textContent'), '3 sessions · 0 prints') // the first session and the controlled camera's two
  await evaluate('document.querySelector("#settings").close()')
  await evaluate(`booth.removeEvent(${JSON.stringify(gala)})`)
  assert.deepEqual((await evaluate('booth.listEvents()')).events.map(e => e.eventName), ['Anna & Ben'])
  assert.equal((await jpgs(path.join(outDir, `${day} Gala`))).length, 5, 'removing an event keeps its photos')
  console.log('events ok')

  // 1c. Review: a look applies to every photo, retaking photo 2 replaces only that file, a touch restarts the idle
  // countdown, and when it runs out the edited layout is saved and sent to auto-print (stubbed: no real printer here).
  await evaluate(`booth.saveSettings({ ...settings, reviewSeconds: 4, autoPrint: true }).then(s => { settings = s })`)
  await evaluate('printCurrent = () => { window.printed = current.sheet }')
  await evaluate('document.querySelector("#attract").click()')
  await until('screen() === "review"')
  const { stamp } = await evaluate('current.saved')
  const file = n => fs.readFile(path.join(outDir, 'Anna & Ben', n ? 'Originals' : '', `${stamp}${n}.jpg`))
  const orig = { sheet: await file(''), one: await file('_1'), two: await file('_2') }
  const slot = test => `(() => { const e = template.elements.find(e => e.type === 'Photo'), [r, g, b] = current.sheet.getContext('2d').getImageData(e.x + e.w / 2, e.y + e.h / 2, 1, 1).data; return ${test} })()`
  const pickOption = async (list, label) => {
    const q = `[...document.querySelectorAll('${list} .look')].find(b => b.textContent === '${label}')`
    await until(`!!${q}`, 8000) // tool previews render asynchronously
    await evaluate(`${q}.click()`)
  }
  await evaluate(`document.querySelector('[data-tab="bgTool"]').click()`)
  await pickOption('#bgs', 'Night')
  await until(slot('b > r + 20'), 5000) // nobody in the fake camera's frame, so the whole photo becomes the night backdrop
  await pickOption('#bgs', 'Original')
  await evaluate(`document.querySelector('[data-tab="looksTool"]').click()`)
  await pickOption('#looks', 'Black & white')
  const gray = slot('Math.max(r, g, b) - Math.min(r, g, b) <= 2')
  await until(gray, 5000) // looks render asynchronously
  const center = `[...current.sheet.getContext('2d').getImageData(current.sheet.width / 2, current.sheet.height / 2, 1, 1).data].join()`
  const plain = await evaluate(center)
  await evaluate(`document.querySelector('[data-tab="stickersTool"]').click(); document.querySelector('#stickers .sticker').click()`)
  assert.notEqual(await evaluate(center), plain, 'sticker drawn in the middle of the layout')
  const mid = await evaluate(`(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(document.querySelector('#result').getBoundingClientRect())`)
  // With a finger, as guests do. (A mouse drag here is thrown off by the real mouse pointer when it rests over the
  // test window: the browser sends its position as moves of the same pointer.)
  const touch = (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  await touch('touchStart', mid.x, mid.y)
  await touch('touchMove', mid.x + 40, mid.y + 30)
  await touch('touchMove', mid.x + 80, mid.y + 60)
  await touch('touchEnd')
  await until(`${center} === '${plain}'`, 3000).catch(() => {}) // the layout is redrawn once the drag ends
  assert.equal(await evaluate(center), plain, 'dragging the sticker away uncovers the middle')
  await evaluate(`document.querySelectorAll('.thumb .pick')[1].click(); document.querySelector('#retakeBtn').click()`)
  await until('screen() === "review"')
  await evaluate('current.saved')
  assert.ok(!(await file('_2')).equals(orig.two), 'photo 2 replaced')
  assert.ok((await file('_1')).equals(orig.one), 'photo 1 untouched')
  assert.ok(await evaluate(gray), 'the look survives a retake')
  await sleep(2500)
  await evaluate(`document.querySelector('#review').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  await sleep(2500)
  assert.equal(await evaluate('screen()'), 'review', 'a touch restarted the countdown')
  await until('screen() === "attract"', 4000)
  assert.ok(await evaluate('window.printed === current.sheet'), 'auto-print got the edited layout')
  await evaluate('current.saved')
  assert.ok(!(await file('')).equals(orig.sheet), 'edited layout saved over the original')
  await evaluate(`booth.saveSettings({ ...settings, reviewSeconds: 45, autoPrint: false }).then(s => { settings = s })`)
  console.log('review ok')

  // 1e. Capture modes: with boomerangs and videos on, the start screen offers three buttons. A boomerang saves its
  // flip-book layout at once and its MP4 when the guest finishes; a video message records sound and saves at once.
  await evaluate(`booth.saveSettings({ ...settings, modeBoomerang: true, modeVideo: true, videoSeconds: 3, background: 'night' }).then(s => { settings = s; return applySettings() })`)
  await until('video.videoWidth > 0')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#modes button')].map(b => b.textContent)`), ['📸Photos', '🔁Boomerang', '🎬Video message'])
  assert.ok(await evaluate(`document.querySelector('#startText').hidden`), 'buttons replace "Touch to start"')
  await clean(); await shot('modes.jpg')
  await evaluate(`document.querySelectorAll('#modes button')[1].click()`)
  await until('screen() === "clip"', 15000)
  const flip = (await evaluate('current.saved')).file
  assert.ok(await evaluate(`(([r, g, b]) => b > r + 20)(current.frames[0].getContext('2d').getImageData(10, 10, 1, 1).data)`), "the event's background is on the boomerang frames")
  assert.ok((await fs.stat(flip)).size > 10000, 'flip-book layout saved at once')
  await until(`document.querySelectorAll('#clipLooks .look').length > 1`)
  await evaluate(`[...document.querySelectorAll('#clipLooks .look')].find(b => b.textContent === 'Black & white').click()`)
  await sleep(300); await clean(); await shot('boomerang.jpg') // the preview redraws 15 times a second
  await evaluate('Capture.finish()')
  const boom = await evaluate('current.clip')
  assert.match(boom, /\.mp4$/)
  assert.ok((await fs.stat(boom)).size > 20000, 'boomerang MP4 saved')
  // A double tap starts one video message, not two (the microphone opens once).
  await evaluate(`(() => {
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.mics = 0
    navigator.mediaDevices.getUserMedia = c => { if (c.audio) mics++; return open(c) }
    const b = document.querySelectorAll('#modes button')[2]
    b.click(); b.click()
  })()`)
  await until('screen() === "capture" && !document.querySelector("#stopRec").hidden', 10000)
  await until('screen() === "clip"', 15000)
  assert.equal(await evaluate('mics'), 1, 'one recording for a double tap')
  const msg = await evaluate('current.clip')
  assert.ok((await fs.stat(msg)).size > 20000, 'video message saved')
  assert.match(await evaluate('current.blob.type'), /mp4a|opus/, 'recorded with sound')
  const seconds = await evaluate(`(v => v.readyState ? v.duration : new Promise(r => v.onloadedmetadata = () => r(v.duration)))(document.querySelector('#clipVideo'))`)
  assert.ok(seconds > 2 && seconds < 4.5, `video lasts the event's 3 s: ${seconds}`)
  // A look on the video message shows at once, and goes into the saved file when the guest finishes.
  await until(`document.querySelectorAll('#clipLooks .look').length > 1`)
  await evaluate(`[...document.querySelectorAll('#clipLooks .look')].find(b => b.textContent === 'Black & white').click()`)
  assert.match(await evaluate(`document.querySelector('#clipVideo').style.filter`), /grayscale/)
  const recorded = await evaluate('current.blob.size')
  await evaluate('Capture.finish()')
  assert.equal(await evaluate('current.clip'), msg, 'restyled over the plain video')
  const styled = await fs.readFile(msg)
  assert.notEqual(styled.length, recorded)
  const restyled = await evaluate(`(async () => {
    const v = Object.assign(document.createElement('video'), { muted: true, src: URL.createObjectURL(new Blob([Uint8Array.from(atob('${styled.toString('base64')}'), c => c.charCodeAt(0))], { type: 'video/mp4' })) })
    await new Promise(r => { v.onloadeddata = r })
    const c = canvas(64, 36), g = c.getContext('2d')
    g.drawImage(v, 0, 0, 64, 36)
    const d = g.getImageData(0, 0, 64, 36).data
    let tint = 0
    for (let i = 0; i < d.length; i += 4) tint = Math.max(tint, Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]))
    return { tint, seconds: v.duration }
  })()`)
  assert.ok(restyled.tint < 16, `saved in black & white: ${restyled.tint}`)
  assert.ok(restyled.seconds > 2 && restyled.seconds < 4.5, `restyled video is as long: ${restyled.seconds}`)
  await evaluate(`booth.saveSettings({ ...settings, modeBoomerang: false, modeVideo: false, background: 'none' }).then(s => { settings = s; return applySettings() })`)
  assert.ok(!(await evaluate(`document.querySelector('#startText').hidden`)))
  console.log('capture modes ok')

  // 1d. On-device AI on a real portrait (the public-domain White House portrait MediaPipe uses in its own tests):
  // one face found, Glam changes the cheek but not the background, and no-blink prefers the frame with the face.
  const ai = await evaluate(`(async () => {
    const im = await loadImage(PORTRAIT), c = canvas(im.width, im.height)
    c.getContext('2d').drawImage(im, 0, 0)
    const faces = await AI.faces(c), g = await FX.glam(c, 'strong'), studio = await FX.background(c, 'studio')
    const px = (k, p) => [...k.getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data].join()
    const cheek = faces[0].pts[205], nose = faces[0].pts[1], blank = canvas(c.width, c.height)
    let i = 0
    const best = await AI.bestShot(() => [blank, c, blank][i++], 3, 0)
    const corner = { x: 5, y: 5 }
    return { faces: faces.length, cheek: px(g, cheek) !== px(c, cheek), corner: px(g, corner) === px(c, corner), best: best === c,
      backdrop: px(studio, corner) !== px(c, corner), person: px(studio, nose) === px(c, nose),
      art: ['comic', 'sketch'].every(k => px(FX.ART[k][1](c), nose) !== px(c, nose)), green: await greenScreen() }
    // Green screen: a red square on chroma green; the green becomes the night backdrop, the square stays red.
    async function greenScreen() {
      const g = canvas(400, 300), x = g.getContext('2d')
      x.fillStyle = '#00b140'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#d02020'; x.fillRect(150, 100, 100, 100)
      const out = await FX.background(g, 'night', 50), [r, gr, b] = out.getContext('2d').getImageData(10, 10, 1, 1).data
      return px(out, { x: 200, y: 150 }) === px(g, { x: 200, y: 150 }) && b > gr && b > r
    }
  })()`)
  assert.deepEqual(ai, { faces: 1, cheek: true, corner: true, best: true, backdrop: true, person: true, art: true, green: true })
  // Face swap (only with BOOTH_FACE_MODELS, a folder with the InsightFace models). Nothing is downloaded until the
  // operator turns face swap on; then the booth fetches the models once, says so on the start screen and in the
  // settings, and keeps them. Then a mirrored copy of the portrait goes into the portrait: the face changes, the
  // background doesn't.
  assert.ok(await evaluate(`!settings.swapReady && !document.querySelector('#swapGet').hidden && document.querySelector('#swapProgress').hidden`), 'face swap is off: no models, no download')
  if (process.env.BOOTH_FACE_MODELS) {
    await evaluate(`show('attract'); booth.saveSettings({ ...settings, guestSwap: true }).then(s => { settings = s; return applySettings() })`)
    await until(`!document.querySelector('#swapProgress').hidden && document.querySelector('#swapGet').hidden && /Face swap: /.test(document.querySelector('#swapProgress').textContent)`, 5000)
    await until('settings.swapReady', 600000)
    const kept = await fs.readdir(path.join(profile, 'face-models'))
    assert.ok(kept.includes('w600k_r50.onnx') && kept.some(f => /^inswapper_128.*\.onnx$/.test(f)) && !kept.some(f => f.endsWith('.part')), `models kept: ${kept}`)
    assert.ok(await evaluate(`document.querySelector('#swapProgress').hidden && document.querySelector('#swapGet').hidden`), 'the download note goes when it is done')
    assert.equal(await evaluate(`document.querySelector('#swapStatus').textContent`), 'On this booth ✓')
    const swapped = await evaluate(`(async () => {
      const im = await loadImage(PORTRAIT), scene = canvas(im.width, im.height), guest = canvas(im.width, im.height)
      scene.getContext('2d').drawImage(im, 0, 0)
      const g = guest.getContext('2d'); g.setTransform(-1, 0, 0, 1, im.width, 0); g.drawImage(im, 0, 0)
      const out = await Swap.into(scene, guest), nose = (await AI.faces(scene))[0].pts[1]
      const px = (k, p) => [...k.getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data].join()
      return { size: out.width === scene.width && out.height === scene.height, face: px(out, nose) !== px(scene, nose), corner: px(out, { x: 5, y: 5 }) === px(scene, { x: 5, y: 5 }) }
    })()`, 300000)
    assert.deepEqual(swapped, { size: true, face: true, corner: true })
    // The Face swap tab: two guests (the portrait and its mirror image) and a one-face scene (the portrait). The first
    // guest goes in; Swap places brings in the other one.
    const scenes = path.join(tmp, 'scenes')
    await fs.mkdir(scenes)
    await fs.copyFile(path.join(import.meta.dirname, 'test/portrait.jpg'), path.join(scenes, 'scene.jpg'))
    await evaluate(`booth.saveSettings({ ...settings, guestSwap: true, swapDir: ${JSON.stringify(scenes)} }).then(s => { settings = s })`)
    await evaluate(`(async () => {
      // Each guest a head-and-shoulders crop, so both faces are big enough for the detector.
      const im = await loadImage(PORTRAIT), full = canvas(im.width, im.height)
      full.getContext('2d').drawImage(im, 0, 0)
      const pts = (await AI.faces(full))[0].pts, xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const w = (Math.max(...xs) - Math.min(...xs)) * 2.2, x = (Math.max(...xs) + Math.min(...xs)) / 2 - w / 2, y = (Math.max(...ys) + Math.min(...ys)) / 2 - w / 2
      const c = canvas(Math.round(w * 2), Math.round(w)), g = c.getContext('2d')
      g.drawImage(im, x, y, w, w, 0, 0, w, w); g.setTransform(-1, 0, 0, 1, w * 2, 0); g.drawImage(im, x, y, w, w, 0, 0, w, w)
      template = templates.find(t => t.id === 'builtin:single')
      current = { shots: [c], saved: Promise.resolve({}) }
      await Review.open()
      document.querySelector('[data-tab="swapTool"]').click()
      window.before = current.sheet.toDataURL()
    })()`)
    await until(`document.querySelectorAll('#scenes .look').length === 2`)
    assert.ok(await evaluate(`document.querySelector('#swapTurn').hidden`), 'nothing to swap yet')
    await evaluate(`document.querySelectorAll('#scenes .look')[1].click()`)
    await until('current.sheet.toDataURL() !== window.before && document.querySelector("#aiBusy").hidden', 120000)
    await clean(); await shot('faceswap.jpg')
    assert.ok(!(await evaluate(`document.querySelector('#swapTurn').hidden`)), 'two guests: Swap places shows')
    await evaluate(`window.before = current.sheet.toDataURL(); document.querySelector('#swapTurn').click()`)
    await until('current.sheet.toDataURL() !== window.before && document.querySelector("#aiBusy").hidden', 120000)
    assert.equal(await evaluate('document.querySelector("#scenes .look.on").textContent'), 'Scene 1', 'still on the same scene')

    // Live: on the start screen the scene's character takes over the face in the camera view (here a canvas showing
    // the mirrored portrait), and Me gives the camera back untouched.
    await evaluate(`show('attract'); booth.saveSettings({ ...settings, swapLive: true }).then(s => { settings = s })`)
    assert.equal(await evaluate(`(async () => {
      const im = await loadImage(PORTRAIT), c = canvas(im.width, im.height), g = c.getContext('2d')
      g.setTransform(-1, 0, 0, 1, im.width, 0)
      const paint = () => g.drawImage(im, 0, 0)
      paint(); window.painter = setInterval(paint, 50) // a canvas stream only sends frames when the canvas is drawn
      window.camera = stream; window.source = c
      stream = c.captureStream(20); video.srcObject = stream
      await Swap.reset()
      return document.querySelectorAll('#characters button').length
    })()`), 2, 'Me and one character')
    await clean(); await shot('live-characters.jpg')
    await evaluate(`document.querySelectorAll('#characters button')[1].click()`)
    await until('video.srcObject !== stream && video.videoWidth > 0', 30000)
    // The swapped face differs from the source far more than the background does (which only goes through video frames).
    const diff = `(async () => {
      const s = window.source, f = canvas(s.width, s.height), g = f.getContext('2d')
      g.drawImage(video, 0, 0, s.width, s.height)
      const pts = (await AI.faces(s))[0].pts, xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
      const mean = (x, y, w, h) => {
        const a = s.getContext('2d').getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data, b = g.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data
        let t = 0
        for (let i = 0; i < a.length; i += 4) t += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
        return t / (a.length / 4)
      }
      const face = mean(box.x + box.w / 4, box.y + box.h / 4, box.w / 2, box.h / 2), corner = mean(0, 0, 40, 40)
      return face > corner * 2 + 6 && { face, corner }
    })()`
    await until(diff, 60000)
    console.log('live swap', await evaluate(diff))
    await evaluate(`document.querySelectorAll('#characters button')[0].click()`)
    assert.ok(await evaluate(`video.srcObject === stream && stream.getVideoTracks()[0].readyState === 'live'`), 'camera given back')
    await evaluate(`clearInterval(window.painter); stream.getTracks().forEach(t => t.stop()); stream = window.camera; video.srcObject = stream`)
    await evaluate(`template = templates.find(t => t.id === settings.templateId); booth.saveSettings({ ...settings, guestSwap: false, swapLive: false, swapDir: '' }).then(s => { settings = s; return applySettings() })`)
    console.log('face swap ok')
  }

  // Props on the whole tall portrait in a wide single-photo slot: a centered crop would cut the head off, the face-aware
  // crop keeps it, and tapping the sunglasses puts them on the face.
  await evaluate(`(async () => {
    const im = await loadImage(PORTRAIT), c = canvas(im.width, im.height)
    c.getContext('2d').drawImage(im, 0, 0)
    template = templates.find(t => t.id === 'builtin:single')
    current = { shots: [c], saved: Promise.resolve({}) }
    await Review.open()
    document.querySelector('[data-tab="stickersTool"]').click()
    window.before = current.sheet.toDataURL()
  })()`)
  await until(`document.querySelectorAll('#props .sticker').length === 4`)
  await evaluate(`document.querySelector('#props .sticker').click()`)
  await until(`current.sheet.toDataURL() !== window.before`, 5000)
  assert.ok(!(await evaluate(`document.querySelector('#toast').classList.contains('on')`)), 'no "no faces" message')
  await evaluate(`show('attract'); template = templates.find(t => t.id === settings.templateId)`)
  console.log('ai ok')

  // 2. PIN lock.
  await evaluate(`booth.saveSettings({ ...settings, pin: '1234' }).then(s => { settings = s })`)
  await evaluate('requestSettings()')
  assert.ok(await evaluate('pinDialog.open && !settings.open'))
  await evaluate(`pinInput.value = '9999'; pinForm.requestSubmit(pinForm.querySelector('[value=ok]'))`)
  await sleep(500)
  assert.ok(await evaluate('!document.querySelector("#settings").open'), 'wrong PIN must not open settings')
  await evaluate('requestSettings()')
  await evaluate(`pinInput.value = '1234'; pinForm.requestSubmit(pinForm.querySelector('[value=ok]'))`)
  await until('document.querySelector("#settings").open')
  await evaluate(`booth.saveSettings({ ...settings, pin: '' }).then(s => { settings = s })`)
  console.log('pin ok')
  await clean(); await sleep(400)
  await shot('settings.jpg')
  assert.ok(await evaluate(`document.querySelector('#settingsHint').hidden && localStorage.getItem('settingsFound') === '1'`), 'the hint goes once the settings are found')
  const { version } = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'package.json'), 'utf8'))
  assert.equal(await evaluate(`document.querySelector('#version').textContent`), `Open Photo Booth ${version}`)
  assert.equal(await evaluate(`showSection('Printing'); [document.querySelector('#settingsNav [aria-current]').textContent, [...document.querySelectorAll('#settings .grid > h3')].filter(h => h.offsetParent).map(h => h.textContent).join(), document.querySelectorAll('#settingsNav button').length === document.querySelectorAll('#settings .grid > h3').length].join('|')`), 'Printing|Printing|true', 'the settings menu shows one section at a time')
  const columns = `new Set([...document.querySelectorAll('#settings .grid > label')].filter(l => l.offsetParent).map(l => Math.round(l.getBoundingClientRect().left))).size`
  assert.equal(await evaluate(columns), 1, 'every setting lines up in its column')
  await evaluate('document.querySelector("#settings").close()')

  // 3. Editor: add text, drag it, undo, save as a user layout, use it in the booth.
  await evaluate(`Editor.open('builtin:classic-strip')`)
  await until('screen() === "editor"')
  await sleep(400)
  const before = await evaluate('templates.find(t => t.id === "builtin:classic-strip").elements.length')
  await evaluate(`document.querySelector('[data-add="Text"]').click()`)
  const box = await evaluate(`(() => { const r = edCanvas.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / 600 } })()`)
  const textX = Number(await evaluate(`document.querySelector('#edProps [data-key="x"]').value`))
  const cx = box.left + (textX + 150) * box.scale, cy = box.top + 900 * box.scale
  await mouse('mousePressed', cx, cy)
  await mouse('mouseMoved', cx + 10, cy - 60)
  await mouse('mouseMoved', cx + 20, cy - 120)
  await mouse('mouseReleased', cx + 20, cy - 120)
  const movedY = Number(await evaluate(`document.querySelector('#edProps [data-key="y"]').value`))
  assert.ok(movedY < 870, 'drag moved the text up: y=' + movedY)
  await key('z', mod)
  const undoneY = Number(await evaluate(`document.querySelector('#edProps [data-key="y"]').value`))
  assert.ok(undoneY > movedY, `undo restored position (${undoneY} > ${movedY})`)
  await key('z', mod | 8) // redo (Shift)
  await evaluate(`(() => { const i = document.querySelector('#edProps [data-key="text"]'); i.value = 'Thanks for coming!'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')) })()`)
  await evaluate(`document.querySelector('#edSave').click()`)
  await until(`templates.some(t => t.id.startsWith('user:classic-strip'))`)
  const newId = await evaluate(`templates.find(t => t.id.startsWith('user:classic-strip')).id`)
  const xml = await fs.readFile(path.join(profile, 'templates', newId.slice(5), 'template.xml'), 'utf8')
  assert.ok(xml.includes('Thanks for coming!'), 'saved xml has the new text')
  assert.equal(await evaluate(`templates.find(t => t.id === '${newId}').elements.length`), before + 1)
  await evaluate(`document.querySelector('#edUse').click()`)
  await until(`settings.templateId === '${newId}' && template.id === '${newId}'`)
  console.log('editor ok:', newId)
  await evaluate(`Editor.open('builtin:postcard')`)
  await sleep(400)
  const pb = await evaluate(`(() => { const r = edCanvas.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / 1800 } })()`)
  await mouse('mousePressed', pb.left + 600 * pb.scale, pb.top + 900 * pb.scale)
  await mouse('mouseReleased', pb.left + 600 * pb.scale, pb.top + 900 * pb.scale)
  await clean(); await sleep(400)
  await shot('editor.jpg')

  // 4. Screenshots: review screen and all built-in layouts with placeholder photos.
  await evaluate(`show('attract'); template = templates.find(t => t.id === 'builtin:postcard'); current = { shots: placeholderShots(4), saved: Promise.resolve({}) }; Review.open(); document.querySelector('#stickers .sticker').click()`)
  await evaluate(`document.querySelector('[data-tab="looksTool"]').click(); document.querySelectorAll('.thumb .pick')[1].click()`)
  await clean(); await sleep(400)
  await shot('review.jpg')
  const sheet = await evaluate(`(() => {
    const ts = ['classic-strip', 'postcard', 'grid', 'single'].map(n => templates.find(t => t.id === 'builtin:' + n)), H = 900, gap = 40
    const imgs = ts.map(t => compose(placeholderShots(t.shots), t))
    const W = imgs.reduce((s, c) => s + c.width * H / c.height, 0) + gap * (imgs.length + 1)
    const out = canvas(Math.round(W), H + gap * 2), ctx = out.getContext('2d')
    ctx.fillStyle = '#16161a'; ctx.fillRect(0, 0, out.width, out.height)
    let x = gap
    for (const c of imgs) { const w = c.width * H / c.height; ctx.drawImage(c, x, gap, w, H); x += w + gap }
    return out.toDataURL('image/jpeg', .88)
  })()`)
  await fs.writeFile(path.join(shots, 'layouts.jpg'), Buffer.from(sheet.split(',')[1], 'base64'))

  assert.deepEqual(consoleErrors, [], 'no uncaught page errors')
  console.log('all ok')
} catch (e) {
  console.error(`The page's errors and warnings:\n${[...consoleErrors, ...warnings].slice(-20).join('\n')}`)
  throw e
} finally {
  finished = true
  ws.close()
  if (proc.exitCode === null) { proc.kill(); await new Promise(r => proc.once('exit', r)) }
  await fs.rm(tmp, { recursive: true, force: true })
}
