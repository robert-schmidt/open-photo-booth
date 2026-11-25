/* global booth, $, settings: writable, templates, compose, placeholderShots, loadTemplates */
// The setup guide. On first launch and for each new event, a
// few steps name the event, pick its layout and choose what guests can do. All of it stays in the settings too.
// open() resolves once it's closed, with whether the operator asked for the settings next (More settings).
const Setup = (() => {
  const dialog = $('#setup'), STEPS = [...dialog.querySelectorAll('section')]
  // [setting, label]
  const TOOLS = [
    ['What guests make', [['modePhoto', '📸 Photos'], ['modeBoomerang', '🔁 Boomerangs'], ['modeVideo', '🎬 Video messages']]],
    ['What guests can do', [['guestLooks', '🎨 Pick a look'], ['guestBackgrounds', '🖼️ Change the background'], ['guestStickers', '🎉 Stickers and props'], ['guestSwap', '🎭 Face swap: their face in your posters and characters']]],
    ['Printing', [['autoPrint', '🖨️ Print every photo automatically']]],
  ]
  let step = 0, draft = {}, closed, more = false

  function show(i) {
    step = i
    STEPS.forEach((s, k) => { s.hidden = k !== i })
    dialog.querySelectorAll('.setup-dots i').forEach((d, k) => d.classList.toggle('on', k <= i))
    $('#setupBack').hidden = i === 0
    $('#setupMore').hidden = i < STEPS.length - 1
    $('#setupNext').textContent = i < STEPS.length - 1 ? 'Next' : 'Start the booth'
  }

  function layouts() {
    $('#setupLayouts').replaceChildren(...templates.map(t => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'look' + (t.id === draft.templateId ? ' on' : '')
      b.append(Object.assign(new Image(), { src: compose(placeholderShots(t.shots), t, { filter: 'none' }).toDataURL('image/jpeg', 0.7), alt: '' }), `${t.name} · ${t.shots} photo${t.shots > 1 ? 's' : ''}`)
      b.onclick = () => { draft.templateId = t.id; layouts() }
      return b
    }))
  }

  function tools() {
    $('#setupTools').replaceChildren(...TOOLS.flatMap(([title, items]) => [Object.assign(document.createElement('h3'), { textContent: title }), ...items.flatMap(([key, label]) => {
      const row = Object.assign(document.createElement('label'), { className: 'setup-tool' })
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!draft[key] })
      box.onchange = () => { draft[key] = box.checked; tools() }
      row.append(Object.assign(document.createElement('span'), { textContent: label }))
      if (key === 'guestSwap' && draft.guestSwap) {
        const pick = Object.assign(document.createElement('button'), { type: 'button', textContent: draft.swapDir ? 'Scenes chosen ✓' : 'Choose scenes…' })
        pick.onclick = async e => { e.preventDefault(); draft.swapDir = (await booth.chooseFolder()) || draft.swapDir; tools() }
        row.append(pick)
      }
      row.append(box)
      const note = key === 'guestSwap' && draft.guestSwap && !settings.swapReady
      return note ? [row, Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Face swap downloads its models once, when you finish this guide: about 450 to 700 MB, so the booth needs internet this one time. The start screen shows the progress.' })] : [row]
    })]))
  }

  // From the current event's settings, so finishing without changes keeps everything as it was.
  function open() {
    draft = { eventName: settings.eventName, templateId: settings.templateId, swapDir: settings.swapDir, ...Object.fromEntries(TOOLS.flatMap(([, items]) => items.map(([k]) => [k, !!settings[k]]))) }
    $('#setupName').value = draft.eventName
    $('#setupPin').value = ''
    $('#setupLock').hidden = !!settings.pin // asked once; it's in the settings after that
    layouts()
    tools()
    show(0)
    dialog.showModal()
    $('#setupName').select()
    return new Promise(r => { closed = r })
  }

  async function finish(settingsNext) {
    draft.eventName = $('#setupName').value.trim() || settings.eventName
    if ($('#setupPin').value) draft.pin = $('#setupPin').value
    if (!draft.modePhoto && !draft.modeBoomerang && !draft.modeVideo) draft.modePhoto = true // guests need something to start
    settings = await booth.saveSettings({ ...settings, ...draft })
    more = settingsNext
    dialog.close()
  }

  $('#setupBack').onclick = () => show(step - 1)
  $('#setupNext').onclick = () => (step < STEPS.length - 1 ? show(step + 1) : finish(false))
  $('#setupMore').onclick = () => finish(true)
  $('#setupName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); show(1) } }
  $('#setupKey').textContent = navigator.userAgent.includes('Mac') ? '⌘ ,' : 'Ctrl + ,'
  dialog.addEventListener('close', () => {
    try { localStorage.setItem('setupDone', '1') } catch {} // Esc skips it for good
    closed?.(more)
    more = false
  })

  // First launch, before the camera starts (see the boot in app.js).
  async function firstRun() {
    let seen = true
    try { seen = !!localStorage.getItem('setupDone') } catch {}
    if (seen) return false
    await loadTemplates()
    return open()
  }

  return { open, firstRun }
})()
