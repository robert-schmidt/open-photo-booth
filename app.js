/* global booth, Layout, Events, Review, AI, Capture, Setup, Camera, CAMERAS */
const $ = s => document.querySelector(s)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FILTERS = {
  none: ['None', 'none'],
  bw: ['Black & white', 'grayscale(1) contrast(1.15)'],
  sepia: ['Sepia', 'sepia(.85)'],
  warm: ['Warm', 'sepia(.3) saturate(1.4)'],
  vivid: ['Vivid', 'saturate(1.6) contrast(1.1)'],
  fade: ['Faded', 'contrast(.85) brightness(1.1) saturate(.7)'],
}
const video = $('#video'), form = $('#settingsForm')
for (const c of CAMERAS) $('#supportedCameras').append(Object.assign(document.createElement('p'), { textContent: `${c.maker}: ${[c.models.join(', '), c.note].filter(Boolean).join('. ')}` }))
let settings, templates = [], template, assets = {}, stream, current
const CAMERA_TERMS = `Before the booth controls your camera:

• A camera's maker may stop covering it under warranty once it has been controlled by software like this. Sony says so for its cameras.
• The makers' terms forbid using the camera software for weapons or military purposes.
• Open Photo Booth is not made, endorsed or supported by Sony, Nikon or any camera maker.

Control this camera?`

const show = screen => { document.body.dataset.screen = screen }
const screen = () => document.body.dataset.screen
const fill = (select, options) => select.replaceChildren(...options.map(([value, text]) => new Option(text, value)))
const loadImage = src => new Promise((res, rej) => Object.assign(new Image(), { onload() { res(this) }, onerror: rej, src }))
function canvas(w, h) { return Object.assign(document.createElement('canvas'), { width: w, height: h }) }
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove('on'), 4000)
}

async function startCamera() {
  stream?.getTracks().forEach(t => t.stop())
  stream = await Camera.open(settings.cameraId)
  video.srcObject = stream
  video.classList.toggle('mirror', settings.mirror)
  if (!stream) toast('No camera found. Tap ⚙️ in the top-right corner to open settings.')
}

// Parses every template and preloads their images into assets[templateId][src].
async function loadTemplates() {
  templates = (await booth.listTemplates()).flatMap(t => {
    try { return [{ id: t.id, builtin: t.id.startsWith('builtin:'), ...Layout.parse(t.xml) }] } catch { return [] }
  })
  template = templates.find(t => t.id === settings.templateId) || templates[0]
  assets = {}
  await Promise.all(templates.flatMap(t => t.elements.filter(e => e.type === 'Image' && e.src).map(async e => {
    const url = await booth.templateAsset(t.id, e.src)
    const img = url && await loadImage(url).catch(() => null)
    if (img) (assets[t.id] ??= {})[e.src] = img
  })))
}

async function applySettings() {
  $('#eventTitle').textContent = settings.eventName
  $('#startText').textContent = settings.startText
  await loadTemplates()
  await startCamera()
  Capture.attract()
}

function grab() {
  const c = canvas(video.videoWidth, video.videoHeight), ctx = c.getContext('2d')
  if (settings.mirror) ctx.setTransform(-1, 0, 0, 1, c.width, 0)
  ctx.drawImage(video, 0, 0)
  return c
}

