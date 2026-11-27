/* global AI, Vision, Layout, canvas, FILTERS, Enhance */
// GPU photo effects. One shared WebGL2 context runs a fragment shader over a canvas and returns a new 2D canvas.
const FX = (() => {
  let gl
  const programs = new Map()
  const VERT = '#version 300 es\nin vec2 p; out vec2 uv; void main() { uv = p * .5 + .5; gl_Position = vec4(p, 0, 1); }'

  function init() {
    gl = document.createElement('canvas').getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false })
    if (!gl) throw new Error('WebGL2 is not available')
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true) // texture row 0 is the image bottom, matching the quad's uv
  }

  function program(frag) {
    if (programs.has(frag)) return programs.get(frag)
    const p = gl.createProgram()
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]]) {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
      gl.attachShader(p, s)
    }
    gl.linkProgram(p)
    programs.set(frag, p)
    return p
  }

  // Runs frag over src. Every shader gets `img` (the source) and `px` (one pixel in uv units); numbers and arrays in u become uniforms.
  // draw() leaves the result in the shared canvas (good until the next call: for video frames); run() copies it out.
  function draw(frag, src, u = {}) {
    if (!gl) init()
    const w = src.videoWidth || src.width, h = src.videoHeight || src.height, p = program(frag)
    Object.assign(gl.canvas, { width: w, height: h })
    gl.viewport(0, 0, w, h)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.useProgram(p)
    const loc = gl.getAttribLocation(p, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    for (const [name, v] of Object.entries({ px: [1 / w, 1 / h], ...u })) {
      const a = [v].flat(), at = gl.getUniformLocation(p, name)
      gl[`uniform${a.length}f`](at, ...a)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return gl.canvas
  }
  function run(frag, src, u) {
    const out = canvas(src.width, src.height)
    out.getContext('2d').drawImage(draw(frag, src, u), 0, 0)
    return out
  }

  // Edge-preserving smoothing: neighbours that differ in color count less, so skin evens out but eyes, lips and hair stay sharp.
  const BILATERAL = `#version 300 es
precision highp float;
uniform sampler2D img; uniform vec2 px; uniform float radius, range;
in vec2 uv; out vec4 o;
void main() {
  vec3 c = texture(img, uv).rgb, sum = vec3(0); float total = 0.;
  for (int y = -6; y <= 6; y++) for (int x = -6; x <= 6; x++) {
    vec2 d = vec2(x, y) / 6.;
    vec3 s = texture(img, uv + d * radius * px).rgb;
    float w = exp(-dot(d, d) * 2.) * exp(-dot(s - c, s - c) / (2. * range * range));
    sum += s * w; total += w;
  }
  o = vec4(sum / total, 1);
}`

  // Face mesh outlines as closed polygons, chained from MediaPipe's edge lists.
  function loop(edges) {
    const next = new Map()
    for (const { start, end } of edges) { next.set(start, [...(next.get(start) || []), end]); next.set(end, [...(next.get(end) || []), start]) }
    const first = edges[0].start, out = [first]
    for (let prev = -1, at = first; ;) {
      const to = next.get(at).find(n => n !== prev && (n !== first || out.length > 2))
      if (to === undefined || to === first || out.length > edges.length) return out
      out.push(to); prev = at; at = to
    }
  }
  let parts
  const faceParts = () => (parts ??= (({ FaceLandmarker: F }) => ({
    oval: loop(F.FACE_LANDMARKS_FACE_OVAL),
    holes: [F.FACE_LANDMARKS_LEFT_EYE, F.FACE_LANDMARKS_RIGHT_EYE, F.FACE_LANDMARKS_LEFT_EYEBROW, F.FACE_LANDMARKS_RIGHT_EYEBROW, F.FACE_LANDMARKS_LIPS].map(loop),
  }))(Vision))

  const GLAM = { light: { range: 0.07, mix: 0.65 }, strong: { range: 0.11, mix: 0.9 } }

  // Glam: bilateral smoothing blended in through a soft skin mask drawn from each face (oval minus eyes, brows and lips).
  async function glam(src, level) {
    const faces = await AI.faces(src), g = GLAM[level]
    if (!faces.length || !g) return src
    const { oval, holes } = faceParts()
    const width = f => Math.max(...oval.map(i => f.pts[i].x)) - Math.min(...oval.map(i => f.pts[i].x))
    const size = Math.max(...faces.map(width))
    const mask = canvas(src.width, src.height), m = mask.getContext('2d')
    const path = (f, idx) => { m.beginPath(); idx.forEach((i, n) => m[n ? 'lineTo' : 'moveTo'](f.pts[i].x, f.pts[i].y)); m.closePath() }
    for (const f of faces) {
      m.globalCompositeOperation = 'source-over'
      path(f, oval); m.fill()
      m.globalCompositeOperation = 'destination-out'
      m.lineWidth = width(f) * 0.04 // keep a margin around eyes and lips
      for (const h of holes) { path(f, h); m.fill(); m.stroke() }
    }
    const smooth = run(BILATERAL, src, { radius: Math.max(3, size / 45), range: g.range })
    const soft = canvas(src.width, src.height), s = soft.getContext('2d')
    s.filter = `blur(${size / 40}px)`
    s.drawImage(mask, 0, 0)
    s.filter = 'none'
    s.globalCompositeOperation = 'source-in'
    s.drawImage(smooth, 0, 0)
    const out = canvas(src.width, src.height), o = out.getContext('2d')
    o.drawImage(src, 0, 0)
    o.globalAlpha = g.mix
    o.drawImage(soft, 0, 0)
    return out
  }

  // Built-in backdrops, drawn as gradients so there's no image licence to worry about.
  const BACKDROPS = {
    studio: ['Studio gray', (g, w, h) => radial(g, w, h, '#a3a3a3', '#3b3b3b')],
    white: ['Studio white', (g, w, h) => radial(g, w, h, '#ffffff', '#c9c9c9')],
    night: ['Night', (g, w, h) => radial(g, w, h, '#2b4a8a', '#05070f')],
    sunset: ['Sunset', (g, w, h) => linear(g, h, ['#ffb37a', '#ff6f91', '#8a5cc7'])],
  }
  function radial(g, w, h, inner, outer) {
    const r = g.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.hypot(w, h) * 0.6)
    r.addColorStop(0, inner); r.addColorStop(1, outer)
    return r
  }
  function linear(g, h, stops) {
    const l = g.createLinearGradient(0, 0, 0, h)
    stops.forEach((c, i) => l.addColorStop(i / (stops.length - 1), c))
    return l
  }

  // Green screen: each pixel's alpha comes from how far its color (CbCr, so shadows and brightness don't matter) is
  // from the backdrop's, which is read from the photo's top corners. Green spill on edges is pulled back to neutral.
  const CHROMA = `#version 300 es
precision highp float;
uniform sampler2D img; uniform vec2 px; uniform vec3 key; uniform float tol;
in vec2 uv; out vec4 o;
vec2 cbcr(vec3 c) { return vec2(-.169 * c.r - .331 * c.g + .5 * c.b, .5 * c.r - .419 * c.g - .081 * c.b); }
void main() {
  vec3 c = texture(img, uv).rgb, d = c;
  float a = smoothstep(tol, tol + .06, distance(cbcr(c), cbcr(key)));
  if (key.g > max(key.r, key.b)) d.g = min(d.g, max(d.r, d.b)); else if (key.b > max(key.r, key.g)) d.b = min(d.b, max(d.r, d.g));
  o = vec4(mix(d, c, a * a), a);
}`
  function keyColor(src) {
    const s = canvas(32, 32), g = s.getContext('2d', { willReadFrequently: true }), sum = [0, 0, 0]
    g.drawImage(src, 0, 0, 32, 32)
    const d = g.getImageData(0, 0, 32, 32).data
    for (const x0 of [0, 28]) for (let y = 0; y < 4; y++) for (let x = x0; x < x0 + 4; x++) for (let k = 0; k < 3; k++) sum[k] += d[(y * 32 + x) * 4 + k]
    return sum.map(v => v / 32 / 255)
  }
  // The cut-out people for a green screen, as a canvas with alpha. tolerance: 1–100 from the settings (the calibration knob).
  const chromaKey = (src, tolerance) => run(CHROMA, src, { key: keyColor(src), tol: 0.02 + tolerance / 500 })

  // Swaps what's behind the people: 'blur', a built-in backdrop key, or an image (cover-fitted). With a green screen
  // (chroma = its tolerance) the backdrop color is keyed out instead of asking the person segmenter.
  async function background(src, bg, chroma) {
    const { width: w, height: h } = src, mask = chroma ? null : await AI.person(src)
    const out = canvas(w, h), o = out.getContext('2d')
    if (bg === 'blur') {
      o.filter = `blur(${w / 70}px)`
      o.drawImage(src, 0, 0)
      o.filter = 'none'
    } else if (BACKDROPS[bg]) {
      o.fillStyle = BACKDROPS[bg][1](o, w, h)
      o.fillRect(0, 0, w, h)
    } else {
      const k = Layout.cover(bg.width, bg.height, w, h)
      o.drawImage(bg, k.sx, k.sy, k.sw, k.sh, 0, 0, w, h)
    }
    if (chroma) {
      o.drawImage(chromaKey(src, chroma), 0, 0)
      return out
    }
    // The people: the photo cut out by the mask, scaled up smoothly with a slightly feathered edge.
    const cut = canvas(w, h), c = cut.getContext('2d')
    c.filter = `blur(${Math.max(1, w / 500)}px)`
    c.drawImage(mask, 0, 0, w, h)
    c.filter = 'none'
    c.globalCompositeOperation = 'source-in'
    c.drawImage(src, 0, 0)
    o.drawImage(cut, 0, 0)
    return out
  }

  // Art looks. Comic: flat posterized color with ink outlines (Sobel edges). Sketch: a pencil drawing, the photo
  // divided by its own blur ("color dodge"), so flat areas go paper-white and edges turn into strokes.
  const LUM = 'float lum(vec2 p) { return dot(texture(img, p).rgb, vec3(.299, .587, .114)); }'
  const COMIC = `#version 300 es
precision highp float;
uniform sampler2D img; uniform vec2 px; uniform float thick;
in vec2 uv; out vec4 o;
${LUM}
void main() {
  vec2 d = px * thick;
  float tl = lum(uv + d * vec2(-1, 1)), t = lum(uv + d * vec2(0, 1)), tr = lum(uv + d * vec2(1, 1)), l = lum(uv - d * vec2(1, 0));
  float r = lum(uv + d * vec2(1, 0)), bl = lum(uv - d), b = lum(uv - d * vec2(0, 1)), br = lum(uv + d * vec2(1, -1));
  float edge = smoothstep(.3, .6, length(vec2(tr + 2. * r + br - tl - 2. * l - bl, tl + 2. * t + tr - bl - 2. * b - br)));
  vec3 c = texture(img, uv).rgb; float y = lum(uv);
  vec3 col = clamp(c * ((floor(y * 4.) + .6) / 4. / max(y, .02)), 0., 1.);
  col = clamp(mix(vec3(dot(col, vec3(.333))), col, 1.4), 0., 1.);
  o = vec4(mix(col, vec3(.07), edge), 1);
}`
  const SKETCH = `#version 300 es
precision highp float;
uniform sampler2D img; uniform vec2 px; uniform float radius;
in vec2 uv; out vec4 o;
${LUM}
void main() {
  float b = 0., t = 0.;
  for (int y = -5; y <= 5; y++) for (int x = -5; x <= 5; x++) {
    vec2 d = vec2(x, y) / 5.; float w = exp(-dot(d, d) * 2.);
    b += lum(uv + d * radius * px) * w; t += w;
  }
  float s = pow(clamp(lum(uv) / max(b / t, .01), 0., 1.), 4.);
  o = vec4(s * vec3(1., .98, .94), 1);
}`
  const ART = {
    comic: ['Comic', src => run(COMIC, run(BILATERAL, src, { radius: Math.max(3, src.width / 250), range: 0.12 }), { thick: Math.max(1, src.width / 900) })],
    sketch: ['Sketch', src => run(SKETCH, src, { radius: Math.max(3, src.width / 200) })],
  }
  // Listed with the CSS looks so the settings and the review screen offer them; review.js runs them through FX.ART.
  for (const [k, [label]] of Object.entries(ART)) FILTERS[k] = [label, 'none']

  // The event's .cube colour presets ([{ name, text }], from its looks folder) as extra looks, named after their files.
  // A photo goes through Enhance.lut; the frames of boomerangs and videos through grade(), the same table on the GPU.
  const tables = new Map() // look -> { n, data, tex }
  const GRADE = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D img; uniform sampler3D lut; uniform float n;
in vec2 uv; out vec4 o;
void main() { vec4 c = texture(img, uv); o = vec4(texture(lut, c.rgb * (n - 1.) / n + .5 / n).rgb, c.a); }`
  // One frame (a canvas or a playing video) in a .cube look. The result is the shared canvas: draw it before the next call.
  function grade(src, look) {
    if (!gl) init()
    const t = tables.get(look), p = program(GRADE)
    gl.activeTexture(gl.TEXTURE1)
    if (!t.tex) {
      gl.bindTexture(gl.TEXTURE_3D, (t.tex = gl.createTexture()))
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE)
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, k, gl.LINEAR)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false) // a table isn't a picture (and WebGL refuses to flip one)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, t.n, t.n, t.n, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(t.data.buffer))
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    }
    gl.bindTexture(gl.TEXTURE_3D, t.tex)
    gl.activeTexture(gl.TEXTURE0)
    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'lut'), 1)
    return draw(GRADE, src, { n: t.n })
  }
  function luts(files) {
    for (const [k, t] of tables) { gl?.deleteTexture(t.tex); tables.delete(k) }
    for (const k of Object.keys(ART)) if (k.startsWith('lut:')) { delete ART[k]; delete FILTERS[k] }
    for (const { name, text } of files) {
      const table = Enhance.cube(text)
      if (!table) { console.warn(`${name}.cube isn't a 3D colour table: skipped`); continue }
      FILTERS[`lut:${name}`] = [name, 'none']
      tables.set(`lut:${name}`, table)
      ART[`lut:${name}`] = [name, src => {
        const out = canvas(src.width, src.height), ctx = out.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(src, 0, 0)
        ctx.putImageData(Enhance.lut(ctx.getImageData(0, 0, out.width, out.height), table), 0, 0)
        return out
      }]
    }
  }

  return { run, glam, background, chromaKey, luts, grade, BACKDROPS, ART }
})()
