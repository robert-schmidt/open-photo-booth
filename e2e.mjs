// End-to-end check: drives the real app over CDP with Chromium's fake camera through a photo session, the settings PIN
// and the layout editor. Runs in a throwaway profile, so your own settings, layouts and photos are never touched.
// Usage: npm run e2e [-- <dir>]   saves screenshots to <dir>; `npm run e2e -- docs` refreshes the README images.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import electron from 'electron'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-e2e-'))
const outDir = path.join(tmp, 'photos'), profile = path.join(tmp, 'profile'), shots = process.argv[2] || tmp
const sleep = ms => new Promise(r => setTimeout(r, ms))
await fs.mkdir(shots, { recursive: true })

const proc = spawn(electron, [import.meta.dirname, `--user-data-dir=${profile}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--remote-debugging-port=9333'], { stdio: ['ignore', 'ignore', 'pipe'] })
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
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pending = new Map(), consoleErrors = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  pending.get(m.id)?.(m); pending.delete(m.id)
})
const cdp = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expr => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) throw new Error(expr + ' -> ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails))
  return r.result.result.value
}
// Errors count as "not yet": until app.js runs, `settings` is the #settings dialog (named element access).
const until = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await evaluate(expr).catch(() => false)) return; await sleep(200) } throw new Error('timeout: ' + expr) }
const shot = async file => fs.writeFile(path.join(shots, file), Buffer.from((await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 })).result.data, 'base64'))
const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
const key = (k, modifiers = 0) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: 'Key' + k.toUpperCase(), modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) })
const clean = () => evaluate(`clearTimeout(toast.timer); document.querySelector('#toast').classList.remove('on')`)
const mod = process.platform === 'darwin' ? 4 : 2 // Cmd on macOS, Ctrl elsewhere

try {
  await cdp('Runtime.enable')
  await until('typeof settings === "object" && !!stream && !!template && video.videoWidth > 0')
  await evaluate(`booth.saveSettings({ ...settings, outputDir: ${JSON.stringify(outDir)}, countdown: 1, betweenShots: 0, eventName: 'Anna & Ben', templateId: 'builtin:classic-strip' }).then(s => { settings = s; return applySettings() })`)
  await until('video.videoWidth > 0')

  // 1. Session: files must exist while still on the review screen (saved before "Done").
  await evaluate('document.querySelector("#attract").click()')
  await until('screen() === "review"')
  await evaluate('current.saved')
  const saved = await fs.readdir(path.join(outDir, 'Anna & Ben'))
  assert.equal(saved.length, 5, 'four shots + layout saved before Done: ' + saved)
  await evaluate('done()')
  console.log('session ok:', saved.join(', '))

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
  await evaluate(`show('attract'); template = templates.find(t => t.id === 'builtin:postcard')`)
  await evaluate(`document.querySelector('#result').src = compose(placeholderShots(4)).toDataURL('image/jpeg', .9); show('review')`)
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
} finally {
  finished = true
  ws.close()
  if (proc.exitCode === null) { proc.kill(); await new Promise(r => proc.once('exit', r)) }
  await fs.rm(tmp, { recursive: true, force: true })
}
