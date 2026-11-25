/* global booth, $, settings, current: writable, template, compose, save, printCurrent, show, screen, toast, canvas, sleep, stream, video, startSession, FILTERS, FX, Review, Swap */
// Capture modes. Guests pick Photos, Boomerang or Video message on the start screen (the event chooses which).
// A boomerang is a short burst played forward and back; a video message has sound. Both save as MP4 and take a look;
// a boomerang also makes a flip-book layout of its frames, which is what Print prints.
const Capture = (() => {
  const MODES = [['photo', '📸', 'Photos'], ['boomerang', '🔁', 'Boomerang'], ['video', '🎬', 'Video message']]
  const FPS = 15, FRAMES = 24 // 1.6 s of movement
  const VIDEO = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9'].find(t => MediaRecorder.isTypeSupported(t))
  const SOUND = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus'].find(t => MediaRecorder.isTypeSupported(t))
  const ext = type => (type.startsWith('video/mp4') ? 'mp4' : 'webm')
  const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const enabled = () => {
    const on = MODES.filter(([m]) => settings[`mode${m[0].toUpperCase()}${m.slice(1)}`])
    return on.length ? on : [MODES[0]]
  }
  let timer, frame = 0

  // Start screen: one mode keeps "Touch to start"; two or more become big buttons.
  function attract() {
    const modes = enabled()
    $('#startText').hidden = modes.length > 1
    $('#modes').hidden = modes.length < 2
    $('#modes').replaceChildren(...modes.map(([mode, icon, label]) => {
      const b = document.createElement('button')
      b.append(Object.assign(document.createElement('i'), { textContent: icon }), label)
      b.onclick = e => { e.stopPropagation(); start(mode) }
      return b
    }))
    Swap.reset()
  }

  // A tap on the start screen, or Space/Enter: with several modes the guest picks a button, so only one mode starts directly.
  function start(mode = enabled().length === 1 ? enabled()[0][0] : null) {
    if (!mode || screen() !== 'attract') return
    if (mode === 'photo') return startSession()
    if (!stream || !video.videoWidth) return toast('Camera is starting, try again in a moment.')
    ;(mode === 'boomerang' ? boomerang() : message()).catch(e => {
      show('attract')
      toast(`Something went wrong: ${e.message}`)
    })
  }

  async function countdown(status) {
    show('capture')
    $('#status').textContent = status
    for (let n = settings.countdown; n > 0; n--) { $('#count').textContent = n; await sleep(1000) }
    $('#count').textContent = ''
  }

  // One camera frame, mirrored like the live view, at most 1280 px wide (24 full 4K frames would need gigabytes).
  function grabSmall() {
    const k = Math.min(1, 1280 / video.videoWidth), c = canvas(Math.round(video.videoWidth * k), Math.round(video.videoHeight * k)), ctx = c.getContext('2d')
    if (settings.mirror) ctx.setTransform(-1, 0, 0, 1, c.width, 0)
    ctx.drawImage(video, 0, 0, c.width, c.height)
    return c
  }

  async function boomerang() {
    await countdown('Boomerang! Get ready to move…')
    $('#status').textContent = 'Move!'
    let frames = []
    for (let i = 0; i < FRAMES; i++) { frames.push(grabSmall()); await sleep(1000 / FPS) }
    // The event's background (green screen or cut-out) on every frame: about a second for the burst.
    const backdrop = await Review.backdrop()
    if (backdrop) {
      $('#status').textContent = 'Making your boomerang…'
      const swapped = []
      for (const f of frames) swapped.push(await FX.background(f, backdrop, settings.greenScreen && settings.chromaTolerance).catch(() => f))
      frames = swapped
    }
    $('#status').textContent = ''
    const stamp = stampNow()
    current = { kind: 'boomerang', frames, look: look(), stamp }
    // The flip-book layout is saved right away, like a photo session; the MP4 is made when the guest finishes.
    current.sheet = flipbook(frames, current.look)
    current.saved = save(current.sheet, `${stamp}.jpg`).then(file => ({ stamp, file }))
    current.saved.catch(e => toast(`Could not save: ${e.message}`))
    booth.logSession({ type: 'session', mode: 'boomerang', stamp, shots: FRAMES })
    open()
  }

  // The event's look, unless it's an art look (those need a photo's faces and take too long per frame).
  const look = () => (FILTERS[settings.filter] && !FX.ART[settings.filter] ? settings.filter : 'none')

  // The event's layout, its photo slots filled with frames spread over the burst.
  const flipbook = (frames, look) => compose(Array.from({ length: template.shots }, (_, i) => frames[Math.round(i * (frames.length - 1) / Math.max(1, template.shots - 1))]), template, { filter: look, qr: null })

  async function message() {
    show('capture') // at once: the start screen would take a second tap while the microphone opens
    let mic = null
    // The chosen microphone, or the default one if it's unplugged.
    for (const audio of [settings.micId && { deviceId: { exact: settings.micId } }, true].filter(Boolean)) {
      mic ??= await navigator.mediaDevices.getUserMedia({ audio }).catch(() => null)
    }
    if (!mic) toast('No microphone found, so this video has no sound.')
    const type = mic ? SOUND : VIDEO, chunks = []
    try {
      await countdown('Video message: get ready…')
      // From the camera view, so a live face swap character is in the video too.
      const rec = new MediaRecorder(new MediaStream([...video.srcObject.getVideoTracks(), ...(mic?.getAudioTracks() || [])]), { mimeType: type, videoBitsPerSecond: 5e6 })
      rec.ondataavailable = e => e.data.size && chunks.push(e.data)
      const stopped = new Promise(r => { rec.onstop = r })
      rec.start(1000)
      let stop
      const pressed = new Promise(r => { stop = r })
      $('#stopRec').hidden = false
      $('#stopRec').onclick = () => stop()
      const end = Date.now() + settings.videoSeconds * 1000
      const tick = setInterval(() => { $('#status').innerHTML = `<span class="rec-dot">●</span> Recording · ${Math.max(0, Math.ceil((end - Date.now()) / 1000))}` }, 200)
      await Promise.race([sleep(settings.videoSeconds * 1000), pressed])
      clearInterval(tick)
      $('#stopRec').hidden = true
      $('#status').textContent = ''
      rec.stop()
      await stopped
    } finally {
      mic?.getTracks().forEach(t => t.stop()) // also when recording fails, so the microphone light goes off
    }
    const stamp = stampNow(), blob = new Blob(chunks, { type })
    current = { kind: 'video', blob, stamp, look: look(), still: grabSmall() }
    current.clip = booth.savePhoto(`${stamp}.${ext(type)}`, await blob.arrayBuffer()) // saved at once: nothing lost if the booth closes
    current.clip.catch(e => toast(`Could not save: ${e.message}`))
    booth.logSession({ type: 'session', mode: 'video', stamp })
    open()
  }

  // The boomerang as MP4: forward, back, forward, back, at the burst's own speed.
  async function encode(frames, look) {
    const seq = [...frames, ...frames.slice(1, -1).reverse()], c = canvas(frames[0].width, frames[0].height), ctx = c.getContext('2d')
    const track = c.captureStream(0).getVideoTracks()[0], chunks = []
    const rec = new MediaRecorder(new MediaStream([track]), { mimeType: VIDEO, videoBitsPerSecond: 6e6 })
    rec.ondataavailable = e => e.data.size && chunks.push(e.data)
    const stopped = new Promise(r => { rec.onstop = r })
    rec.start()
    for (const f of [...seq, ...seq]) {
      ctx.filter = FILTERS[look]?.[1] || 'none'
      ctx.drawImage(f, 0, 0)
      track.requestFrame()
      await sleep(1000 / FPS)
    }
    rec.stop()
    await stopped
    return new Blob(chunks, { type: VIDEO })
  }

  // A video message in a look: played through a canvas with the look's filter and recorded again, sound and all, at
  // most 1920 px wide. It runs in real time after the guest has gone; the sound goes into the recording, not the speakers.
  async function restyle(blob, look) {
    const v = Object.assign(document.createElement('video'), { src: URL.createObjectURL(blob), playsInline: true })
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('unreadable video')) })
    const k = Math.min(1, 1920 / v.videoWidth), c = canvas(Math.round(v.videoWidth * k), Math.round(v.videoHeight * k)), ctx = c.getContext('2d')
    const audio = new AudioContext(), sound = audio.createMediaStreamDestination(), chunks = []
    audio.createMediaElementSource(v).connect(sound)
    const tracks = [c.captureStream(30).getVideoTracks()[0], ...(blob.type === SOUND ? sound.stream.getAudioTracks() : [])]
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: blob.type, videoBitsPerSecond: 5e6 })
    rec.ondataavailable = e => e.data.size && chunks.push(e.data)
    const stopped = new Promise(r => { rec.onstop = r }), ended = new Promise(r => { v.onended = r })
    ctx.filter = FILTERS[look][1]
    const draw = () => { ctx.drawImage(v, 0, 0, c.width, c.height); if (!v.ended) requestAnimationFrame(draw) }
    rec.start(1000)
    await v.play()
    draw()
    await ended
    rec.stop()
    await stopped
    audio.close()
    URL.revokeObjectURL(v.src)
    return new Blob(chunks, { type: blob.type })
  }

  // Review for boomerangs and videos: the clip plays on a loop, with Retake, Print (boomerang) and Done.
  function open() {
    const boom = current.kind === 'boomerang', c = current
    $('#clipCanvas').hidden = !boom
    $('#clipVideo').hidden = boom
    $('#clipLooksTool').hidden = !settings.guestLooks
    $('#clipPrint').hidden = !boom || settings.autoPrint
    $('#clipPrint').disabled = false
    if (boom) {
      Object.assign($('#clipCanvas'), { width: c.frames[0].width, height: c.frames[0].height })
      const seq = [...c.frames, ...c.frames.slice(1, -1).reverse()], ctx = $('#clipCanvas').getContext('2d')
      let i = 0, last = 0
      const draw = t => {
        if (screen() !== 'clip' || current !== c) return
        if (t - last >= 1000 / FPS) { ctx.filter = FILTERS[c.look]?.[1] || 'none'; ctx.drawImage(seq[i++ % seq.length], 0, 0); last = t }
        frame = requestAnimationFrame(draw)
      }
      frame = requestAnimationFrame(draw)
    } else {
      unload()
      Object.assign($('#clipVideo'), { src: URL.createObjectURL(c.blob), loop: true, muted: false })
      $('#clipVideo').play().catch(() => {})
    }
    looks()
    show('clip')
    poke()
  }

  // Lets go of the last video message's copy in memory (a day of guests would otherwise pile up gigabytes).
  function unload() {
    const v = $('#clipVideo')
    v.pause()
    URL.revokeObjectURL(v.src)
    v.removeAttribute('src')
    v.load()
  }

  // A boomerang draws its frames in the look; a video shows it as a CSS filter until it's restyled on Done.
  function looks() {
    const still = current.still ?? current.frames[Math.floor(FRAMES / 2)]
    $('#clipVideo').style.filter = FILTERS[current.look]?.[1] || 'none'
    $('#clipLooks').replaceChildren(...Object.keys(FILTERS).filter(k => !FX.ART[k]).map(key => {
      const b = document.createElement('button'), thumb = canvas(160, Math.round(160 * still.height / still.width))
      const t = thumb.getContext('2d')
      t.filter = FILTERS[key][1]
      t.drawImage(still, 0, 0, thumb.width, thumb.height)
      b.className = 'look' + (current.look === key ? ' on' : '')
      b.append(Object.assign(new Image(), { src: thumb.toDataURL('image/jpeg', 0.8), alt: '' }), key === 'none' ? 'Original' : FILTERS[key][0])
      b.onclick = () => { current.look = key; looks() }
      return b
    }))
  }

  function poke() {
    clearTimeout(timer)
    timer = setTimeout(() => finish(), settings.reviewSeconds * 1000)
    const bar = $('#clipDone .idle')
    bar.style.animation = 'none'
    void bar.offsetWidth
    bar.style.animation = `idle ${settings.reviewSeconds}s linear forwards`
  }
  document.addEventListener('pointerdown', () => { if (screen() === 'clip') poke() })
  document.addEventListener('keydown', () => { if (screen() === 'clip') poke() })

  // Saving and printing carry on after the guest has gone: the next guest can start straight away.
  function finish(print = settings.autoPrint && current.kind === 'boomerang') {
    if (screen() !== 'clip') return
    const c = current
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    unload()
    if (c.kind === 'boomerang') {
      const sheet = flipbook(c.frames, c.look)
      if (c.look !== 'none') c.saved = c.saved.then(async r => ({ ...r, file: await save(sheet, `${c.stamp}.jpg`) }))
      c.sheet = sheet
      c.clip = encode(c.frames, c.look).then(async blob => booth.savePhoto(`${c.stamp}.${ext(VIDEO)}`, await blob.arrayBuffer()))
    } else if (c.look !== 'none') {
      // The plain video is already saved: if restyling fails, that one is kept.
      c.clip = c.clip.then(file => restyle(c.blob, c.look).then(async blob => booth.savePhoto(`${c.stamp}.${ext(c.blob.type)}`, await blob.arrayBuffer()), e => {
        console.warn('Could not restyle the video:', e)
        return file
      }))
    }
    c.clip.catch(e => toast(`Could not save: ${e.message}`))
    if (print) printCurrent()
    Swap.reset()
    show('attract')
  }

  $('#clipDone').onclick = () => finish()
  $('#clipPrint').onclick = () => finish(true)
  $('#clipRetake').onclick = () => {
    const mode = current.kind
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    unload()
    show('attract')
    start(mode)
  }

  return { attract, start, finish }
})()
