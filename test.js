// Self-check for layout.js and the bundled templates. Run: npm test
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./layout.js')

const near = (a, b) => Object.keys(b).forEach(k => assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${k}: ${a[k]} != ${b[k]}`))

assert.equal(L.color('#FFFFFFFF'), 'rgba(255,255,255,1)')
assert.equal(L.color('#80FF0000'), 'rgba(255,0,0,0.502)')
assert.equal(L.color('00FF00'), 'rgba(0,255,0,1)')
assert.equal(L.color('red', 'x'), 'x')

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
assert.equal(t.elements.length, 2)
assert.equal(t.elements[0].photo, 1)
assert.equal(t.elements[0].opacity, 0.5)
assert.equal(t.elements[0].stroke.width, 4)
assert.equal(t.dpi, 300)
assert.throws(() => L.fromNodes({}, [{ tag: 'Text', attrs: {} }]), /no photo slots/)

// Bundled templates: parse (test-only regex; the app uses DOMParser) and stay inside the canvas.
const attrs = s => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
for (const d of fs.readdirSync(path.join(__dirname, 'templates'))) {
  const xml = fs.readFileSync(path.join(__dirname, 'templates', d, 'template.xml'), 'utf8')
  const kids = [...xml.matchAll(/<(\w+)\s([^>]*?)\/>/g)].map(m => ({ tag: m[1], attrs: attrs(m[2]) }))
  const tpl = L.fromNodes(attrs(/<Template\s([^>]*)>/.exec(xml)[1]), kids)
  for (const e of tpl.elements) {
    assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= tpl.width && e.y + e.h <= tpl.height, `${d}: ${e.name} out of bounds`)
  }
}

console.log('ok')
