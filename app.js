/* global booth, Layout */
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
let settings, templates = [], template, assets = {}, stream, current, reviewTimer

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
  const size = { width: { ideal: 3840 }, height: { ideal: 2160 } }
  stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, deviceId: settings.cameraId ? { exact: settings.cameraId } : undefined } })
    .catch(() => navigator.mediaDevices.getUserMedia({ video: size }))
    .catch(() => null)
  video.srcObject = stream
  video.classList.toggle('mirror', settings.mirror)
  if (!stream) toast('No camera found. Hold the top-right corner to open settings.')
}

async function loadTemplates() {
  templates = (await booth.listTemplates()).flatMap(t => {
    try { return [{ id: t.id, ...Layout.parse(t.xml) }] } catch { return [] }
  })
  template = templates.find(t => t.id === settings.templateId) || templates[0]
  assets = {}
  await Promise.all((template?.elements || []).filter(e => e.type === 'Image').map(async e => {
    const url = await booth.templateAsset(template.id, e.src)
    if (url) assets[e.src] = await loadImage(url).catch(() => null)
  }))
}

async function applySettings() {
  $('#eventTitle').textContent = settings.eventName
  await loadTemplates()
  await startCamera()
}

function grab() {
  const c = canvas(video.videoWidth, video.videoHeight), ctx = c.getContext('2d')
  if (settings.mirror) ctx.setTransform(-1, 0, 0, 1, c.width, 0)
  ctx.drawImage(video, 0, 0)
  return c
}

function compose(shots, t = template) {
  const c = canvas(t.width, t.height), ctx = c.getContext('2d')
  const vars = { event: settings.eventName, date: new Date().toLocaleDateString() }
  ctx.fillStyle = t.background
  ctx.fillRect(0, 0, c.width, c.height)
  for (const e of t.elements) {
    ctx.save()
    ctx.globalAlpha = e.opacity
    ctx.translate(e.x + e.w / 2, e.y + e.h / 2)
    ctx.rotate(e.rotation * Math.PI / 180)
    ctx.translate(-e.w / 2, -e.h / 2)
    if (e.shadow) {
      const a = e.shadow.angle * Math.PI / 180
      Object.assign(ctx, { shadowColor: e.shadow.color, shadowBlur: e.shadow.blur, shadowOffsetX: e.shadow.depth * Math.cos(a), shadowOffsetY: -e.shadow.depth * Math.sin(a) })
    }
    if (e.type === 'Photo') {
      // ponytail: photo slots always cover-crop; KeepAspect only changes how Image elements are fitted
      const s = shots[e.photo - 1]
      if (s) {
        const k = Layout.cover(s.width, s.height, e.w, e.h)
        ctx.filter = FILTERS[settings.filter]?.[1] || 'none'
        ctx.drawImage(s, k.sx, k.sy, k.sw, k.sh, 0, 0, e.w, e.h)
        ctx.filter = 'none'
      }
    } else if (e.type === 'Image') {
      const img = assets[e.src]
      if (img && e.keepAspect) { const k = Layout.contain(img.width, img.height, e.w, e.h); ctx.drawImage(img, k.dx, k.dy, k.dw, k.dh) }
      else if (img) ctx.drawImage(img, 0, 0, e.w, e.h)
    } else if (e.type === 'Text') {
      const align = ['left', 'right'].includes(e.align) ? e.align : 'center'
      const lines = Layout.fillText(e.text, vars).split('\n')
      Object.assign(ctx, { font: `${e.size}px "${e.font}", sans-serif`, fillStyle: e.textColor, textAlign: align, textBaseline: 'middle' })
      const x = { left: 0, right: e.w, center: e.w / 2 }[align]
      lines.forEach((l, i) => ctx.fillText(l, x, e.h / 2 + (i - (lines.length - 1) / 2) * e.size * 1.2))
    } else {
      ctx.beginPath()
      if (e.type === 'Ellipse') ctx.ellipse(e.w / 2, e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2)
      else ctx.rect(0, 0, e.w, e.h)
      ctx.fillStyle = e.fill
      ctx.fill()
    }
    if (e.stroke) {
      Object.assign(ctx, { shadowColor: 'transparent', lineWidth: e.stroke.width, strokeStyle: e.stroke.color })
      if (e.type === 'Ellipse') ctx.stroke()
      else ctx.strokeRect(e.stroke.width / 2, e.stroke.width / 2, e.w - e.stroke.width, e.h - e.stroke.width)
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
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))
  return booth.savePhoto(name, await blob.arrayBuffer())
}

