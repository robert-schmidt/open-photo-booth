/* global booth, Vision */
// On-device AI with MediaPipe Tasks Vision (Apache-2.0). The wasm runtime and models ship inside the app,
// so it works offline and no photo ever leaves the booth. Models load on first use and stay warm.
const AI = (() => {
  let fileset, landmarker, segmenter
  const files = () => (fileset ??= Vision.FilesetResolver.forVisionTasks('node_modules/@mediapipe/tasks-vision/wasm'))
  const model = async name => ({ modelAssetBuffer: await booth.loadModel(name), delegate: 'GPU' })

  const faceLandmarker = () => (landmarker ??= (async () => Vision.FaceLandmarker.createFromOptions(await files(), {
    baseOptions: await model('face_landmarker.task'), runningMode: 'IMAGE', numFaces: 8, outputFaceBlendshapes: true,
  }))())

  const personSegmenter = () => (segmenter ??= (async () => Vision.ImageSegmenter.createFromOptions(await files(), {
    baseOptions: await model('selfie_segmenter.tflite'), runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  }))())

  // Where the people are, as a canvas whose alpha is the model's confidence (at the model's own resolution; draw it scaled).
  // Confidence is sharpened from 0.3–0.7 to 0–1, so edges are crisp instead of a wide haze.
  async function person(c) {
    const r = (await personSegmenter()).segment(c)
    try {
      const m = r.confidenceMasks.at(-1), conf = m.getAsFloat32Array() // the last mask is "person" whether the model has 1 or 2 classes
      const out = canvas(m.width, m.height), ctx = out.getContext('2d'), img = ctx.createImageData(m.width, m.height)
      for (let i = 0; i < conf.length; i++) img.data[i * 4 + 3] = Math.min(1, Math.max(0, (conf[i] - 0.3) / 0.4)) * 255
      ctx.putImageData(img, 0, 0)
      return out
    } finally {
      r.close()
    }
  }

  // Faces in a canvas: landmarks in canvas pixels, plus blendshape scores by name (eyeBlinkLeft, …).
  async function faces(c) {
    const r = (await faceLandmarker()).detect(c)
    return r.faceLandmarks.map((pts, i) => ({
      pts: pts.map(p => ({ x: p.x * c.width, y: p.y * c.height })),
      shapes: Object.fromEntries((r.faceBlendshapes[i]?.categories || []).map(k => [k.categoryName, k.score])),
    }))
  }

  // Grabs a few frames a moment apart and keeps the one with the fewest closed eyes. Without faces, the first frame wins.
  // ponytail: blink score only; add a sharpness tie-break if motion blur shows up in real booths.
  async function bestShot(grab, n = 3, gap = 120) {
    const frames = [grab()]
    while (frames.length < n) { await new Promise(r => setTimeout(r, gap)); frames.push(grab()) }
    const closed = f => Math.max(f.shapes.eyeBlinkLeft || 0, f.shapes.eyeBlinkRight || 0)
    try {
      const found = []
      for (const c of frames) found.push(await faces(c))
      // A face with closed eyes, or one that went missing (turned away, blurred), counts 10, so it outweighs any number of half-closed eyes.
      const most = Math.max(...found.map(f => f.length))
      const scores = found.map(fs => (most - fs.length) * 10 + fs.reduce((s, f) => s + closed(f) + (closed(f) > 0.5 ? 10 : 0), 0))
      return frames[scores.indexOf(Math.min(...scores))]
    } catch {
      return frames[0]
    }
  }

  // For a camera's own shutter, which can't take a few frames to choose from: waits (up to ms) for a live view frame
  // where nobody's eyes are closed. Without faces, or if detection fails, it doesn't wait.
  async function openEyes(grab, ms = 500) {
    const end = Date.now() + ms
    try {
      do {
        const found = await faces(grab())
        if (!found.some(f => Math.max(f.shapes.eyeBlinkLeft || 0, f.shapes.eyeBlinkRight || 0) > 0.5)) return
      } while (Date.now() < end)
    } catch {}
  }

  // Loads the models in the background at startup, so the first guest doesn't wait about 5 s.
  const warm = () => faceLandmarker().catch(e => console.warn('AI warm-up failed:', e))

  return { faces, person, bestShot, openEyes, warm }
})()
