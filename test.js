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

// .cube colour presets: a table that changes nothing leaves a photo as it was, one that swaps red and blue swaps them
// (between its entries too), and text that isn't a full table is refused.
const cubeText = (n, f) => `TITLE "t"\n# a comment\nLUT_3D_SIZE ${n}\nDOMAIN_MIN 0 0 0\n` + Array.from({ length: n ** 3 }, (_, i) => f(i % n / (n - 1), Math.floor(i / n) % n / (n - 1), Math.floor(i / n / n) / (n - 1)).join(' ')).join('\r\n')
const ramp = () => img(64, 64, (x, y) => [x * 4, y * 4, (x * 7 + y * 3) % 256])
const same = E.lut(ramp(), E.cube(cubeText(2, (r, g, b) => [r, g, b]))), swapped = E.lut(ramp(), E.cube(cubeText(5, (r, g, b) => [b, g, r])))
assert.ok(same.data.every((v, i) => Math.abs(v - ramp().data[i]) <= 1), 'an identity table changes nothing')
assert.ok(swapped.data.every((v, i) => Math.abs(v - ramp().data[i % 4 === 0 ? i + 2 : i % 4 === 2 ? i - 2 : i]) <= 1), 'red and blue swapped')
assert.equal(E.cube(cubeText(3, (r, g, b) => [r, g, b]).split('\n').slice(0, -1).join('\n')), null, 'a table with a row missing is refused')
assert.equal(E.cube('hello'), null)

// Photos to phones: a link handed out before the app restarts still opens its photo afterwards (two runs of
// local-share.js, sharing one file).
{
  const { execFileSync } = require('node:child_process'), os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-')), photo = path.join(dir, 'p.jpg'), key = 'abcdefghijkl'
  fs.writeFileSync(photo, 'not really a photo')
  const run = code => execFileSync(process.execPath, ['-e', `(async () => { const S = require(${JSON.stringify(path.join(__dirname, 'local-share.js'))}); S.keep(${JSON.stringify(path.join(dir, 'shares.json'))}); const base = await S.base(); ${code} })()`], { encoding: 'utf8' })
  const first = run(`await S.add('${key}', ${JSON.stringify(photo)}, 'Gala'); console.log(base); process.exit()`).trim()
  if (first) {
    const [again, body] = run(`console.log(base); console.log(await fetch(base.replace('/p/', '/f/') + '${key}').then(r => r.text())); process.exit()`).trim().split('\n')
    assert.equal(again, first, 'the same address after a restart')
    assert.equal(body, 'not really a photo', 'and the photo is still behind its link')
    assert.match(run(`await S.base('de'); console.log(await fetch(base + 'zzzzzzzzzzzz').then(r => r.text())); process.exit()`), /<html lang="de">[^]*Dein Foto ist unterwegs/, "the phone's page speaks the event's language")
  } else console.log('(no network on this computer: sharing after a restart is not checked)')
  fs.writeFileSync(path.join(dir, 'shares.json'), JSON.stringify({ port: 0, photos: [['../../etc', { file: '/etc/passwd', event: 'x' }], [key, { file: '/etc/passwd', event: 'x' }]] }))
  assert.equal(run(`console.log(await fetch(base.replace('/p/', '/f/') + '${key}').then(r => r.status, () => 'no network')); process.exit()`).trim().replace('no network', '404'), '404', 'a links file with other kinds of files in it is not served')
  fs.rmSync(dir, { recursive: true })
}

// Translations (i18n.js): every row has all five languages with the same {placeholders}, and every text the guest
// screens show has a row: the ones marked in index.html, the ones the code passes to tr(), and the names of the
// modes, looks and backdrops (which reach tr() through a variable, so they are listed here).
{
  for (const f of fs.readdirSync(__dirname)) if (/^i18n-.+\.js$/.test(f)) require(`./${f}`) // a build with screens of its own adds its rows to the table
  const { LANGS, TEXTS, say } = require('./i18n.js'), holes = s => (s.match(/\{\w+\}/g) || []).sort().join()
  for (const [en, row] of Object.entries(TEXTS)) {
    assert.equal(row.length, Object.keys(LANGS).length - 1, `"${en}" has every language`)
    for (const t of row) assert.ok(t && holes(t) === holes(en), `"${en}" → "${t}" keeps its placeholders`)
  }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), used = ['Touch to start', 'Photos', 'Boomerang', 'Video message',
    'Boomerang! Get ready to move…', 'Video message: get ready…', 'Black & white', 'Sepia', 'Warm', 'Vivid', 'Faded', 'Comic', 'Sketch', 'Blur', 'Studio gray', 'Studio white', 'Night', 'Sunset']
  for (const m of html.matchAll(/<\w+[^>]*\sdata-tr(?=[\s>])[^>]*>([^<]+)</g)) used.push(m[1])
  for (const m of html.matchAll(/aria-label="([^"]+)"[^>]*\sdata-tr-label/g)) used.push(m[1])
  for (const f of ['app.js', 'capture.js', 'review.js']) {
    const js = fs.readFileSync(path.join(__dirname, f), 'utf8')
    for (let at = js.indexOf('tr('); at >= 0; at = js.indexOf('tr(', at + 1)) {
      if (/[\w.$]/.test(js[at - 1])) continue // filter(, attr(…
      let end = at + 3
      for (let depth = 1; depth; end++) depth += js[end] === '(' ? 1 : js[end] === ')' ? -1 : 0
      for (const m of js.slice(at, end).matchAll(/'([^']+)'|"([^"]+)"/g)) used.push(m[1] ?? m[2])
    }
  }
  assert.ok(used.length > 60, 'the guest texts were found')
  for (const t of used) assert.ok(TEXTS[/^[^\p{L}{]*(.*)$/su.exec(t)[1]], `"${t}" is translated`)
  assert.equal(say('de', '↻ Retake photo {n}', { n: 2 }), '↻ Foto 2 neu aufnehmen')
  assert.equal(say('ro', 'Photo {n} of {total}', { n: 1, total: 3 }), 'Fotografia 1 din 3')
  assert.equal(say('en', '📱 Share'), '📱 Share')
  assert.equal(say('fr', 'Our wedding!'), 'Our wedding!', "a text of the operator's own stays as written")
  assert.equal(say('xx', 'Done'), 'Done')
}

