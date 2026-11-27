// Photos to guests' phones over the local network. A small web server on this computer hands a session's photo or
// clip to whoever has its link (the QR code on the booth's screen). Nothing goes online, and nothing else on this
// computer can be reached through it: a link names a random key, never a file. Phones must be on the booth's network.
const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { say } = require('./i18n.js')

const TYPES = { '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm' }
const HEAD = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }
// The links and the server's port are also kept in a file (keep), so a QR code scanned before the app was restarted
// still opens its photo afterwards, as long as the computer has the same address on the network.
const photos = new Map() // key -> { file, event }
let server = null // a promise of the listening server, once sharing is first used
let port = 0, store = null, lang = 'en' // the event's language for guests: the phone's page speaks it too

// This computer's address on the local network: a private IPv4 one (Wi-Fi or cable) if there is one.
function address() {
  const all = Object.values(os.networkInterfaces()).flat().filter(a => a?.family === 'IPv4' && !a.internal)
  return (all.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) || all[0])?.address || ''
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const page = (title, body, refresh) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-content:center;justify-items:center;gap:16px;padding:20px;box-sizing:border-box;background:#111;color:#fff;font:1.1rem system-ui,sans-serif;text-align:center}img,video{max-width:100%;max-height:72vh;border-radius:8px}a{padding:.8em 2em;border-radius:999px;background:#ff4f6d;color:#fff;text-decoration:none;font-weight:600}p{margin:0;color:#bbb}</style>
${body}`

// /p/<key> is the page a QR code opens; /f/<key> is the photo or clip itself. Before the guest has tapped Done the
// page says so and looks again every few seconds. Clips answer byte ranges, which iPhones need to play a video.
function handle(req, res) {
  const m = /^\/(p|f)\/([a-z0-9]{12})$/.exec(req.url.split('?')[0]), photo = m && photos.get(m[2])
  const end = (status, head = {}, body) => { res.writeHead(status, { ...HEAD, ...head }); res.end(body) }, t = text => esc(say(lang, text))
  if (!m || !['GET', 'HEAD'].includes(req.method) || (m[1] === 'f' && !photo)) return end(404)
  if (m[1] === 'p') {
    const src = `/f/${m[2]}`, clip = photo && path.extname(photo.file) !== '.jpg'
    return end(200, { 'content-type': 'text/html; charset=utf-8' }, !photo ? page(say(lang, 'Your photo'), `<p>${t('Your photo is on its way.')}<br>${t('Tap Done on the booth, and it shows up here.')}</p>`, true)
      : page(photo.event, `${clip ? `<video src="${src}" controls playsinline loop></video>` : `<img src="${src}" alt="${t('Your photo')}">`}
<a href="${src}" download="${esc(path.basename(photo.file))}">${t('Save')}</a><p>${clip ? '' : `${t('Or press and hold the picture to save it.')}<br>`}${esc(photo.event)}</p>`))
  }
  fs.stat(photo.file, (err, st) => {
    if (err) return end(404)
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''), head = { 'content-type': TYPES[path.extname(photo.file)], 'accept-ranges': 'bytes' }
    let from = 0, to = st.size - 1
    if (range?.[1]) { from = +range[1]; if (range[2]) to = Math.min(+range[2], to) } else if (range?.[2]) from = Math.max(0, st.size - range[2])
    if (from > to) return end(416, { 'content-range': `bytes */${st.size}` })
    res.writeHead(range ? 206 : 200, { ...HEAD, ...head, 'content-length': to - from + 1, ...(range ? { 'content-range': `bytes ${from}-${to}/${st.size}` } : {}) })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(photo.file, { start: from, end: to }).on('error', () => res.destroy()).pipe(res)
  })
}

// Names the file the links are kept in between runs, and reads what the last run left there.
function keep(file) {
  store = file
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    port = Number.isInteger(s.port) ? s.port : 0
    for (const [key, p] of s.photos) if (/^[a-z0-9]{12}$/.test(key) && TYPES[path.extname(String(p.file))]) photos.set(key, { file: p.file, event: String(p.event) })
  } catch {} // no file yet, or not one of ours: start empty
}
const save = async () => { if (store) await fs.promises.writeFile(store, JSON.stringify({ port, photos: [...photos] })).catch(e => console.warn('Sharing:', e.message)) }

// Where a key's page is: http://<this computer>:<port>/p/ (the key goes on the end), or '' when the computer isn't
// on a network. Starts the server at first use: on the port it had last time if that's free, else on one the system picks.
async function base(speak = 'en') {
  lang = speak
  const listen = p => new Promise((resolve, reject) => { const s = http.createServer(handle); s.once('error', reject).listen(p, () => resolve(s)) })
  server ??= listen(port).catch(() => listen(0)).then(s => { if (port !== s.address().port) { port = s.address().port; save() } return s })
  const s = await server.catch(e => { server = null; console.warn('Sharing:', e.message) }), ip = address()
  return s && ip ? `http://${ip}:${s.address().port}/p/` : ''
}

// A finished photo or clip, by its key. Only main.js calls this, with a file it has checked is in the photos folder.
function add(key, file, event) {
  photos.set(key, { file, event })
  if (photos.size > 5000) photos.delete(photos.keys().next().value)
  return save()
}

function stop() {
  server?.then(s => { s.close(); s.closeAllConnections() }, () => {})
  server = null
  port = 0
  photos.clear()
  if (store) fs.rm(store, { force: true }, () => {})
}

module.exports = { keep, base, add, stop }
