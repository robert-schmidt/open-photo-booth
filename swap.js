/* global booth, $, settings, canvas, loadImage, video, stream */
// On-device face swap with browser-inswapper (Chronic Qual SRL, bundled in vendor/faceswap) and InsightFace's swap and
// identity models. The models aren't part of the app: the booth fetches them once from its models address, or the
// operator installs them from a folder in the settings (main.js keeps them and serves them at face-models/). Guests' faces go into the event's scenes (posters, characters, covers) on the review screen; or, picked
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
  // The settings' lines about face swap on this booth: the models, and what still keeps it from the guests.
  const status = (text = settings.swapReady ? 'Installed ✓' : 'Not installed. They are two files you bring yourself: inswapper_128.onnx and w600k_r50.onnx (see Face swap in the README).') => {
    $('#swapStatus').textContent = text
    $('#swapInstall').hidden = !!settings.swapReady
    const f = $('#settingsForm'), missing = [!f.swapDir.value && 'choose your scenes (1)', !settings.swapReady && 'install the models (2)'].filter(Boolean)
    $('#swapState').textContent = !f.guestSwap.checked ? '' : missing.length ? `Guests won't see face swap yet: ${missing.join(' and ')}.` : 'Ready after Save: guests find 🎭 Face swap on the editing screen.'
  }
  $('#settingsForm').addEventListener('change', () => status())

  // Once per booth, when the app has a models address: a load fetches the swap model this GPU uses, and switching to a
  // blank image fetches the identity model (setIdentity loads it before the face search fails). A second load fetches
  // the other swap model if the first one's benchmark settled on a backend that needs it. Then the booth swaps offline.
  let installing
  const install = () => (installing ??= (async () => {
    if (settings.swapReady || !settings.swapOnline) return status()
    const got = {}
    onProgress = ({ model, loaded, total }) => {
      got[model] = [loaded, total]
      const [l, t] = Object.values(got).reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0])
      status(l < t ? `Downloading face swap (once): ${Math.round((100 * l) / t)}%` : 'Preparing face swap. The first time takes a few minutes.')
    }
    try {
      for (let pass = 0; pass < 2; pass++) {
        const s = await load()
        await s.setIdentity({ image: canvas(16, 16) }).catch(() => {})
        s.dispose()
        engine = null
      }
      settings.swapReady = (await booth.getSettings()).swapReady
    } catch (e) {
      console.info('Face swap download failed:', e.message)
    }
    onProgress = () => {}
    status()
  })().finally(() => { installing = null }))

  // Loading takes a few seconds (and minutes the very first time on a machine, while the GPU compiles its shaders),
  // so it starts in the background at launch; after that a swap takes about 0.2 s on an M-series Mac.
  const on = () => settings.guestSwap && settings.swapReady
  const warm = () => { if (on()) load().then(() => reset()).catch(e => console.warn('Face swap warm-up failed:', e)) }

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

  // The operator's own copy of the models, from a folder: checked against their fingerprints and kept (main.js).
  $('#swapInstall').onclick = async () => {
    const r = await booth.installFaceModels()
    if (!r) return
    settings.swapReady = r.ready
    status(r.ready ? undefined : `That folder is missing ${r.missing.join(' and ')}, or the files don't match the models this version uses.`)
    if (r.ready) warm()
  }

  return { into, install, warm, reset, status }
})()
