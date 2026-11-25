/* global booth, $, settings, current, template, compose, save, printCurrent, show, screen, shoot, toast, canvas, loadImage, FILTERS, Enhance, FX, AI, Layout, qrcode, Swap */
// The review screen. Guests pick a look and auto-enhance for all photos or just one, retake a single photo,
// add stickers, draw or sign, and finish with Print or Done. Done also happens by itself after the event's idle time, shown as a shrinking bar.
const Review = (() => {
  const EMOJI = ['🎉', '🥳', '😎', '❤️', '😂', '👑', '💋', '⭐', '🔥', '🦄', '🎈', '💍', '🍾', '🌈', '👍', '🐶']
  // Props that fit every face: [emoji, name, anchor, size in outer-eye-corner distances].
  const PROPS = [['🕶️', 'sunglasses', 'eyes', 1.7], ['👓', 'glasses', 'eyes', 1.7], ['👑', 'a crown', 'head', 1.8], ['🎩', 'a top hat', 'head', 2.3]]
  // Face swaps, kept per photo: shot canvas (and its thumbnail copy) -> Map('swap:<scene>:<turn>' -> canvas). A photo's
  // edit names the one it shows in .ai (null for the photo itself).
  const aiCache = new WeakMap()
  let aiJob = 0
  // Drawing: pen colours, and widths as a share of the layout's shorter side.
  const PENS = [['#ffffff', 'White'], ['#111111', 'Black'], ['#ff4f6d', 'Red'], ['#ffd23f', 'Yellow'], ['#3d8bfd', 'Blue'], ['#2fb457', 'Green']]
  const pen = { color: PENS[0][0], width: 0.012 }
  let strokes = [], stroke = null // { color, width, pts } in layout pixels; stroke: the one a finger is drawing (.id: its pointer)
  const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
  const view = $('#result'), vctx = view.getContext('2d')
  let edits = [], selected = null, dirty = false, timer, base, stickers = [], sel = null, extra = { key: null, stickers: [], backgrounds: [], scenes: [] }, tab, renders = 0, panels = 0
  const cache = new WeakMap() // shot canvas -> Map(variant -> canvas)
  const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text })
  const img = c => Object.assign(new Image(), { src: c.toDataURL('image/jpeg', 0.8), alt: '' })

  function variant(shot, key, make) {
    let m = cache.get(shot)
    if (!m) cache.set(shot, (m = new Map()))
    if (!m.has(key)) m.set(key, make())
    return m.get(key)
  }

  // The shot with enhance, glam, background and then the look applied. Each step is cached per shot, so switching back is instant.
  async function processed(shot, { look, enhance, glam, bg, ai = null }) {
    const art = ai && aiCache.get(shot)?.get(ai) // a face swap replaces the photo; enhance and glam don't apply to it
    let c = art || shot
    if (!art && enhance) {
      c = await variant(shot, 'enhance', () => {
        const out = canvas(shot.width, shot.height), ctx = out.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(shot, 0, 0)
        ctx.putImageData(Enhance.apply(ctx.getImageData(0, 0, out.width, out.height)), 0, 0)
        return out
      })
    }
    if (!art && glam !== 'off') {
      const from = c
      c = await variant(shot, `glam|${enhance}|${glam}`, () => FX.glam(from, glam).catch(e => { console.warn('Glam failed:', e); return from }))
    }
    const backdrop = bg?.startsWith('img:') ? extra.backgrounds[+bg.slice(4)] : bg !== 'none' && bg
    if (backdrop) {
      const from = c
      const chroma = settings.greenScreen && settings.chromaTolerance
      c = await variant(shot, `bg|${enhance}|${glam}|${bg}|${ai}|${chroma}`, () => FX.background(from, backdrop, chroma).catch(e => { console.warn('Background failed:', e); return from }))
    }
    if (FILTERS[look] && look !== 'none') {
      const from = c
      c = await variant(shot, `${look}|${enhance}|${glam}|${bg}|${ai}|${settings.greenScreen && settings.chromaTolerance}`, () => {
        if (FX.ART[look]) try { return FX.ART[look][1](from) } catch (e) { console.warn('Art look failed:', e); return from }
        const out = canvas(from.width, from.height), ctx = out.getContext('2d')
        ctx.filter = FILTERS[look][1]
        ctx.drawImage(from, 0, 0)
        return out
      })
    }
    return c
  }

  // A small copy for thumbnails, so every look previews instantly.
  const small = shot => variant(shot, 'small', () => {
    const c = canvas(Math.round(shot.width * 240 / shot.height), 240)
    c.getContext('2d').drawImage(shot, 0, 0, c.width, c.height)
    return c
  })

  // Where a photo's faces are, as fractions of its size, so its slot crops around them instead of the middle.
  // A guest standing to one side, or a tall photo in a wide slot, then keeps their head.
  async function faceFocus(shot) {
    const pts = (await AI.faces(shot).catch(() => [])).flatMap(f => f.pts)
    if (!pts.length) return null
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2 / shot.width, y: (Math.min(...ys) + Math.max(...ys)) / 2 / shot.height }
  }

  // Only the newest render lands, so quick taps never leave an older result on screen.
  async function render() {
    const n = ++renders
    $('#review').classList.add('busy')
    // A face swap crops around its own faces; a photo around the guest's.
    const shots = (await Promise.all(current.shots.map((s, i) => processed(s, edits[i])))).map((c, i) => Object.assign(c, { focus: (edits[i].ai && aiCache.get(current.shots[i])?.get(edits[i].ai)?.focus) || current.focus?.[i] }))
    if (n !== renders) return
    base = compose(shots, template, { filter: 'none', qr: null })
    flatten()
    await panel()
    if (n === renders) $('#review').classList.remove('busy')
  }

  // Guests' drawings and signatures, over the stickers.
  function drawStrokes(ctx) {
    ctx.save()
    Object.assign(ctx, { lineCap: 'round', lineJoin: 'round' })
    for (const s of strokes) {
      Object.assign(ctx, { strokeStyle: s.color, lineWidth: s.width })
      ctx.beginPath()
      ctx.moveTo(s.pts[0].x, s.pts[0].y)
      for (const p of s.pts) ctx.lineTo(p.x + 0.01, p.y) // a tap is a dot
      ctx.stroke()
    }
    ctx.restore()
  }

  // current.sheet is what gets saved and printed: the layout plus its stickers and drawings.
  function flatten() {
    const c = canvas(base.width, base.height), ctx = c.getContext('2d')
    ctx.drawImage(base, 0, 0)
    for (const st of stickers) drawSticker(ctx, st)
    drawStrokes(ctx)
    current.sheet = c
    paint()
  }

  // The on-screen copy also shows the selected sticker's frame and remove button. Drags only repaint this.
  function paint() {
    if (view.width !== base.width || view.height !== base.height) Object.assign(view, { width: base.width, height: base.height })
    vctx.drawImage(base, 0, 0)
    for (const st of stickers) drawSticker(vctx, st)
    drawStrokes(vctx)
    if (sel) drawFrame(vctx, sel)
    if (selected !== null && current.shots.length > 1) {
      const s = scale()
      for (const e of slots(selected)) {
        vctx.save()
        vctx.translate(e.x + e.w / 2, e.y + e.h / 2)
        vctx.rotate(e.rotation * Math.PI / 180)
        Object.assign(vctx, { lineWidth: 8 / s, strokeStyle: '#ff4f6d' })
        vctx.setLineDash([])
        vctx.strokeRect(-e.w / 2, -e.h / 2, e.w, e.h)
        vctx.restore()
      }
    }
  }
  // Layout slots showing photo i (a layout may repeat a photo).
  const slots = i => template.elements.filter(e => e.type === 'Photo' && e.photo === i + 1)

  // Stickers: { x, y, size, rot } in layout pixels, plus { emoji } or { img, ar }. size is the longer side.
  const dims = st => ({ w: st.size * Math.min(1, st.ar || 1), h: st.size * Math.min(1, 1 / (st.ar || 1)) })
  function drawSticker(ctx, st) {
    const { w, h } = dims(st)
    ctx.save()
    ctx.translate(st.x, st.y)
    ctx.rotate(st.rot)
    if (st.img) ctx.drawImage(st.img, -w / 2, -h / 2, w, h)
    else {
      // Centered on the glyph's measured box; emoji fonts sit their glyphs off the text baseline.
      Object.assign(ctx, { font: `${st.size * 0.85}px ${EMOJI_FONT}`, textAlign: 'left', textBaseline: 'alphabetic' })
      const m = ctx.measureText(st.emoji)
      ctx.fillText(st.emoji, (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2)
    }
    ctx.restore()
  }
  // Screen pixels per layout pixel; the canvas is shown with object-fit: contain.
  const scale = () => { const r = view.getBoundingClientRect(); return Math.min(r.width / view.width, r.height / view.height) || 1 }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  function corner(st) {
    const { w, h } = dims(st), c = Math.cos(st.rot), s = Math.sin(st.rot)
    return { x: st.x + (w / 2) * c + (h / 2) * s, y: st.y + (w / 2) * s - (h / 2) * c }
  }
  function drawFrame(ctx, st) {
    const s = scale(), { w, h } = dims(st), k = corner(st), r = 28 / s, d = r * 0.4
    ctx.save()
    ctx.translate(st.x, st.y)
    ctx.rotate(st.rot)
    Object.assign(ctx, { lineWidth: 3 / s, strokeStyle: '#fff' })
    ctx.setLineDash([10 / s, 8 / s])
    ctx.strokeRect(-w / 2, -h / 2, w, h)
    ctx.restore()
    ctx.beginPath()
    ctx.arc(k.x, k.y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#ff4f6d'
    ctx.fill()
    Object.assign(ctx, { lineWidth: 4 / s, strokeStyle: '#fff' })
    ctx.beginPath()
    ctx.moveTo(k.x - d, k.y - d); ctx.lineTo(k.x + d, k.y + d); ctx.moveTo(k.x + d, k.y - d); ctx.lineTo(k.x - d, k.y + d)
    ctx.stroke()
  }
  // Is layout point p inside a box centered on (x, y), w × h, turned by rot radians?
  function inside(p, x, y, w, h, rot) {
    const dx = p.x - x, dy = p.y - y, c = Math.cos(rot), s = Math.sin(rot)
    return Math.abs(dx * c + dy * s) <= w / 2 && Math.abs(dy * c - dx * s) <= h / 2
  }
  const hit = (st, p) => { const { w, h } = dims(st); return inside(p, st.x, st.y, w, h, st.rot) }
  function sized(v) { const m = Math.min(base.width, base.height); return Math.min(Math.max(v, m * 0.05), m * 1.2) }

  function addSticker(src) {
    sel = { x: base.width / 2, y: base.height / 2, size: sized(Math.min(base.width, base.height) * 0.22), rot: 0, ...src }
    stickers.push(sel)
    dirty = true
    flatten()
  }

  // Puts a prop on every face in the layout, sized and turned to fit. Each one is then a normal sticker.
  async function addProp([emoji, , anchor, scale]) {
    const added = []
    for (const e of template.elements.filter(e => e.type === 'Photo' && current.shots[e.photo - 1])) {
      // What the slot shows: the photo, or the face swap that replaced it, cropped as render() does.
      const i = e.photo - 1, art = edits[i].ai && aiCache.get(current.shots[i])?.get(edits[i].ai), shot = art || current.shots[i]
      const focus = art?.focus || current.focus?.[i], k = Layout.cover(shot.width, shot.height, e.w, e.h, focus?.x, focus?.y)
      const f = e.w / k.sw, a = e.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a)
      // Photo pixel -> layout pixel, through the slot's cover crop and rotation.
      const map = p => {
        const x = (p.x - k.sx) * f - e.w / 2, y = (p.y - k.sy) * f - e.h / 2
        return { x: e.x + e.w / 2 + x * cos - y * sin, y: e.y + e.h / 2 + x * sin + y * cos, inside: Math.abs(x) <= e.w / 2 && Math.abs(y) <= e.h / 2 }
      }
      for (const face of await AI.faces(shot)) {
        const [l, r, top, chin] = [33, 263, 10, 152].map(i => map(face.pts[i])) // outer eye corners, forehead, chin
        if (!l.inside || !r.inside) continue // the face is cropped out of this slot
        const size = dist(l, r) * scale, rot = Math.atan2(r.y - l.y, r.x - l.x)
        if (anchor === 'eyes') added.push({ emoji, size, rot, x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 })
        else {
          const up = dist(top, chin)
          added.push({ emoji, size, rot, x: top.x + (top.x - chin.x) / up * size * 0.2, y: top.y + (top.y - chin.y) / up * size * 0.2 })
        }
      }
    }
    if (!added.length) return toast('No faces found for props. Try a sticker instead!')
    stickers.push(...added)
    sel = null
    dirty = true
    flatten()
  }

  // The event's own sticker and background images, reloaded when its folders change.
  async function loadExtra() {
    const key = `${settings.stickerDir}|${settings.backgroundDir}|${settings.swapDir}`
    if (extra.key === key) return
    const load = async kind => (await Promise.all((await booth.listImages(kind)).map(u => loadImage(u).catch(() => null)))).filter(Boolean)
    extra = { key, stickers: await load('stickerDir'), backgrounds: await load('backgroundDir'), scenes: await load('swapDir') }
  }
  // The event's default background, ready to draw (boomerangs use it too), or false for none.
  async function backdrop() {
    await loadExtra()
    const bg = settings.background
    return bg?.startsWith('img:') ? extra.backgrounds[+bg.slice(4)] || false : bg !== 'none' && bg
  }
  const backgrounds = () => [['none', 'Original'], ['blur', 'Blur'], ...Object.entries(FX.BACKDROPS).map(([k, [label]]) => [k, label]), ...extra.backgrounds.map((_, i) => [`img:${i}`, `Custom ${i + 1}`])]

  // Switches tabs right away; the tool's previews follow when ready.
  function showTab() {
    const tools = [settings.guestLooks && 'looksTool', settings.guestSwap && settings.swapReady && extra.scenes.length && 'swapTool', settings.guestBackgrounds && 'bgTool', settings.guestStickers && 'stickersTool', settings.guestDraw && 'drawTool'].filter(Boolean)
    if (!tools.includes(tab)) tab = tools[0]
    $('#toolTabs').hidden = tools.length < 2
    for (const b of $('#toolTabs').children) {
      b.hidden = !tools.includes(b.dataset.tab)
      b.ariaSelected = String(b.dataset.tab === tab)
      b.onclick = () => {
        tab = b.dataset.tab
        if (tab === 'swapTool' && selected === null) selected = 0 // face swap works on one photo at a time
        if (tab === 'drawTool') sel = null // a finger on the photos draws now
        panel()
        paint()
      }
    }
    for (const id of ['looksTool', 'swapTool', 'bgTool', 'stickersTool', 'drawTool']) $('#' + id).hidden = id !== tab
  }

  async function panel() {
    // One tool shows at a time; the tab bar appears once there are two. Only the open tool's previews are made.
    showTab()
    const n = ++panels, target = selected ?? 0, preview = e => processed(small(current.shots[target]), { ...edits[target], ...e })
    const thumbs = await Promise.all(current.shots.map((s, i) => processed(small(s), edits[i])))
    const previews = await Promise.all(tab === 'looksTool' ? Object.keys(FILTERS).map(look => preview({ look })) : tab === 'bgTool' ? backgrounds().map(([bg]) => preview({ bg })) : [])
    if (n !== panels) return

    // Photos: tap one to edit or retake just that one. A single-photo layout only needs the Retake button.
    const many = current.shots.length > 1
    $('#photosTool').hidden = !many && !settings.guestRetake
    $('#thumbs').hidden = !many
    $('#thumbs').style.setProperty('--n', Math.min(4, current.shots.length))
    $('#thumbs').replaceChildren(...current.shots.map((shot, i) => {
      const box = el('div', 'thumb' + (selected === i ? ' on' : ''))
      const pick = el('button', 'pick')
      pick.append(img(thumbs[i]))
      pick.ariaLabel = `Photo ${i + 1}`
      pick.ariaPressed = String(selected === i)
      pick.onclick = () => select(selected === i ? null : i)
      box.append(pick)
      return box
    }))
    $('#photosHint').hidden = !many || selected !== null
    $('#photosHint').textContent = settings.guestRetake ? 'Tap a photo to edit or retake just that one.' : 'Tap a photo to edit just that one.'
    $('#retakeBtn').hidden = !settings.guestRetake || (many && selected === null)
    $('#retakeBtn').textContent = many ? `↻ Retake photo ${selected + 1}` : '↻ Retake'
    $('#retakeBtn').onclick = () => retake(selected ?? 0)
    $('#allPhotos').hidden = selected === null || !many

    const all = f => (selected === null ? edits.every(f) : f(edits[selected]))
    $('#looksTitle').textContent = selected !== null ? `Look for photo ${selected + 1}` : many ? 'Look for all photos' : 'Look'
    const options = (list, field) => list.map(([key, label], k) => {
      const on = all(e => e[field] === key), b = el('button', 'look' + (on ? ' on' : ''))
      b.append(img(previews[k]), label)
      b.ariaPressed = String(on)
      b.onclick = () => change(e => { e[field] = key })
      return b
    })
    if (tab === 'looksTool') $('#looks').replaceChildren(...options(Object.keys(FILTERS).map(k => [k, k === 'none' ? 'Original' : FILTERS[k][0]]), 'look'))
    if (tab === 'bgTool') $('#bgs').replaceChildren(...options(backgrounds(), 'bg'))
    $('#swapTitle').textContent = many ? `Face swap for photo ${target + 1}` : 'Face swap'
    const swapped = edits[target].ai?.startsWith('swap:') && aiCache.get(current.shots[target])?.get(edits[target].ai)
    $('#swapTurn').hidden = !(swapped?.people > 1)
    if (tab === 'swapTool') $('#scenes').replaceChildren(...[null, ...extra.scenes].map((scene, k) => {
      const cur = edits[target].ai || 'none', on = k ? cur.startsWith(`swap:${k - 1}:`) : cur === 'none', b = el('button', 'look' + (on ? ' on' : ''))
      b.append(scene ? Object.assign(new Image(), { src: scene.src, alt: '' }) : el('span', 'ai-icon', '📷'), k ? `Scene ${k}` : 'Original')
      b.ariaPressed = String(on)
      b.onclick = () => (k ? swapInto(k - 1) : magic('none'))
      return b
    }))
    $('#bgTitle').textContent = selected !== null ? `Background for photo ${selected + 1}` : many ? 'Background for all photos' : 'Background'
    $('#props').replaceChildren(...PROPS.map(p => {
      const b = el('button', 'sticker', p[0])
      b.ariaLabel = `Put ${p[1]} on every face`
      b.onclick = () => addProp(p)
      return b
    }))
    $('#stickers').replaceChildren(...[...extra.stickers.map(img => ({ img, ar: img.width / img.height })), ...EMOJI.map(emoji => ({ emoji }))].map(src => {
      const b = el('button', 'sticker', src.emoji || '')
      if (src.img) b.append(Object.assign(new Image(), { src: src.img.src, alt: '' }))
      b.ariaLabel = src.emoji ? `Add ${src.emoji} sticker` : 'Add sticker'
      b.onclick = () => addSticker(src)
      return b
    }))

    $('#penColors').replaceChildren(...PENS.map(([color, name]) => {
      const b = el('button', 'sticker pen' + (pen.color === color ? ' on' : ''))
      b.style.background = color
      b.ariaLabel = `${name} pen`
      b.ariaPressed = String(pen.color === color)
      b.onclick = () => { pen.color = color; panel() }
      return b
    }))
    for (const b of $('#penSize').querySelectorAll('button')) {
      b.ariaPressed = String(pen.width === +b.dataset.pen)
      b.onclick = () => { pen.width = +b.dataset.pen; panel() }
    }
    for (const b of $('#glamSeg').querySelectorAll('button')) {
      b.ariaPressed = String(all(e => e.glam === b.dataset.glam))
      b.onclick = () => change(e => { e.glam = b.dataset.glam })
    }
    const enhanced = all(e => e.enhance)
    $('#enhanceBtn').ariaPressed = String(enhanced)
    $('#enhanceBtn').textContent = `✨ Auto-enhance: ${enhanced ? 'on' : 'off'}`
    $('#enhanceBtn').onclick = () => change(e => { e.enhance = !enhanced })
  }

  // Shows the selected photo as it is ('none') or as a face swap it already has ('swap:<scene>:<turn>').
  function magic(key) {
    edits[selected ?? 0].ai = key === 'none' ? null : key
    dirty = true
    return render()
  }

  // Face swap into scene k, on the booth itself: the result is kept per photo, so going back is instant.
  // turn: how many places the guests have moved along the scene's faces (Swap places).
  async function swapInto(k, turn = 0) {
    const i = selected ?? 0, shot = current.shots[i], key = `swap:${k}:${turn}`
    if (aiCache.get(shot)?.has(key)) return magic(key)
    const job = ++aiJob
    busy('🎭 Putting you in the picture…')
    const source = await processed(shot, { ...edits[i], look: 'none', glam: 'off', bg: 'none', ai: null })
    const art = await Swap.into(extra.scenes[k], source, turn).catch(e => { console.warn('Face swap failed:', e); return undefined })
    if (art) {
      art.focus = await faceFocus(art)
      aiCache.set(shot, (aiCache.get(shot) || new Map()).set(key, art))
      const c = canvas(Math.round(art.width * 240 / art.height), 240)
      c.getContext('2d').drawImage(art, 0, 0, c.width, c.height)
      aiCache.set(small(shot), (aiCache.get(small(shot)) || new Map()).set(key, c))
    }
    if (job !== aiJob || screen() !== 'review') return
    busy(null)
    if (art === null) return toast("We couldn't see a face to swap. Try another photo, or a retake!")
    if (!art) return toast("Face swap didn't work this time. Try another scene.")
    edits[i].ai = key
    dirty = true
    await render()
  }

  $('#swapTurn').onclick = () => {
    const i = selected ?? 0, [, k, turn] = edits[i].ai.split(':')
    swapInto(+k, (+turn + 1) % aiCache.get(current.shots[i]).get(edits[i].ai).people)
  }

  // Share: a QR code to this session's photo. In this app it leads to this computer (local-share.js), so phones on
  // the booth's network get the photo without anything going online. The photo is handed over when the guest
  // finishes (see finish()); its page waits for it if the guest scans before that.
  function share(open) {
    $('#shareSheet').hidden = !open
    if (!open) return
    const q = qrcode(0, 'M')
    q.addData(current.share + current.key)
    q.make()
    $('#qr').innerHTML = q.createSvgTag({ cellSize: 8, margin: 0, scalable: true })
  }
  const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
  $('#shareBtn').onclick = () => share(true)
  $('#shareClose').onclick = () => share(false)

  function busy(text) {
    $('#aiBusy').hidden = !text
    $('#aiBusyText').textContent = text || ''
    const bar = $('#aiBusy .ai-bar i')
    bar.style.animation = 'none'
    void bar.offsetWidth
    bar.style.animation = ''
    if (text) clearTimeout(timer)
    else poke()
  }

  function select(i) {
    selected = i
    panel()
    paint()
  }

  // Applies to the selected photo, or to every photo when none is selected.
  function change(fn) {
    edits.forEach((e, i) => { if (selected === null || selected === i) fn(e) })
    dirty = true
    render()
  }

  // Restarts the idle countdown; any touch on the review screen calls it.
  function poke() {
    clearTimeout(timer)
    timer = setTimeout(() => finish(), settings.reviewSeconds * 1000)
    const bar = $('#idle')
    bar.style.animation = 'none'
    void bar.offsetWidth
    bar.style.animation = `idle ${settings.reviewSeconds}s linear forwards`
  }

  // Saves run one after another on current.saved, so the files on disk always end up matching the screen.
  function chain(fn) {
    current.saved = current.saved.then(fn)
    current.saved.catch(e => toast(`Could not save photos: ${e.message}`))
  }

  async function retake(i) {
    aiJob++ // a result still on its way is kept, but no longer shown
    busy(null)
    share(false)
    clearTimeout(timer)
    show('capture')
    $('#status').textContent = current.shots.length > 1 ? `Photo ${i + 1}, take two` : ''
    try {
      const shot = await shoot()
      current.shots[i] = shot
      current.focus[i] = await faceFocus(shot)
      chain(async r => { await save(shot, `${r.stamp}_${i + 1}.jpg`); return r })
      dirty = true
      await render()
    } catch (e) {
      toast(`Something went wrong: ${e.message}`)
    }
    show('review')
    poke()
  }

  async function open() {
    const look = FILTERS[settings.filter] ? settings.filter : 'none'
    share(false)
    current.key = newKey()
    current.share = await booth.shareBase().catch(() => '') // asked per session: the booth may have joined a network since
    $('#shareBtn').hidden = !current.share
    await loadExtra()
    current.focus = await Promise.all(current.shots.map(faceFocus))
    edits = current.shots.map(() => ({ look, enhance: settings.enhance, glam: settings.glam, bg: settings.background, ai: null }))
    aiJob++
    busy(null)
    tab = null
    stickers = []
    strokes = []
    stroke = null
    sel = null
    selected = null
    dirty = false
    await render()
    $('#print').hidden = settings.autoPrint // Done prints by itself then
    $('#print').disabled = false
    show('review')
    poke()
  }

  function finish(print = settings.autoPrint) {
    if (screen() !== 'review') return
    clearTimeout(timer)
    if (dirty) {
      dirty = false
      const sheet = current.sheet
      chain(async r => ({ ...r, file: await save(sheet, `${r.stamp}.jpg`) }))
    }
    const { key, share: sharing } = current // read now: the next guest may have started by the time the saves are done
    if (sharing) chain(async r => { await booth.sharePhoto({ key, file: r.file }); return r })
    share(false)
    if (print) printCurrent()
    Swap.reset()
    show('attract')
  }

  // Sticker gestures: tap to select, drag to move, pinch to resize and turn, tap the red ✕ to remove.
  // A mouse wheel resizes (Shift turns), for operators testing without a touchscreen.
  const pts = new Map()
  let g = null, moved = false, frame = 0, wheelEnd
  const toSheet = e => {
    const r = view.getBoundingClientRect(), s = scale()
    return { x: (e.clientX - r.left - (r.width - view.width * s) / 2) / s, y: (e.clientY - r.top - (r.height - view.height * s) / 2) / s }
  }
  // (Re)starts a gesture from the fingers now down, so lifting one finger of a pinch carries on as a drag.
  const begin = () => { g = sel && { p: [...pts.values()], x: sel.x, y: sel.y, size: sel.size, rot: sel.rot } }
  const repaint = () => { frame ||= requestAnimationFrame(() => { frame = 0; paint() }) }
  view.addEventListener('pointerdown', e => {
    view.setPointerCapture(e.pointerId)
    const p = toSheet(e)
    pts.set(e.pointerId, p)
    if (tab === 'drawTool') { // one finger draws; others are ignored until it lifts
      if (!stroke) strokes.push((stroke = { id: e.pointerId, color: pen.color, width: pen.width * Math.min(base.width, base.height), pts: [p] }))
      return repaint()
    }
    if (pts.size === 1) {
      if (sel && dist(p, corner(sel)) <= 36 / scale()) {
        stickers.splice(stickers.indexOf(sel), 1)
        sel = null
        pts.clear()
        dirty = true
        return flatten()
      }
      // A tap off the stickers first just drops the sticker selection; after that, tapping a photo selects it.
      const had = sel
      sel = stickers.findLast(st => hit(st, p)) || null
      const slot = !sel && !had && current.shots.length > 1 && template.elements.findLast(e => e.type === 'Photo' && inside(p, e.x + e.w / 2, e.y + e.h / 2, e.w, e.h, e.rotation * Math.PI / 180))
      if (slot) select(selected === slot.photo - 1 ? null : slot.photo - 1)
      else paint()
    }
    begin()
  })
  view.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return
    pts.set(e.pointerId, toSheet(e))
    if (stroke?.id === e.pointerId) { stroke.pts.push(pts.get(e.pointerId)); return repaint() }
    if (!g) return
    const p = [...pts.values()]
    if (p.length === 1) {
      sel.x = g.x + p[0].x - g.p[0].x
      sel.y = g.y + p[0].y - g.p[0].y
    } else {
      const [a, b] = p, [a0, b0] = g.p
      sel.size = sized(g.size * dist(a, b) / dist(a0, b0))
      sel.rot = g.rot + Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x)
      sel.x = g.x + (a.x + b.x - a0.x - b0.x) / 2
      sel.y = g.y + (a.y + b.y - a0.y - b0.y) / 2
    }
    moved = true
    repaint()
  })
  const end = e => {
    if (!pts.delete(e.pointerId)) return
    if (stroke?.id === e.pointerId) { stroke = null; dirty = true; return flatten() }
    if (moved) { dirty = true; flatten() }
    moved = false
    begin()
  }
  view.addEventListener('pointerup', end)
  view.addEventListener('pointercancel', end)
  view.addEventListener('wheel', e => {
    if (!sel) return
    e.preventDefault()
    if (e.shiftKey) sel.rot += e.deltaY * 0.005
    else sel.size = sized(sel.size * Math.exp(-e.deltaY * 0.002))
    repaint()
    clearTimeout(wheelEnd)
    wheelEnd = setTimeout(() => { dirty = true; flatten() }, 200)
  }, { passive: false })

  $('#drawUndo').onclick = () => { strokes.pop(); dirty = true; flatten() }
  $('#drawClear').onclick = () => { strokes = []; dirty = true; flatten() }
  $('#aiSkip').onclick = () => { aiJob++; busy(null) }
  $('#print').onclick = () => finish(true)
  $('#done').onclick = () => finish()
  $('#allPhotos').onclick = () => select(null)
  // Any touch or key while reviewing restarts the countdown (the share sheet sits outside #review, so listen on the page).
  document.addEventListener('pointerdown', () => { if (screen() === 'review') poke() })
  document.addEventListener('keydown', () => { if (screen() === 'review') poke() })

  return { open, finish, share, newKey, backdrop }
})()