// Guests' details (events.js): an email address is kept only with the tick and only if it is one, with the sentence
// agreed to; nothing a guest types can break the table or run as a formula in a spreadsheet.
{
  const { guestRow } = require('./events.js'), s = { formConsent: 'I agree.', formQuestion: 'Whose side?' }, at = new Date(0)
  assert.equal(guestRow(s, { name: 'Ana', email: 'ana@x.ro', consent: true, answer: 'Bride' }, at), '"1970-01-01T00:00:00.000Z","Ana","ana@x.ro","I agree.","Whose side?","Bride"')
  assert.equal(guestRow(s, { name: 'Ana', email: 'ana@x.ro', consent: false }, at), '"1970-01-01T00:00:00.000Z","Ana","","","",""', 'no tick, no address')
  assert.equal(guestRow(s, { email: 'not an address', consent: true }, at).split(',')[2], '""')
  assert.equal(guestRow(s, { name: '=HYPERLINK("http://x")', answer: 'a\r\n"b",c', consent: 'yes', email: 'a@b.c' }, at), '"1970-01-01T00:00:00.000Z","\'=HYPERLINK(""http://x"")","","","Whose side?","a ""b"",c"')
}

// Cameras through libgphoto2 (camera-helper/gphoto.cpp), where `npm run build:gphoto` and build:camera have been run:
// the helper finds libgphoto2's virtual camera, opens it, reads its settings and fetches the photo it "takes".
{
  const build = path.join(__dirname, 'camera-helper', 'build'), helper = path.join(build, 'mac', 'bin', 'camera-helper'), virtual = path.join(build, 'gphoto', 'test-iolibs')
  if (fs.existsSync(path.join(virtual, 'vusb.so')) && fs.existsSync(path.join(build, 'mac', 'bin', 'gphoto'))) {
    const { spawnSync } = require('node:child_process'), os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphoto-')), card = path.join(dir, 'card'), photo = path.join(__dirname, 'test', 'portrait.jpg')
    fs.mkdirSync(card)
    fs.copyFileSync(photo, path.join(card, 'one.jpg'))
    const out = spawnSync(helper, ['probe', '--dir', dir], { encoding: 'utf8', env: { ...process.env, IOLIBS: virtual, VCAMERADIR: card } }).stderr // probe talks to people, on stderr
    assert.match(out, /Found: Nikon DSC D750 \(gphoto:Nikon DSC D750\)/, out)
    assert.match(out, /Opened Nikon DSC D750, battery: 50%/, out)
    assert.match(out, /shutter: 0\.0100s \(9 values\)[^]*aperture: f\/2\.8[^]*ev: 0 \(13 values\)/, out)
    assert.ok(fs.readFileSync(path.join(dir, 'gphoto-1.jpg')).equals(fs.readFileSync(photo)), 'the photo fetched from the camera is the one it took')
    fs.rmSync(dir, { recursive: true })
    assert.ok(!fs.existsSync(path.join(build, 'mac', 'bin', 'gphoto', 'iolibs', 'vusb.so')), 'the virtual camera is not in what ships')
  } else console.log('(libgphoto2 is not built here: its camera backend is not checked)')
}

// main.js keeps a downloaded face swap model only if it has the fingerprint browser-inswapper checks before using it.
const lib = fs.readFileSync(path.join(__dirname, 'node_modules/browser-inswapper/src/models.ts'), 'utf8'), main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
for (const k of ['swapperFp16', 'swapperFp32', 'arcface']) assert.ok(main.includes(new RegExp(`${k}: '([0-9a-f]{64})'`).exec(lib)[1]), `main.js has ${k}'s fingerprint`)

// Versioning: the version in package.json has its dated entry in the changelog (the release notes are cut from it).
assert.match(fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## \\[${require('./package.json').version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d\\d-\\d\\d$`, 'm'), 'CHANGELOG.md has an entry for this version')

console.log('ok')
