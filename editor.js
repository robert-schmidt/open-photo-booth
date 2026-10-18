/* global booth, Layout, $, fill, templates, assets, settings, compose, placeholderShots, loadTemplates, loadImage, toast, show, screen */
// Layout editor: create, move, resize and style elements, then save as template.xml in the user's templates folder.
const Editor = (() => {
  const SIZES = [['2×6 strip', 600, 1800], ['4×6 landscape', 1800, 1200], ['4×6 portrait', 1200, 1800], ['5×7 landscape', 2100, 1500],
    ['5×7 portrait', 1500, 2100], ['Square 4×4', 1200, 1200], ['6×8 portrait', 1800, 2400]]
  const COMMON = [['name', 'Name', 'text'], ['x', 'X'], ['y', 'Y'], ['w', 'Width'], ['h', 'Height'], ['rotation', 'Rotation °'],
    ['opacity', 'Opacity %'], ['strokeWidth', 'Border width'], ['strokeColor', 'Border color', 'color'], ['shadow', 'Shadow', 'checkbox']]
  const SHADOW = [['shadowColor', 'Shadow color', 'color'], ['shadowDepth', 'Shadow distance'], ['shadowBlur', 'Shadow blur'], ['shadowAngle', 'Shadow angle °']]
  const FIELDS = {
    Photo: [['photo', 'Photo number']],
    Image: [['src', 'Image file', 'image'], ['keepAspect', 'Keep proportions', 'checkbox']],
    Text: [['text', 'Text', 'textarea'], ['font', 'Font', 'font'], ['size', 'Font size'], ['textColor', 'Text color', 'color'], ['align', 'Alignment', 'align']],
    Rectangle: [['fill', 'Fill', 'color']],
    Ellipse: [['fill', 'Fill', 'color']],
  }
  const LAYOUT_FIELDS = [['name', 'Layout name', 'text'], ['size', 'Paper size', 'size'], ['width', 'Width (px)'], ['height', 'Height (px)'],
    ['dpi', 'Resolution (DPI)'], ['background', 'Background', 'color']]
  const HANDLE = 12 // resize handle size in screen pixels
  const stage = $('#edCanvas'), props = $('#edProps'), list = $('#edList')
  let t, sourceId, sel = -1, images = {}, files = {}, history = [], hpos = 0, savedJson = '', drag = null, scale = 1, raf = 0

  const snapshot = () => JSON.stringify(t)
  const dirty = () => snapshot() !== savedJson
  const discardOk = async () => !dirty() || booth.confirm('Discard unsaved changes to this layout?')
  const selected = () => t.elements[sel]

  function reset(model, id) {
    t = model
    sourceId = id
    sel = -1
    files = {}
    history = [snapshot()]
    hpos = 0
    savedJson = id ? history[0] : ''
    list.value = id || ''
    renderProps()
    draw()
  }

  function load(id) {
    const src = templates.find(x => x.id === id) || templates[0]
    images = { ...(assets[src.id] || {}) }
    reset(structuredClone({ name: src.name, width: src.width, height: src.height, dpi: src.dpi, background: src.background, elements: src.elements }), src.id)
  }

  function refreshList() {
    fill(list, templates.map(x => [x.id, x.builtin ? `${x.name} (built-in)` : x.name]))
    list.value = sourceId || ''
  }

  function open(id) {
    fill($('#edNewSize'), SIZES.map(([label], i) => [i, label]))
    $('#edNewSize').value = 1
    show('editor')
    sourceId = id
    refreshList()
    load(id)
  }

  function commit() {
    const s = snapshot()
    if (s !== history[hpos]) {
      history = history.slice(0, hpos + 1)
      history.push(s)
      hpos++
    }
    draw()
  }

  function undo(step) {
    const n = hpos + step
    if (n < 0 || n >= history.length) return
    hpos = n
    t = JSON.parse(history[n])
    sel = Math.min(sel, t.elements.length - 1)
    renderProps()
    draw()
  }

  // Drawing
  const draw = () => { raf ||= requestAnimationFrame(paint) }
  function paint() {
    raf = 0
    const box = stage.parentElement.getBoundingClientRect(), dpr = devicePixelRatio
    scale = Math.min((box.width - 48) / t.width, (box.height - 48) / t.height)
    Object.assign(stage.style, { width: `${t.width * scale}px`, height: `${t.height * scale}px` })
    stage.width = Math.round(t.width * scale * dpr)
    stage.height = Math.round(t.height * scale * dpr)
    const ctx = stage.getContext('2d')
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)
    ctx.drawImage(compose(placeholderShots(Layout.shots(t)), t, { filter: 'none', images }), 0, 0)
    ctx.lineWidth = 1.5 / scale
    for (const e of t.elements) {
      if (e.type !== 'Image' || images[e.src]) continue
      ctx.setLineDash([8 / scale, 6 / scale])
      ctx.strokeStyle = '#888'
      ctx.strokeRect(e.x, e.y, e.w, e.h)
    }
    // ponytail: selection and hit-testing use the unrotated box, which is close enough for small rotations
    const e = selected()
    if (!e) return
    const hs = HANDLE / scale
    Object.assign(ctx, { strokeStyle: '#ff4f6d', fillStyle: '#ff4f6d', lineWidth: 2 / scale })
    ctx.setLineDash([6 / scale, 4 / scale])
    ctx.strokeRect(e.x, e.y, e.w, e.h)
    ctx.setLineDash([])
    ctx.fillRect(e.x + e.w - hs / 2, e.y + e.h - hs / 2, hs, hs)
  }

  // Pointer interaction
  const at = ev => { const r = stage.getBoundingClientRect(); return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale } }
  const hit = p => t.elements.findLastIndex(e => p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h)
  const onHandle = p => { const e = selected(), hs = HANDLE / scale; return e && Math.abs(p.x - e.x - e.w) <= hs && Math.abs(p.y - e.y - e.h) <= hs }

  stage.addEventListener('pointerdown', ev => {
    const p = at(ev)
    if (onHandle(p)) drag = { mode: 'resize' }
    else {
      sel = hit(p)
      drag = sel >= 0 ? { mode: 'move' } : null
      renderProps()
    }
    if (drag) {
      const { x, y, w, h } = selected()
      Object.assign(drag, { p, x, y, w, h })
      stage.setPointerCapture(ev.pointerId)
    }
    draw()
  })
  stage.addEventListener('pointermove', ev => {
    const p = at(ev)
    if (!drag) { stage.style.cursor = onHandle(p) ? 'nwse-resize' : hit(p) >= 0 ? 'move' : 'default'; return }
    const e = selected(), dx = Math.round(p.x - drag.p.x), dy = Math.round(p.y - drag.p.y)
    if (drag.mode === 'move') Object.assign(e, { x: drag.x + dx, y: drag.y + dy })
    else {
      e.w = Math.max(10, drag.w + dx)
      e.h = ev.shiftKey ? Math.round(e.w * drag.h / drag.w) : Math.max(10, drag.h + dy)
    }
    syncProps()
    draw()
  })
  stage.addEventListener('pointerup', () => { if (drag) { drag = null; commit() } })

  // Properties panel
  function renderProps() {
    const e = selected()
    const fields = e ? [...FIELDS[e.type], ...COMMON, ...(e.shadow ? SHADOW : [])] : LAYOUT_FIELDS
    $('#edTitle').textContent = e ? `${e.type} · ${e.name}` : 'Layout'
    props.replaceChildren(...fields.map(([key, label, kind = 'number']) => field(e || t, key, label, kind)))
    $('#edElementActions').hidden = !e
  }

  function syncProps() {
    for (const k of ['x', 'y', 'w', 'h']) {
      const input = props.querySelector(`[data-key="${k}"]`)
      if (input) input.value = selected()[k]
    }
  }

  function field(obj, key, label, kind) {
    const wrap = document.createElement('label')
    const set = (v, rerender) => { obj[key] = v; draw(); if (rerender) { commit(); renderProps() } }
    let input
    if (kind === 'color') {
      // <input type=color> has no alpha, so a slider sets the AA part of #AARRGGBB.
      input = document.createElement('span')
      input.className = 'color'
      const picker = Object.assign(document.createElement('input'), { type: 'color', value: '#' + obj[key].slice(3) })
      const alpha = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 255, value: parseInt(obj[key].slice(1, 3), 16), title: 'Opacity' })
      const update = () => set('#' + Number(alpha.value).toString(16).padStart(2, '0').toUpperCase() + picker.value.slice(1).toUpperCase())
      picker.oninput = alpha.oninput = update
      picker.onchange = alpha.onchange = commit
      input.append(picker, alpha)
    } else if (kind === 'image') {
      input = Object.assign(document.createElement('button'), { type: 'button', textContent: obj.src || 'Choose image…' })
      input.onclick = () => chooseImage(obj)
    } else if (kind === 'size') {
      input = document.createElement('select')
      fill(input, [['', 'Custom'], ...SIZES.map(([l, w, h], i) => [i, `${l} (${w}×${h})`])])
      input.value = SIZES.findIndex(([, w, h]) => w === t.width && h === t.height)
      if (input.value === '-1') input.value = ''
      input.onchange = () => { const s = SIZES[input.value]; if (s) { t.width = s[1]; t.height = s[2]; commit(); renderProps() } }
    } else if (kind === 'align') {
      input = document.createElement('select')
      fill(input, [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])
      input.value = obj[key]
      input.onchange = () => set(input.value, true)
    } else if (kind === 'checkbox') {
      input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: obj[key] })
      input.onchange = () => set(input.checked, true)
    } else {
      input = document.createElement(kind === 'textarea' ? 'textarea' : 'input')
      if (kind === 'textarea') input.rows = 3
      else input.type = kind === 'font' ? 'text' : kind
      if (kind === 'font') input.setAttribute('list', 'edFonts')
      input.value = obj[key]
      input.oninput = () => set(kind === 'number' ? Number(input.value) || 0 : input.value)
      input.onchange = () => { commit(); if (key === 'name' && obj !== t) $('#edTitle').textContent = `${obj.type} · ${obj.name}` }
    }
    input.dataset.key = key
    wrap.append(Object.assign(document.createElement('span'), { textContent: label }), input)
    if (kind === 'textarea') wrap.append(Object.assign(document.createElement('small'), { textContent: 'Placeholders: {event}, {date}' }))
    return wrap
  }

  async function chooseImage(e) {
    const picked = await booth.pickImage()
    if (!picked) return
    images[picked.name] = await loadImage(picked.dataUrl)
    files[picked.name] = picked.path
    e.src = picked.name
    commit()
    renderProps()
  }

  // Actions
  function moveTo(to) {
    to = Math.max(0, Math.min(t.elements.length - 1, to))
    const [e] = t.elements.splice(sel, 1)
    t.elements.splice(to, 0, e)
    sel = to
  }
  const act = {
    duplicate() { const e = structuredClone(selected()); Object.assign(e, { x: e.x + 20, y: e.y + 20, name: `${e.name} copy` }); t.elements.push(e); sel = t.elements.length - 1 },
    front() { moveTo(t.elements.length - 1) },
    forward() { moveTo(sel + 1) },
    backward() { moveTo(sel - 1) },
    back() { moveTo(0) },
    centerH() { selected().x = Math.round((t.width - selected().w) / 2) },
    centerV() { selected().y = Math.round((t.height - selected().h) / 2) },
    remove() { t.elements.splice(sel, 1); sel = -1 },
  }

  function add(type) {
    const w = Math.round(t.width * 0.5), h = Math.round(type === 'Text' ? t.height * 0.08 : type === 'Photo' ? w * 2 / 3 : w * 0.5)
    const n = type === 'Photo' ? Layout.shots(t) + 1 : t.elements.filter(e => e.type === type).length + 1
    const extra = {
      Photo: { PhotoNumber: n }, Text: { Text: '{event}', FontColor: '#FF222222', FontSize: Math.round(h * 0.6) },
      Rectangle: { Fill: '#FFFFFFFF' }, Ellipse: { Fill: '#FFFFFFFF' }, Image: { KeepAspect: 'True' },
    }[type]
    const e = Layout.element(type, { Name: `${type} ${n}`, Left: Math.round((t.width - w) / 2), Top: Math.round((t.height - h) / 2), Width: w, Height: h, ...extra })
    t.elements.push(e)
    sel = t.elements.length - 1
    commit()
    renderProps()
    if (type === 'Image') chooseImage(e)
  }

  async function create() {
    if (!(await discardOk())) return
    const [, w, h] = SIZES[$('#edNewSize').value], m = Math.round(Math.min(w, h) * 0.04)
    images = {}
    reset({
      name: 'New layout', width: w, height: h, dpi: 300, background: '#FFFFFFFF',
      elements: [Layout.element('Photo', { Name: 'Photo 1', PhotoNumber: 1, Left: m, Top: m, Width: w - 2 * m, Height: h - 2 * m })],
    }, null)
  }

  async function save(asCopy) {
    if (!Layout.shots(t)) return toast('Add at least one photo slot before saving.')
    const src = templates.find(x => x.id === sourceId)
    const overwrite = !asCopy && src && !src.builtin
    try {
      const id = await booth.saveTemplate({ id: overwrite ? src.id : null, name: t.name, xml: Layout.toXml(t), copyFrom: overwrite ? null : sourceId, files })
      await loadTemplates()
      sourceId = id
      refreshList()
      load(id)
      toast(overwrite ? 'Layout saved.' : src?.builtin && !asCopy ? 'Built-in layouts are read-only, so this was saved as a new layout.' : 'Saved as a new layout.')
    } catch (err) {
      toast(`Could not save: ${err.message}`)
    }
  }

  async function remove() {
    const src = templates.find(x => x.id === sourceId)
    if (!src || src.builtin) return toast('Built-in layouts cannot be deleted.')
    if (!(await booth.confirm(`Delete the layout "${src.name}"? This cannot be undone.`))) return
    await booth.deleteTemplate(src.id)
    await loadTemplates()
    sourceId = templates[0]?.id
    refreshList()
    load(sourceId)
  }

  async function use() {
    if (!sourceId || dirty()) return toast('Save the layout first.')
    settings = await booth.saveSettings({ ...settings, templateId: sourceId })
    await loadTemplates()
    toast(`The booth now uses “${t.name}”.`)
  }

  async function close() {
    if (await discardOk()) show('attract')
  }

  list.onchange = async () => { if (await discardOk()) load(list.value); else list.value = sourceId || '' }
  $('#edNew').onclick = create
  $('#edSave').onclick = () => save(false)
  $('#edSaveCopy').onclick = () => save(true)
  $('#edDelete').onclick = remove
  $('#edUse').onclick = use
  $('#edClose').onclick = close
  for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => add(b.dataset.add)
  for (const b of document.querySelectorAll('[data-act]')) b.onclick = () => { act[b.dataset.act](); commit(); renderProps() }

  addEventListener('resize', () => { if (screen() === 'editor') draw() })
  addEventListener('keydown', ev => {
    if (screen() !== 'editor' || document.querySelector('dialog[open]')) return
    const mod = ev.metaKey || ev.ctrlKey, key = ev.key.toLowerCase()
    if (mod && key === 's') { ev.preventDefault(); return save(false) }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return
    if (mod && key === 'z') { ev.preventDefault(); return undo(ev.shiftKey ? 1 : -1) }
    if (mod && key === 'y') { ev.preventDefault(); return undo(1) }
    if (!selected()) return
    const step = ev.shiftKey ? 10 : 1
    const nudge = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key]
    if (nudge) { selected().x += nudge[0]; selected().y += nudge[1] }
    else if (key === 'delete' || key === 'backspace') act.remove()
    else if (mod && key === 'd') act.duplicate()
    else if (key === 'escape') sel = -1
    else return
    ev.preventDefault()
    commit()
    renderProps()
  })

  return { open }
})()
