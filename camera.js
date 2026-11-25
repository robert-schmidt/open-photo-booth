/* global booth, settings, canvas, toast, startCamera, video, screen */
// The camera. A webcam comes through getUserMedia, and so does a camera in its own webcam (USB streaming) mode or behind
// an HDMI capture card. A camera the booth controls itself (cameras.js) sends its live view as JPEG frames, drawn
// into a canvas that streams like a webcam, so the preview, face swap, boomerangs and video messages work the same; its
// photos are the camera's own, full resolution and with its flash. If it goes away mid-event, the booth carries on with
// the webcam until it's back.
const Camera = (() => {
  const SIZE = { width: { ideal: 3840 }, height: { ideal: 2160 } }
  const PIXELS = 3840 * 2160 // a camera photo is edited at up to 4K's size; the camera's file is saved as it is
  const live = document.createElement('canvas'), ctx = live.getContext('2d')
  let tether = null, lost = false, decoding = false, frameIn = null

  booth.onCameraFrame(async jpeg => {
    if (!tether || decoding) return // frames that come in while one is still being decoded are dropped
    decoding = true
    try {
      const img = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
      if (live.width !== img.width || live.height !== img.height) Object.assign(live, { width: img.width, height: img.height })
      ctx.drawImage(img, 0, 0)
      img.close()
      frameIn?.()
    } catch {} finally { decoding = false }
  })
  booth.onCameraState(s => {
    lost = s === 'lost'
    toast(lost ? 'The camera is disconnected. Check its cable and battery. The booth uses the webcam meanwhile.' : 'The camera is back.')
    startCamera()
  })

  const nextFrame = () => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no picture from the camera')), 10000)
    frameIn = () => { clearTimeout(t); frameIn = null; res() }
  })
  const webcam = id => navigator.mediaDevices.getUserMedia({ video: { ...SIZE, deviceId: id ? { exact: id } : undefined } })
    .catch(() => navigator.mediaDevices.getUserMedia({ video: SIZE }))
    .catch(() => null)

  // The stream for camera id ('' for the default webcam). A controlled camera stays open while it's chosen, through
  // settings changes and while it's away.
  async function open(id) {
    if (id?.startsWith('tether:')) {
      if (tether !== id) {
        close()
        try {
          await booth.camera.open(id)
          tether = id
          lost = false
        } catch {
          toast("Couldn't find the camera. Check it's on and plugged in. The booth uses the webcam meanwhile.")
          return webcam('')
        }
      }
      if (!lost) {
        try {
          await nextFrame()
          return live.captureStream()
        } catch {
          toast('The camera sends no picture. Check it\'s switched on. The booth uses the webcam meanwhile.')
        }
      }
      return webcam('')
    }
    close()
    return webcam(id)
  }

  function close() {
    if (tether) booth.camera.close()
    tether = null
  }

  // Webcams the page can see, then the cameras the booth controls: [[id, label]]. The chosen controlled camera stays
  // in the list while it's unplugged, so opening the settings doesn't quietly switch the booth to a webcam.
  async function list() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
    const mine = (await booth.camera.list()).map(c => [c.id, `${c.name} · controlled over USB`])
    if (settings.cameraId.startsWith('tether:') && !mine.some(([id]) => id === settings.cameraId)) mine.push([settings.cameraId, 'Controlled camera (not connected)'])
    return [...cams.map((d, i) => [d.deviceId, d.label || `Camera ${i + 1}`]), ...mine]
  }

  const controlled = () => !!tether && !lost

  // A photo with the camera's own shutter, as a canvas of up to 4K's size, mirrored like the preview if the event asks.
  // The camera's file comes along as .original, which is what gets saved (see save() in app.js), never mirrored.
  async function photo() {
    const jpeg = await booth.camera.shoot()
    const img = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
    const k = Math.min(1, Math.sqrt(PIXELS / (img.width * img.height)))
    const c = canvas(Math.round(img.width * k), Math.round(img.height * k)), x = c.getContext('2d')
    if (settings.mirror) x.setTransform(-1, 0, 0, 1, c.width, 0)
    x.drawImage(img, 0, 0, c.width, c.height)
    c.camera = { width: img.width, height: img.height }
    img.close()
    c.original = jpeg
    return c
  }

  // Focus now, without waiting: the booth does this at "1" in the countdown, so the shutter fires on time.
  const focus = () => { if (controlled()) booth.camera.focus().catch(() => {}) }

  // Live view pauses after 10 quiet minutes on the start screen (a camera in live view for hours runs hot and drains its
  // battery) and comes back at the next touch. The last frame stays on screen meanwhile.
  const IDLE = 10 * 60000
  let touched = Date.now(), paused = false
  for (const ev of ['pointerdown', 'keydown']) {
    addEventListener(ev, () => {
      touched = Date.now()
      if (paused) { paused = false; booth.camera.live(true).catch(() => {}) }
    }, true)
  }
  function idle(now = Date.now()) {
    if (paused || !controlled() || screen() !== 'attract' || document.querySelector('dialog[open]') || now - touched < IDLE) return false
    paused = true
    booth.camera.live(false).catch(() => {})
    return true
  }
  setInterval(idle, 30000)

  // What the camera in use delivers, for the settings: a webcam below Full HD makes soft prints.
  async function info() {
    const w = video.videoWidth, h = video.videoHeight
    if (!w) return 'No camera in use.'
    if (controlled()) {
      const s = await booth.camera.status().catch(() => ({}))
      const battery = s.battery === 'AC' ? ', on mains power' : s.battery ? `, battery ${s.battery}` : ''
      return `In use: ${s.name || 'the camera'}${battery}. Photos at the camera's full resolution, live view at ${w} × ${h}.`
    }
    return `In use: ${w} × ${h}.${w * h < 1920 * 1080 ? ' Photos will look soft in print. A camera in webcam mode or behind an HDMI capture card does better.' : ''}`
  }

  // The camera's own settings (exposure mode, ISO, flash…) as it offers them right now: { props, flash }, or null with
  // a webcam. They live in the camera, not in the event: setProp changes one there, to the index-th value on offer.
  const props = () => (controlled() ? booth.camera.props().catch(() => null) : Promise.resolve(null))
  const setProp = (key, index) => booth.camera.set(key, index)

  return { open, close, list, controlled, photo, focus, idle, info, props, setProp }
})()
