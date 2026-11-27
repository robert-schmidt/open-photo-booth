/* global tr, translatePage, LANGS, booth, Layout, Events, Review, AI, Capture, Setup, Camera, CAMERAS, Enhance, FX */
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
let settings, templates = [], template, assets = {}, stream, current, lutDir, slideTimer, slideRun = 0
const CAMERA_TERMS = `Before the booth controls your camera:

• A camera's maker may stop covering it under warranty once it has been controlled by software like this. Sony says so for its cameras.
• The makers' terms forbid using the camera software for weapons or military purposes.
• Open Photo Booth is not made, endorsed or supported by Sony, Nikon or any camera maker.

Control this camera?`

const show = screen => {
  document.body.dataset.screen = screen
  if (screen === 'attract' && settings?.attractOwn) startSlides() // with the photos of the session that just ended
}
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
  translatePage(settings.lang)
  $('#startText').textContent = tr(settings.startText) // "Touch to start" follows the language; a text of the operator's own stays
  await loadTemplates()
  if (lutDir !== settings.lutDir) FX.luts(await booth.listLuts()) // read again when the event's looks folder changes
  lutDir = settings.lutDir
  await startCamera()
  Capture.attract()
  startSlides()
  Swap.ensure()
}

// Start screen pictures: the event's folder of images shows in place of the camera view, one as a background, several
// as a slideshow. Not with live face swap characters: there guests need to see themselves.
// The start screen's pictures: the event's own folder of them, then (if the event shows them) its newest photos,
// which are shown whole where the others fill the screen.
async function startSlides() {
  const run = ++slideRun, layers = $('#slides').children
  const slides = settings.guestSwap && settings.swapLive ? [] : [...(await booth.listImages('attractDir')).map(url => ({ url })), ...(await booth.listImages('own')).map(url => ({ url, own: true }))]
  if (run !== slideRun) return // asked again meanwhile
  clearInterval(slideTimer)
  let n = 0
  const next = () => {
    const s = slides[n % slides.length]
    layers[n % 2].style.backgroundImage = `url("${s.url}")`
    layers[n % 2].classList.toggle('own', !!s.own)
    layers[n % 2].classList.add('on')
    layers[++n % 2].classList.remove('on')
  }
  $('#slides').hidden = !slides.length
  if (slides.length) next()
  if (slides.length > 1) slideTimer = setInterval(next, 7000)
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
  if (!video.videoWidth) return toast(tr('Camera is starting, try again in a moment.'))
  show('capture')
  frame(true)
  try {
    const shots = []
    for (let i = 1; i <= template.shots; i++) {
      $('#status').textContent = template.shots > 1 ? tr('Photo {n} of {total}', { n: i, total: template.shots }) : ''
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
    toast(tr('Printing…'))
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

// The settings' menu. The form is one grid of rows under h3 headings: the menu lists the headings, each with its icon
// (a colour and a 24-unit outline, drawn here), and one section's rows show at a time. A heading without an icon gets the cog.
const SECTION_ICONS = {
  Account: ['#3d8bfd', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  Event: ['#ff4f6d', '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  Camera: ['#6e7480', '<path d="M3 9a2 2 0 0 1 2-2h2.5L9 4.5h6L16.5 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13.5" r="3.5"/>'],
  Photos: ['#2fb457', '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>'],
  'Guests can make': ['#f08a17', '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3"/>'],
  'Guest tools': ['#a15cf0', '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18.5 15v5M16 17.5h5"/>'],
  'Guest details': ['#3d8bfd', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  'Face swap': ['#e7559a', '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>'],
  Printing: ['#1ea7c5', '<path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/>'],
  Admin: ['#8a8a93', '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'],
  Updates: ['#5e6ad2', '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>'],
  About: ['#5e6ad2', '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>'],
}
const COG = ['#6e7480', '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>']
let section // the heading of the section on show
function showSection(name = section) {
  const grid = $('#settingsForm .grid'), nav = $('#settingsNav'), heads = [...grid.querySelectorAll(':scope > h3')].map(h => h.textContent)
  const was = section, focused = nav.contains(document.activeElement)
  section = heads.includes(name) ? name : heads[0]
  let under
  for (const el of grid.children) {
    if (el.tagName === 'H3') under = el.textContent
    el.classList.toggle('sec-off', under !== section)
  }
  nav.replaceChildren(...heads.map(h => {
    const [color, outline] = SECTION_ICONS[h] || COG, b = document.createElement('button')
    b.type = 'button'
    b.innerHTML = `<i><svg viewBox="0 0 24 24" aria-hidden="true">${outline}</svg></i>`
    b.firstChild.style.background = `linear-gradient(${color}, color-mix(in srgb, ${color} 78%, #000))`
    b.append(h)
    if (h === section) b.setAttribute('aria-current', 'true')
    b.onclick = () => showSection(h)
    return b
  }))
  if (focused) nav.querySelector('[aria-current]').focus()
  if (was !== section) grid.scrollTop = 0
}
// Shows the section a setting is in. Also for a value the form refuses on Save: the browser can't point at a field that isn't on show.
function showSetting(el) {
  let h = el.closest('#settingsForm .grid > *')
  while (h && h.tagName !== 'H3') h = h.previousElementSibling
  if (h) showSection(h.textContent)
}
$('#settingsForm').addEventListener('invalid', e => showSetting(e.target), true)

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
  fillCamProps() // not waited for: a camera may take a moment to say what it offers
  fillTemplates()
  fill(form.filter, Object.entries(FILTERS).map(([k, [label]]) => [k, label]))
  fill(form.lang, Object.entries(LANGS))
  fill(form.printer, [['', 'Ask each time (print dialog)'], ...(await booth.listPrinters()).map(p => [p.name, p.displayName || p.name])])
  for (const el of form.elements) if (el.name in settings) el[el.type === 'checkbox' ? 'checked' : 'value'] = settings[el.name]
  updatePreview()
  shareStatus()
  Swap.status()
  showSection()
  if (!$('#settings').open) $('#settings').showModal() // also called to refill the open dialog after switching events
}

// Sharing over the local network: what guests' phones need, and whether this computer is reachable right now.
const SHARE_HELP = "Guests scan a QR code on the booth and get their photo from this computer: nothing goes online. Their phones must be on the same Wi-Fi as it (a venue's guest Wi-Fi often keeps devices apart: your own router or this computer's hotspot always works). The links work while the app is open."
async function shareStatus() {
  const on = form.localShare.checked && settings.localShare, base = on && await booth.shareLocal() // not before it's saved: nothing listens yet
  $('#shareStatus').textContent = SHARE_HELP + (!on ? '' : base ? ` Right now phones reach the booth at ${new URL(base).host}.` : " This computer isn't on a network right now: guests see the Share button once it is.")
}
form.localShare.onchange = shareStatus

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
// The controlled camera's own settings. They live in the camera, not in the event: a change goes to the camera at
// once, without Save, and the list is read again, since one setting decides what the others offer.
const CAM_PROPS = { mode: 'Exposure mode', iso: 'ISO', isoAuto: 'Auto ISO', shutter: 'Shutter speed', aperture: 'Aperture', ev: 'Brightness (+/−)', wb: 'White balance', flash: 'Flash', flashEv: 'Flash strength', preview: 'Live view' }
const FLASH_NOTE = {
  ready: 'Flash: ready. ', charging: 'Flash: charging. ',
  none: 'No flash found on the camera. Studio flashes on a trigger still fire: use M (manual) for those. ',
}
let camProps = null
async function fillCamProps(note) {
  camProps = await Camera.props()
  const has = !!camProps?.props.length
  $('#camPropsLabel').hidden = $('#camProps').hidden = !has
  if (!has) return
  $('#camPropList').replaceChildren(...camProps.props.flatMap(p => {
    const select = document.createElement('select')
    fill(select, p.options.map((o, i) => [i, o]))
    Object.assign(select, { value: p.value, disabled: !p.writable, ariaLabel: CAM_PROPS[p.key] || p.key, title: p.writable ? '' : 'The camera decides this: its mode dial or exposure mode' })
    select.dataset.prop = p.key
    select.onchange = async () => {
      const failed = await Camera.setProp(p.key, select.selectedIndex).then(() => '', e => `${CAM_PROPS[p.key]}: ${e.message}`)
      await sleep(400)
      fillCamProps(failed || undefined)
    }
    return [Object.assign(document.createElement('span'), { textContent: CAM_PROPS[p.key] || p.key }), select]
  }))
  $('#camPropsNote').textContent = note ?? `${FLASH_NOTE[camProps.flash] || ''}These change on the camera straight away. Live view doesn't show a flash: judge it from a test shot.`
}
const camProp = key => camProps?.props.find(p => p.key === key)
const camBusy = on => { for (const b of [$('#camAuto'), $('#camMatch'), $('#testShot')]) b.disabled = on }

// Auto: the camera works out the exposure for every photo itself (program auto, auto ISO and white balance, no
// compensation), with its flash on if it has one. What its dial decides is left alone, and named.
$('#camAuto').onclick = async () => {
  const kept = []
  // Sets key to the first of the wanted values the camera offers.
  const pick = async (key, ...wanted) => {
    const p = camProp(key), i = p && wanted.map(w => p.options.findIndex(o => w.test(o))).find(i => i >= 0)
    if (!p || i === undefined || i === p.value) return
    if (!p.writable || !(await Camera.setProp(key, i).then(() => true, () => false))) kept.push(key === 'iso' ? 'ISO' : CAM_PROPS[key].toLowerCase())
  }
  camBusy(true)
  try {
    if (!/^(Auto|P )/.test(camProp('mode')?.options[camProp('mode').value] || '')) await pick('mode', /^P /, /^Auto$/)
    await sleep(500)
    camProps = (await Camera.props()) || camProps // the mode decides what the rest offer
    await pick('iso', /^Auto$/)
    await pick('isoAuto', /^On$/)
    await pick('ev', /^0$/)
    await pick('wb', /^Auto$/)
    await pick('flashEv', /^0$/)
    if (['ready', 'charging'].includes(camProps?.flash)) await pick('flash', /fill/, /^Auto$/, /^On/)
    await sleep(500)
    await fillCamProps(kept.length ? `Auto is set, except the ${kept.join(', the ')}: the camera decides ${kept.length > 1 ? 'those' : 'that'} itself (turn its mode dial to P or Auto).`
      : `${FLASH_NOTE[camProps?.flash] || ''}The camera now works out the exposure itself for every photo. Take a test shot to see it.`)
  } finally {
    camBusy(false)
  }
}

// Exposure from the scene: test shots, each measured (Enhance.exposure) and answered with a change on the camera, until
// one comes out right. With the camera in manual and a fixed ISO (the way to shoot with studio flashes) the ISO moves;
// otherwise the exposure compensation does. Shutter and aperture stay as the photographer set them.
$('#camMatch').onclick = async () => {
  camBusy(true)
  let note = ''
  try {
    for (let shot = 1; shot <= 4 && !note; shot++) {
      const c = await Camera.photo()
      $('#testShotImg').src = c.toDataURL('image/jpeg', 0.8)
      $('#testShotImg').hidden = false
      const small = canvas(320, Math.round(320 * c.height / c.width)), x = small.getContext('2d')
      x.drawImage(c, 0, 0, small.width, small.height)
      const stops = Enhance.exposure(x.getImageData(0, 0, small.width, small.height)), what = stops > 0 ? 'too dark' : 'too bright'
      if (Math.abs(stops) < 0.3) { note = `The exposure looks right (${shot} test shot${shot > 1 ? 's' : ''}).`; break }
      camProps = (await Camera.props()) || camProps
      const mode = camProp('mode'), iso = camProp('iso')
      const manual = /^M/.test(mode?.options[mode.value] || '') && !/^Auto/.test(iso?.options[iso.value] || 'Auto')
      const p = manual ? iso : camProp('ev'), name = manual ? 'ISO' : 'exposure compensation'
      if (!p?.writable) { note = `The test shot is ${what}, and the camera doesn't let the booth change its ${name}: change it on the camera.`; break }
      const next = Enhance.nearest(p.options, p.value, stops, manual)
      if (next === p.value) { note = `The test shot is still ${what}, and the ${name} is as far as it goes (${p.options[next]}). ${stops > 0 ? 'Add light, open the aperture or slow the shutter.' : 'Close the aperture, speed up the shutter or turn the flash down.'}`; break }
      await Camera.setProp(p.key, next)
      await sleep(600)
      if (shot === 4) note = `Still ${what} after 4 test shots; the ${name} is now ${p.options[next]}. Take a test shot to check.`
    }
  } catch (e) {
    note = `That didn't work: ${e.message}`
  } finally {
    camBusy(false)
  }
  fillCamProps(note)
}

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
$('#moreLink').onclick = () => booth.openMore()

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
  const more = await Setup.firstRun()
  await applySettings()
  show('attract')
  if (more) await openSettings()
})