// Colorful numbered stand-ins for photos, used by layout previews and the editor.
const placeholders = []
function placeholder(i) {
  if (placeholders[i]) return placeholders[i]
  const c = canvas(1500, 1000), ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, 1500, 1000)
  g.addColorStop(0, `hsl(${200 + i * 67} 65% 60%)`)
  g.addColorStop(1, `hsl(${250 + i * 67} 55% 35%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1500, 1000)
  Object.assign(ctx, { fillStyle: 'rgba(255,255,255,.85)', font: 'bold 420px system-ui, sans-serif', textAlign: 'center', textBaseline: 'middle' })
  ctx.fillText(i + 1, 750, 530)
  return (placeholders[i] = c)
}
const placeholderShots = n => Array.from({ length: n }, (_, i) => placeholder(i))

// qr: a QR code canvas for the layout's QRCode elements (nothing fills them in this app); null draws nothing
// there (sharing is off); left out, a placeholder shows where it goes (previews and the layout editor).
function compose(shots, t = template, { filter = settings.filter, images = assets[t.id] || {}, qr } = {}) {
  const c = canvas(t.width, t.height), ctx = c.getContext('2d')
  const vars = { event: settings.eventName, date: new Date().toLocaleDateString() }
  ctx.fillStyle = Layout.css(t.background)
  ctx.fillRect(0, 0, c.width, c.height)
  for (const e of t.elements) {
    ctx.save()
    ctx.globalAlpha = e.opacity / 100
    ctx.translate(e.x + e.w / 2, e.y + e.h / 2)
    ctx.rotate(e.rotation * Math.PI / 180)
    ctx.translate(-e.w / 2, -e.h / 2)
    if (e.shadow) {
      const a = e.shadowAngle * Math.PI / 180
      Object.assign(ctx, { shadowColor: Layout.css(e.shadowColor), shadowBlur: e.shadowBlur, shadowOffsetX: e.shadowDepth * Math.cos(a), shadowOffsetY: -e.shadowDepth * Math.sin(a) })
    }
    if (e.type === 'Photo') {
      // ponytail: photo slots always cover-crop; KeepAspect only changes how Image elements are fitted
      const s = shots[e.photo - 1]
      if (s) {
        const k = Layout.cover(s.width, s.height, e.w, e.h, s.focus?.x, s.focus?.y) // focus: where the faces are, if known
        ctx.filter = FILTERS[filter]?.[1] || 'none'
        ctx.drawImage(s, k.sx, k.sy, k.sw, k.sh, 0, 0, e.w, e.h)
        ctx.filter = 'none'
      }
    } else if (e.type === 'Image') {
      const img = images[e.src]
      if (img && e.keepAspect) { const k = Layout.contain(img.width, img.height, e.w, e.h); ctx.drawImage(img, k.dx, k.dy, k.dw, k.dh) }
      else if (img) ctx.drawImage(img, 0, 0, e.w, e.h)
    } else if (e.type === 'QRCode') {
      if (qr !== null) {
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, e.w, e.h)
      }
      if (qr) {
        const pad = Math.min(e.w, e.h) * 0.06, k = Layout.contain(qr.width, qr.height, e.w - 2 * pad, e.h - 2 * pad)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(qr, pad + k.dx, pad + k.dy, k.dw, k.dh)
        ctx.imageSmoothingEnabled = true
      } else if (qr === undefined) {
        Object.assign(ctx, { fillStyle: '#999', font: `bold ${Math.min(e.w, e.h) * 0.3}px system-ui, sans-serif`, textAlign: 'center', textBaseline: 'middle' })
        ctx.fillText('QR', e.w / 2, e.h / 2)
      }
    } else if (e.type === 'Text') {
      const align = ['left', 'right'].includes(e.align) ? e.align : 'center'
      const lines = Layout.fillText(e.text, vars).split('\n'), font = size => `${size}px "${e.font}", sans-serif`
      // Text shrinks to fit its box, so long event names never spill over the photos.
      ctx.font = font(e.size)
      const widest = Math.max(...lines.map(l => ctx.measureText(l).width))
      const size = e.size * Math.min(1, e.w / widest, e.h / (lines.length * e.size * 1.2))
      Object.assign(ctx, { font: font(size), fillStyle: Layout.css(e.textColor), textAlign: align, textBaseline: 'middle' })
      const x = { left: 0, right: e.w, center: e.w / 2 }[align]
      lines.forEach((l, i) => ctx.fillText(l, x, e.h / 2 + (i - (lines.length - 1) / 2) * size * 1.2))
    } else {
      ctx.beginPath()
      if (e.type === 'Ellipse') ctx.ellipse(e.w / 2, e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2)
      else ctx.rect(0, 0, e.w, e.h)
      ctx.fillStyle = Layout.css(e.fill)
      ctx.fill()
    }
    if (e.strokeWidth > 0) {
      Object.assign(ctx, { shadowColor: 'transparent', lineWidth: e.strokeWidth, strokeStyle: Layout.css(e.strokeColor) })
      if (e.type === 'Ellipse') ctx.stroke()
      else ctx.strokeRect(e.strokeWidth / 2, e.strokeWidth / 2, e.w - e.strokeWidth, e.h - e.strokeWidth)
    }
    ctx.restore()
  }
  return c
}

// A 2x6 strip printed twice side by side fills a 4x6 sheet (cut in half after printing).
function twoUp(c) {
  const wide = c.width > c.height, out = canvas(wide ? c.width : c.width * 2, wide ? c.height * 2 : c.height)
  const ctx = out.getContext('2d')
  ctx.drawImage(c, 0, 0)
  ctx.drawImage(c, wide ? 0 : c.width, wide ? c.height : 0)
  return out
}

async function save(c, name) {
  if (c.original) return booth.savePhoto(name, c.original) // a controlled camera's photo, as the camera took it
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))
  return booth.savePhoto(name, await blob.arrayBuffer())
}

// Every session is written to disk as soon as it is captured, so nothing is lost if the booth is closed mid-review.
async function saveSession({ shots, sheet }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  for (const [i, s] of shots.entries()) await save(s, `${stamp}_${i + 1}.jpg`)
  const file = await save(sheet, `${stamp}.jpg`)
  await booth.logSession({ type: 'session', stamp, shots: shots.length, layout: template.id })
  return { stamp, file }
}

// One countdown, one photo, one flash.
async function shoot() {
  for (let n = settings.countdown; n > 0; n--) {
    $('#count').textContent = n
    if (n === 1) Camera.focus()
    await sleep(1000)
  }
  $('#count').textContent = ''
  const flash = () => { $('#flash').classList.remove('on'); void $('#flash').offsetWidth; $('#flash').classList.add('on') }
  // A camera the booth controls takes the photo itself. If it can't (busy, out of focus, gone), a frame of its live
  // view stands in, so the guest still gets a photo.
  if (Camera.controlled()) {
    if (settings.noBlink) await AI.openEyes(grab)
    flash()
    const shot = await Camera.photo().catch(e => console.warn("The camera didn't take the photo:", e))
    if (shot) return shot
  }
  const shot = settings.noBlink ? await AI.bestShot(grab) : grab()
  flash()
  return shot
}

async function startSession() {
  if (screen() !== 'attract') return
  if (!stream || !template) return toast(!stream ? 'No camera found.' : 'No layout available.')
  if (!video.videoWidth) return toast('Camera is starting, try again in a moment.')
  show('capture')
  frame(true)
  try {
    const shots = []
    for (let i = 1; i <= template.shots; i++) {
      $('#status').textContent = template.shots > 1 ? `Photo ${i} of ${template.shots}` : ''
      shots.push(await shoot())
      if (i < template.shots) await sleep(settings.betweenShots * 1000)
    }
    current = { shots }
    await Review.open() // sets current.sheet with the event's default look, so the first save already has it
    current.saved = saveSession(current)
    current.saved.catch(e => toast(`Could not save photos: ${e.message}`))
  } catch (e) {
    show('attract')
    toast(`Something went wrong: ${e.message}`)
  } finally {
    frame(false)
  }
}

// During a photo countdown the preview shows just what the layout's first photo is cut from, with black around it, so
// guests see what will be in the photo. Like the photo, the cut follows the faces (a few times a second, eased).
let framing
function frame(on) {
  const slot = template.elements.find(e => e.type === 'Photo')
  clearInterval(framing)
  video.style.objectPosition = ''
  if (slot) document.body.style.setProperty('--a', slot.w / slot.h)
  document.body.classList.toggle('framed', on && !!slot)
  if (!on || !slot) return
  const follow = async () => {
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, 640 / vw), c = canvas(Math.round(vw * k), Math.round(vh * k))
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height) // unmirrored, like object-position (the flip comes after)
    const pts = (await AI.faces(c).catch(() => [])).flatMap(f => f.pts)
    if (!pts.length || !document.body.classList.contains('framed')) return
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
    const r = Layout.cover(vw, vh, slot.w, slot.h, (Math.min(...xs) + Math.max(...xs)) / 2 / c.width, (Math.min(...ys) + Math.max(...ys)) / 2 / c.height)
    video.style.objectPosition = `${vw > r.sw ? (r.sx / (vw - r.sw)) * 100 : 50}% ${vh > r.sh ? (r.sy / (vh - r.sh)) * 100 : 50}%`
  }
  follow()
  framing = setInterval(follow, 400)
}

async function printCurrent() {
  $('#print').disabled = true // one print per session from the booth; reprint from the photos folder
  const { saved, sheet } = current, t = template // the next guest may start before this print is sent
  try {
    const { stamp, file } = await saved
    const strip = Math.max(t.width, t.height) / Math.min(t.width, t.height) >= 2.5
    let path = file, w = t.width, h = t.height
    if (strip && settings.print2up) {
      const two = twoUp(sheet)
      path = await save(two, `${stamp}_print.jpg`)
      w = two.width; h = two.height
    }
    toast('Printing…')
    const err = await booth.print(path, w / t.dpi, h / t.dpi)
    if (err) toast(`Print failed: ${err}`)
    else booth.logSession({ type: 'print', stamp })
  } catch (e) {
    toast(`Print failed: ${e.message}`)
  }
}

// Settings
const fillTemplates = () => fill(form.templateId, templates.map(t => [t.id, `${t.name} (${t.shots} photo${t.shots > 1 ? 's' : ''})`]))
function updatePreview() {
  const t = templates.find(t => t.id === form.templateId.value)
  if (t) $('#preview').src = compose(placeholderShots(t.shots), t, { filter: form.filter.value }).toDataURL('image/jpeg', 0.85)
}

// Until the operator has opened the settings once, the start screen says how (they're hidden from guests).
let settingsFound = false
try { settingsFound = !!localStorage.getItem('settingsFound') } catch {}
$('#settingsHint').hidden = settingsFound
$('#settingsHint kbd').textContent = navigator.userAgent.includes('Mac') ? '⌘ ,' : 'Ctrl + ,'

function requestSettings() {
  if (document.querySelector('dialog[open]') || ['editor', 'welcome'].includes(screen())) return
  if (!settings.pin) return openSettings()
  $('#pinInput').value = ''
  $('#pinDialog').showModal()
}

async function openSettings() {
  $('#settingsHint').hidden = true
  try { localStorage.setItem('settingsFound', '1') } catch {}
  await Events.fillSettings()
  // The camera list can take a second or two (the first question to a controlled camera): the panel doesn't wait for it.
  const cameras = Camera.list()
  fill(form.cameraId, [['', 'Default camera'], ...(settings.cameraId ? [[settings.cameraId, 'Looking for cameras…']] : [])])
  cameras.then(list => { fill(form.cameraId, [['', 'Default camera'], ...list]); form.cameraId.value = settings.cameraId })
  $('#cameraInfo').textContent = await Camera.info()
  $('#testShot').hidden = !Camera.controlled()
  $('#testShotImg').hidden = true
  fillTemplates()
  fill(form.filter, Object.entries(FILTERS).map(([k, [label]]) => [k, label]))
  fill(form.printer, [['', 'Ask each time (print dialog)'], ...(await booth.listPrinters()).map(p => [p.name, p.displayName || p.name])])
  for (const el of form.elements) if (el.name in settings) el[el.type === 'checkbox' ? 'checked' : 'value'] = settings[el.name]
  updatePreview()
  Swap.status()
  if (!$('#settings').open) $('#settings').showModal() // also called to refill the open dialog after switching events
}

async function saveForm() {
  const next = { ...settings }
  for (const el of form.elements) {
    if (el.name in settings) next[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value
  }
  // The camera makers' terms (Sony's, for its SDK) ask that the operator hears this and agrees, once, before the booth
  // controls a camera.
  let agreed = true
  try { agreed = !!localStorage.getItem('cameraTerms') } catch {}
  if (next.cameraId.startsWith('tether:') && !agreed) {
    if (await booth.confirm(CAMERA_TERMS)) { try { localStorage.setItem('cameraTerms', '1') } catch {} } else next.cameraId = settings.cameraId
  }
  settings = await booth.saveSettings(next)
  await applySettings()
}

form.addEventListener('submit', e => { if (e.submitter?.value === 'save') saveForm() })
form.templateId.onchange = form.filter.onchange = updatePreview
$('#pinForm').addEventListener('submit', () => {
  if ($('#pinInput').value === settings.pin) openSettings()
  else toast('Wrong PIN')
})
$('#pinCancel').onclick = () => $('#pinDialog').close()
$('#cancelSettings').onclick = () => $('#settings').close()
$('#choose').onclick = async () => { form.outputDir.value = (await booth.chooseFolder()) || form.outputDir.value }
$('#import').onclick = async () => {
  try {
    const id = await booth.importTemplate()
    if (!id) return
    await loadTemplates()
    fillTemplates()
    if (templates.some(t => t.id === id)) { form.templateId.value = id; updatePreview() }
    else toast('That template.xml could not be read.')
  } catch (e) {
    toast(`Import failed: ${e.message}`)
  }
}
$('#openEditor').onclick = () => { $('#settings').close(); Editor.open(form.templateId.value) }
$('#openFolder').onclick = () => booth.openFolder()
// A photo with the camera, to check focus, exposure and the flash before guests arrive. Not saved.
$('#testShot').onclick = async () => {
  const b = $('#testShot'), t = Date.now()
  b.disabled = true
  try {
    const c = await Camera.photo()
    $('#testShotImg').src = c.toDataURL('image/jpeg', 0.8)
    $('#testShotImg').hidden = false
    $('#cameraInfo').textContent = `Test shot: ${c.camera.width} × ${c.camera.height}, ${((Date.now() - t) / 1000).toFixed(1)} s.`
  } catch (e) {
    $('#cameraInfo').textContent = `The camera didn't take the photo: ${e.message}`
  } finally {
    b.disabled = false
  }
}
$('#quit').onclick = () => booth.quit()
$('#repoLink').onclick = () => booth.openRepo()

// Booth controls
$('#attract').onclick = () => Capture.start()

$('#corner').onclick = requestSettings
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') return requestSettings()
  // Not while typing, and not on autorepeat (a held key or a bouncy booth button).
  if (document.querySelector('dialog[open]') || (e.key !== ' ' && e.key !== 'Enter') || e.repeat || e.target.closest?.('input, textarea, select')) return
  if (screen() === 'attract') { e.preventDefault(); Capture.start() }
  else if (screen() === 'review') { e.preventDefault(); Review.finish() }
  else if (screen() === 'clip') { e.preventDefault(); Capture.finish() }
})

// Boot, once every script has run. On first launch the setup guide comes first, over the welcome screen; only then
// does the camera start.
addEventListener('DOMContentLoaded', async () => {
  settings = await booth.getSettings()
  booth.version().then(v => { $('#version').textContent = `Open Photo Booth ${v}` })
  const more = await Setup.firstRun()
  await applySettings()
  show('attract')
  if (more) await openSettings()
})
