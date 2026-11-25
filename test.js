// Self-check for layout.js and the bundled templates. Run: npm test
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./layout.js')

const near = (a, b) => Object.keys(b).forEach(k => assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${k}: ${a[k]} != ${b[k]}`))
// Test-only XML reader for our own flat files (the app uses DOMParser).
const attrs = s => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))]))
const read = xml => L.fromNodes(attrs(/<Template\s([^>]*)>/.exec(xml)[1]), [...xml.matchAll(/<(\w+)\s([^>]*?)\/>/g)].map(m => ({ tag: m[1], attrs: attrs(m[2]) })))

assert.equal(L.argb('#ffffff'), '#FFFFFFFF')
assert.equal(L.argb('80FF0000'), '#80FF0000')
assert.equal(L.argb('red', 'x'), 'x')
assert.equal(L.css('#FFFFFFFF'), 'rgba(255,255,255,1)')
assert.equal(L.css('#80FF0000'), 'rgba(255,0,0,0.502)')
assert.equal(L.css('nope'), 'rgba(0,0,0,0)')

near(L.cover(1920, 1080, 600, 400), { sx: 150, sy: 0, sw: 1620, sh: 1080 })
near(L.cover(1000, 1000, 400, 200), { sx: 0, sy: 250, sw: 1000, sh: 500 })
near(L.contain(1000, 500, 400, 400), { dx: 0, dy: 100, dw: 400, dh: 200 })
// A focus point moves the crop toward it, but never past the edge of the photo.
near(L.cover(1920, 1080, 600, 400, 0.55, 0.5), { sx: 246, sy: 0, sw: 1620, sh: 1080 })
near(L.cover(1920, 1080, 600, 400, 0.05, 0.5), { sx: 0, sy: 0, sw: 1620, sh: 1080 })
near(L.cover(1000, 2000, 400, 400, 0.5, 0.1), { sx: 0, sy: 0, sw: 1000, sh: 1000 })
near(L.cover(1000, 2000, 400, 400, 0.5, 0.6), { sx: 0, sy: 700, sw: 1000, sh: 1000 })

assert.equal(L.fillText('{event} – {date} {nope}', { event: 'Gala', date: 'today' }), 'Gala – today {nope}')

const t = L.fromNodes({ Width: '600', Height: '1800' }, [
  { tag: 'Photo', attrs: { PhotoNumber: '2', ZIndex: '1' } },
  { tag: 'Photo', attrs: { PhotoNumber: '1', ZIndex: '0', Opacity: '50', Thickness: '4' } },
  { tag: 'QRCode', attrs: {} },
])
assert.equal(t.shots, 2)
assert.deepEqual(t.elements.map(e => e.type === 'Photo' ? e.photo : e.type), [1, 'QRCode', 2]) // sorted by ZIndex (QRCode's is 0)
assert.equal(t.elements[0].opacity, 50)
assert.equal(t.elements[0].strokeWidth, 4)
assert.equal(t.dpi, 300)
assert.throws(() => L.fromNodes({}, [{ tag: 'Text', attrs: {} }]), /no photo slots/)

// QRCode elements (dslrBooth layouts) load and save; they aren't photo slots.
const withQr = L.fromNodes({ Width: '600', Height: '1800' }, [{ tag: 'Photo', attrs: { PhotoNumber: '1' } }, { tag: 'QRCode', attrs: { Left: '400', Top: '1600', Width: '160', Height: '160' } }])
assert.deepEqual([withQr.shots, withQr.elements[1].type, withQr.elements[1].w], [1, 'QRCode', 160])
assert.match(L.toXml(withQr), /<QRCode Name="QRCode" Left="400" Top="1600" Width="160" Height="160"/)

// Serializer round-trip, including characters that need escaping.
const edited = {
  name: 'Tom & Jerry "party"', width: 1800, height: 1200, dpi: 300, background: '#FF102030',
  elements: [
    L.element('Photo', { PhotoNumber: 1, Left: 10, Top: 20, Width: 300, Height: 200, Rotation: -5, KeepAspect: 'True' }),
    L.element('Text', { Text: 'Line <1>\nLine 2', FontName: 'Arial', FontSize: 40, FontColor: '#FFABCDEF', TextAlignment: 'Right' }),
    L.element('Image', { ImagePath: 'frame.png', Opacity: 80 }),
    L.element('Ellipse', { Fill: '#80FF0000', Thickness: 3, ShadowEnabled: 'True' }),
  ],
}
const back = read(L.toXml(edited))
assert.equal(back.name, edited.name)
assert.equal(back.background, edited.background)
assert.deepEqual(back.elements.map(e => ({ ...e, z: 0 })), edited.elements.map(e => ({ ...e, z: 0 })))

// Bundled templates parse and stay inside the canvas.
for (const d of fs.readdirSync(path.join(__dirname, 'templates'))) {
  const tpl = read(fs.readFileSync(path.join(__dirname, 'templates', d, 'template.xml'), 'utf8'))
  for (const e of tpl.elements) {
    assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= tpl.width && e.y + e.h <= tpl.height, `${d}: ${e.name} out of bounds`)
  }
}

// Enhance: a washed-out, blue-tinted image gets its full range back and loses most of the tint;
// an image that is already fine barely changes.
const E = require('./enhance.js')
const img = (w, h, px) => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) data.set([...px(i % w, Math.floor(i / w)), 255], i * 4); return { data, width: w, height: h } }
const stats = ({ data }) => { const m = [0, 0, 0]; let lo = 255, hi = 0; for (let i = 0; i < data.length; i += 4) { for (let c = 0; c < 3; c++) m[c] += data[i + c] / (data.length / 4); const y = (data[i] + data[i + 1] + data[i + 2]) / 3; lo = Math.min(lo, y); hi = Math.max(hi, y) } return { m, lo, hi } }
const misty = E.apply(img(200, 100, x => [90 + x / 2, 90 + x / 2, 110 + x / 2]))
const ms = stats(misty)
assert.ok(ms.hi - ms.lo > 160, `range of about 100 stretched by the full 1.6x: ${ms.lo}..${ms.hi}`)
assert.ok(Math.abs(ms.m[2] - ms.m[0]) < 12, `blue tint reduced: ${ms.m.map(Math.round)}`)
// Exposure from a test shot: a frame two stops under mid grey asks for two more stops, and the camera's nearest values
// bring the next shot to within a third of a stop, by exposure compensation or (in manual) by ISO. Auto is never picked.
const lit = stops => { const v = Math.round(255 * (0.18 * 2 ** stops) ** (1 / 2.2)); return img(320, 200, () => [v, v, v]) }
assert.ok(Math.abs(E.exposure(lit(-2)) - 2) < 0.1 && Math.abs(E.exposure(lit(0))) < 0.1, `metered: ${E.exposure(lit(-2))}, ${E.exposure(lit(0))}`)
assert.ok(E.exposure(img(320, 200, x => (x > 100 && x < 140 ? [255, 255, 255] : [40, 40, 40]))) <= -0.5, 'blown highlights are never called too dark')
const evs = ['-2.0', '-1.7', '-1.3', '-1.0', '-0.7', '-0.3', '0', '+0.3', '+0.7', '+1.0', '+1.3', '+1.7', '+2.0'], isos = ['Auto', '100', '200', '400', '800', '1600', '3200']
for (const [options, start, iso] of [[evs, 6, false], [isos, 2, true]]) {
  for (const scene of [-1.6, -0.5, 1.2]) { // how far off the scene is at the starting value
    const at = i => (iso ? Math.log2(parseFloat(options[i]) / parseFloat(options[start])) : parseFloat(options[i]) - parseFloat(options[start]))
    const next = E.nearest(options, start, E.exposure(lit(scene)), iso)
    assert.ok(options[next] !== 'Auto' && Math.abs(E.exposure(lit(scene + at(next)))) <= (iso ? 0.55 : 0.2), `${iso ? 'ISO' : 'EV'} for a scene ${scene} off: ${options[next]}`)
  }
}
assert.equal(E.nearest(evs, 12, 3, false), 12, 'stays at the end of the range')
assert.equal(E.nearest(isos, 0, 1, true), 0, 'Auto ISO is left alone')
const fine = img(256, 64, (x, y) => [x, x, Math.min(255, x + (y % 2))])
const before = Uint8ClampedArray.from(fine.data), after = E.apply(fine).data
assert.ok(after.every((v, i) => Math.abs(v - before[i]) <= 12), 'a well-exposed image stays close')

// main.js keeps a downloaded face swap model only if it has the fingerprint browser-inswapper checks before using it.
const lib = fs.readFileSync(path.join(__dirname, 'node_modules/browser-inswapper/src/models.ts'), 'utf8'), main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
for (const k of ['swapperFp16', 'swapperFp32', 'arcface']) assert.ok(main.includes(new RegExp(`${k}: '([0-9a-f]{64})'`).exec(lib)[1]), `main.js has ${k}'s fingerprint`)

// Versioning: the version in package.json has its dated entry in the changelog (the release notes are cut from it).
assert.match(fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## \\[${require('./package.json').version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d\\d-\\d\\d$`, 'm'), 'CHANGELOG.md has an entry for this version')

console.log('ok')
