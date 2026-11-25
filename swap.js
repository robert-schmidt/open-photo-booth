/* global booth, $, settings, canvas, loadImage, video, stream, toast */
// On-device face swap with browser-inswapper (Chronic Qual SRL, bundled in vendor/faceswap) and InsightFace's swap and
// identity models. The models aren't in the installer: the booth downloads them once, when face swap is first turned on
// (main.js fetches, checks and keeps them, and serves them at face-models/). Guests' faces go into the event's scenes (posters, characters, covers) on the review screen; or, picked
// on the start screen, a scene's character takes over the guest's face live, for photos, boomerangs and videos alike.
const Swap = (() => {
  let engine, onProgress = () => {}
  const load = () => (engine ??= (async () => {
    const { createFaceSwap, KNOWN_SHA256: sha } = await import('./vendor/faceswap/faceswap.js')
    const model = (file, sha256) => ({ url: `face-models/${file}`, sha256 })
    return createFaceSwap({
      models: {
        swapperFp16: model('inswapper_128_fp16.onnx', sha.swapperFp16), swapperFp32: model('inswapper_128.onnx', sha.swapperFp32),
        arcface: model('w600k_r50.onnx', sha.arcface), landmarker: { url: 'models/face_landmarker.task', sha256: sha.landmarker },
      },
      workers: { swap: 'vendor/faceswap/worker.js', occlusion: 'vendor/faceswap/segment-worker.js' },
      ortWasmPaths: new URL('vendor/faceswap/ort/', location.href).href,
      mediapipeWasm: new URL('vendor/faceswap/mediapipe', location.href).href,
      occlusion: false, // ponytail: no hands-in-front masks (a 16 MB model); add for live if guests' hands smear
      onProgress: p => onProgress(p),
      onLog: m => console.info('[faceswap]', m),
    })
  })().catch(e => { engine = null; throw e }))

  // The guest's faces go into the scene's faces, biggest first: scene face i gets guest (i + turn) % guests, so each
  // "Swap places" moves everyone along one face (and brings in guests the scene has no room for).
  // A canvas with .people (guests found), or null when the photo or the scene has no face.
  async function into(scene, guest, turn = 0) {
    const s = await load()
    const [guests, targets] = await Promise.all([s.findFaces(guest), s.findFaces(scene)])
    if (!guests.length || !targets.length) return null
    const ids = []
    for (const face of guests.slice(0, 6)) ids.push(await s.identityOf({ image: guest, face }))
    const bmp = await s.swapPhoto(scene, targets.map((face, i) => ({ face, identity: ids[(i + turn) % ids.length] })))
    const out = canvas(bmp.width, bmp.height)
    out.getContext('2d').drawImage(bmp, 0, 0)
    bmp.close()
    return Object.assign(out, { people: ids.length })
  }

  // The settings' line about face swap on this booth.
  // What the operator sees of the models: a line and a button in the settings, a line under them saying what still
  // keeps face swap from the guests, and while they download, a note on the start screen.
  let state = '' // 'busy' while downloading and preparing, 'failed' after a download that didn't finish
  const status = text => {
    const f = $('#settingsForm'), busy = state === 'busy'
    $('#swapStatus').textContent = text ?? (settings.swapReady ? 'On this booth ✓' : state === 'failed' ? "The download didn't finish. Check the internet connection, then try again."
      : 'Not on this booth yet. They download once (about 450 to 700 MB) when you turn face swap on and save, or right now.')
    $('#swapGet').hidden = settings.swapReady || busy
    $('#swapGet').textContent = state === 'failed' ? 'Try again' : 'Download now'
    $('#swapProgress').hidden = !busy
    if (busy) $('#swapProgress').textContent = `🎭 Face swap: ${text || 'starting…'}`
    const missing = [!f.swapDir.value && 'your scenes (1)', !settings.swapReady && (busy ? 'the models, downloading now (2)' : state === 'failed' ? 'the models: press Try again (2)' : 'the models, which download when you save (2)')].filter(Boolean)
    $('#swapState').textContent = !f.guestSwap.checked ? '' : missing.length ? `Still needed before guests see face swap: ${missing.join(' and ')}.` : 'Ready after Save: guests find 🎭 Face swap on the editing screen.'
  }
  $('#settingsForm').addEventListener('change', () => status())

  // Once per booth: a load fetches the swap model this GPU uses, and switching to a blank image fetches the identity
  // model (setIdentity loads it before the face search fails). A second load fetches the other swap model if the first
  // one's benchmark settled on a backend that needs it. Then the booth swaps offline.
  let installing
  const install = () => (installing ??= (async () => {
    if (settings.swapReady) return
    const got = {}
    state = 'busy'
    status()
    onProgress = ({ model, loaded, total }) => {
      got[model] = [loaded, total]
      const [l, t] = Object.values(got).reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0])
      status(l < t ? `downloading ${Math.round((100 * l) / t)}%` : 'getting ready (a few minutes, this one time)')
    }
    try {
      for (let pass = 0; pass < 2; pass++) {
        const s = await load()
        await s.setIdentity({ image: canvas(16, 16) }).catch(() => {})
        s.dispose()
        engine = null
      }
    } catch (e) {
      console.info('Face swap download failed:', e.message)
    }
    settings.swapReady = (await booth.getSettings()).swapReady
    onProgress = () => {}
    state = settings.swapReady ? '' : 'failed'
    status()
    toast(settings.swapReady ? 'Face swap is ready.' : "Face swap couldn't download its models. Check the internet connection, then ⚙️ → Face swap → Try again.")
  })().finally(() => { installing = null }))

  // Loading takes a few seconds (and minutes the very first time on a machine, while the GPU compiles its shaders),
  // so it starts in the background at launch; after that a swap takes about 0.2 s on an M-series Mac.
  const on = () => settings.guestSwap && settings.swapReady
  const warm = () => { if (on()) load().then(() => reset()).catch(e => console.warn('Face swap warm-up failed:', e)) }
  // At launch and whenever the settings change: the first time face swap is on, its models are fetched.
  const ensure = () => (settings.guestSwap && !settings.swapReady && state !== 'failed' ? install() : Promise.resolve()).then(warm)
  $('#swapGet').onclick = () => { state = ''; install().then(warm) }

  // Live characters: the biggest face of each scene, with its picture for the start screen.
  let cast = { key: null, list: [] }, live = null
  async function characters() {
    if (cast.key === settings.swapDir) return cast.list
    const s = await load(), list = []
    for (const url of await booth.listImages('swapDir')) {
      const image = await loadImage(url).catch(() => null), face = image && (await s.findFaces(image).catch(() => []))[0]
      if (face) list.push({ image, face })
    }
    cast = { key: settings.swapDir, list }
    return list
  }

  // The camera view becomes the character (the biggest face in view, smoothed over time); null goes back to the guest.
  // Swapping characters while live morphs from one to the other.
  // The camera track is cloned: the swap ends its input when it stops, and the camera itself must keep running.
  // picks counts choices, so a character still loading when the guest taps Me (or leaves) doesn't switch on after all.
  let input, picks = 0
  async function pick(c) {
    if (!c) return stop()
    const n = ++picks, s = await load()
    await s.setIdentity({ image: c.image, face: c.face }, { morphMs: live ? 600 : 0 })
    if (n !== picks || live) return
    live = s.process((input = stream.getVideoTracks()[0].clone()))
    video.srcObject = new MediaStream([live])
  }
  function stop() {
    picks++
    if (!live) return
    live.stop()
    input.stop()
    live = null
    video.srcObject = stream
  }

  // Back to the guest's own face and the character row on the start screen (at launch, and when each guest finishes).
  async function reset() {
    stop()
    const box = $('#characters')
    box.hidden = true
    if (!on() || !settings.swapLive || !stream) return
    const list = await characters().catch(() => [])
    if (!list.length) return
    const button = (c, ...content) => {
      const b = document.createElement('button')
      b.append(...content)
      b.onclick = e => {
        e.stopPropagation()
        for (const o of box.querySelectorAll('button')) o.classList.toggle('on', o === b)
        pick(c).catch(err => { console.warn('Live face swap failed:', err); stop() })
      }
      return b
    }
    const face = c => {
      const k = canvas(160, 160)
      k.getContext('2d').drawImage(c.face.preview, 0, 0, 160, 160)
      return Object.assign(k, { ariaLabel: 'A character' })
    }
    box.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Become someone' }),
      button(null, Object.assign(document.createElement('i'), { textContent: '🙂' }), 'Me'), ...list.map(c => button(c, face(c))))
    box.querySelector('button').classList.add('on')
    box.hidden = false
  }

  return { into, ensure, reset, status }
})()