async function saveSession({ shots, sheet }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  for (const [i, s] of shots.entries()) await save(s, `${stamp}_${i + 1}.jpg`)
  return { stamp, file: await save(sheet, `${stamp}.jpg`) }
}
const keep = () => (current.saved ??= saveSession(current))

async function startSession() {
  if (screen() !== 'attract') return
  if (!stream || !template) return toast(!stream ? 'No camera found.' : 'No layout available.')
  if (!video.videoWidth) return toast('Camera is starting, try again in a moment.')
  clearTimeout(reviewTimer)
  show('capture')
  try {
    const shots = []
    for (let i = 1; i <= template.shots; i++) {
      $('#status').textContent = template.shots > 1 ? `Photo ${i} of ${template.shots}` : ''
      for (let n = settings.countdown; n > 0; n--) { $('#count').textContent = n; await sleep(1000) }
      $('#count').textContent = ''
      shots.push(grab())
      $('#flash').classList.remove('on'); void $('#flash').offsetWidth; $('#flash').classList.add('on')
      if (i < template.shots) await sleep(settings.betweenShots * 1000)
    }
    current = { shots, sheet: compose(shots), saved: null }
    $('#result').src = current.sheet.toDataURL('image/jpeg', 0.9)
    $('#print').disabled = false
    show('review')
    reviewTimer = setTimeout(done, settings.reviewSeconds * 1000)
    if (settings.autoPrint) printCurrent()
  } catch (e) {
    show('attract')
    toast(`Something went wrong: ${e.message}`)
  }
}

async function printCurrent() {
  $('#print').disabled = true // one print per session from the booth; reprint from the photos folder
  try {
    const { stamp, file } = await keep()
    const t = template, strip = Math.max(t.width, t.height) / Math.min(t.width, t.height) >= 2.5
    let path = file, w = t.width, h = t.height
    if (strip && settings.print2up) {
      const sheet = twoUp(current.sheet)
      path = await save(sheet, `${stamp}_print.jpg`)
      w = sheet.width; h = sheet.height
    }
    toast('Printing…')
    const err = await booth.print(path, w / t.dpi, h / t.dpi)
    if (err) toast(`Print failed: ${err}`)
  } catch (e) {
    toast(`Print failed: ${e.message}`)
  }
}

async function done() {
  clearTimeout(reviewTimer)
  if (screen() !== 'review') return
  try { await keep() } catch (e) { toast(`Could not save photos: ${e.message}`) }
  show('attract')
}

async function openSettings() {
  if ($('#settings').open) return
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
  fill(form.cameraId, cams.map((d, i) => [d.deviceId, d.label || `Camera ${i + 1}`]))
  fillTemplates()
  fill(form.filter, Object.entries(FILTERS).map(([k, [label]]) => [k, label]))
  fill(form.printer, [['', 'Ask each time (print dialog)'], ...(await booth.listPrinters()).map(p => [p.name, p.displayName || p.name])])
  for (const el of form.elements) if (el.name in settings) el[el.type === 'checkbox' ? 'checked' : 'value'] = settings[el.name]
  $('#settings').showModal()
}
const fillTemplates = () => fill(form.templateId, templates.map(t => [t.id, `${t.name} (${t.shots} photo${t.shots > 1 ? 's' : ''})`]))

form.addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return
  const next = { ...settings }
  for (const el of form.elements) {
    if (el.name in settings) next[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value
  }
  settings = await booth.saveSettings(next)
  await applySettings()
})
$('#choose').onclick = async () => { form.outputDir.value = (await booth.chooseFolder()) || form.outputDir.value }
$('#import').onclick = async () => {
  const id = await booth.importTemplate()
  if (!id) return
  await loadTemplates()
  fillTemplates()
  if (templates.some(t => t.id === id)) form.templateId.value = id
  else toast('That template.xml could not be read.')
}
$('#openFolder').onclick = () => booth.openFolder()
$('#quit').onclick = () => booth.quit()

$('#attract').onclick = startSession
$('#retake').onclick = () => { clearTimeout(reviewTimer); show('attract'); startSession() }
$('#print').onclick = printCurrent
$('#done').onclick = done

let pressTimer
$('#corner').addEventListener('pointerdown', () => { pressTimer = setTimeout(openSettings, 1500) })
for (const ev of ['pointerup', 'pointerleave']) $('#corner').addEventListener(ev, () => clearTimeout(pressTimer))
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') return openSettings()
  if ($('#settings').open || (e.key !== ' ' && e.key !== 'Enter')) return
  e.preventDefault()
  if (screen() === 'attract') startSession()
  else if (screen() === 'review') done()
})

booth.getSettings().then(s => { settings = s; return applySettings() })
