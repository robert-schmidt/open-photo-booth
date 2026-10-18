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

assert.equal(L.fillText('{event} – {date} {nope}', { event: 'Gala', date: 'today' }), 'Gala – today {nope}')

const t = L.fromNodes({ Width: '600', Height: '1800' }, [
  { tag: 'Photo', attrs: { PhotoNumber: '2', ZIndex: '1' } },
  { tag: 'Photo', attrs: { PhotoNumber: '1', ZIndex: '0', Opacity: '50', Thickness: '4' } },
  { tag: 'QRCode', attrs: {} },
])
assert.equal(t.shots, 2)
assert.deepEqual(t.elements.map(e => e.photo), [1, 2])
assert.equal(t.elements[0].opacity, 50)
assert.equal(t.elements[0].strokeWidth, 4)
assert.equal(t.dpi, 300)
assert.throws(() => L.fromNodes({}, [{ tag: 'Text', attrs: {} }]), /no photo slots/)

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

console.log('ok')
