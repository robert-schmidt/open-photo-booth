// Photos to guests' phones over the local network. A small web server on this computer hands a session's photo or
// clip to whoever has its link (the QR code on the booth's screen). Nothing goes online, and nothing else on this
// computer can be reached through it: a link names a random key, never a file. Phones must be on the booth's network.
const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const TYPES = { '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm' }
const HEAD = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }
// ponytail: kept in memory, so links stop working when the app closes; write them to disk if guests ask the day after.
const photos = new Map() // key -> { file, event }
let server = null // a promise of the listening server, once sharing is first used

// This computer's address on the local network: a private IPv4 one (Wi-Fi or cable) if there is one.
function address() {
  const all = Object.values(os.networkInterfaces()).flat().filter(a => a?.family === 'IPv4' && !a.internal)
  return (all.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) || all[0])?.address || ''
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const page = (title, body, refresh) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-content:center;justify-items:center;gap:16px;padding:20px;box-sizing:border-box;background:#111;color:#fff;font:1.1rem system-ui,sans-serif;text-align:center}img,video{max-width:100%;max-height:72vh;border-radius:8px}a{padding:.8em 2em;border-radius:999px;background:#ff4f6d;color:#fff;text-decoration:none;font-weight:600}p{margin:0;color:#bbb}</style>
${body}`

// /p/<key> is the page a QR code opens; /f/<key> is the photo or clip itself. Before the guest has tapped Done the
// page says so and looks again every few seconds. Clips answer byte ranges, which iPhones need to play a video.
function handle(req, res) {
  const m = /^\/(p|f)\/([a-z0-9]{12})$/.exec(req.url.split('?')[0]), photo = m && photos.get(m[2])
  const end = (status, head = {}, body) => { res.writeHead(status, { ...HEAD, ...head }); res.end(body) }
  if (!m || !['GET', 'HEAD'].includes(req.method) || (m[1] === 'f' && !photo)) return end(404)
  if (m[1] === 'p') {
    const src = `/f/${m[2]}`, clip = photo && path.extname(photo.file) !== '.jpg'
    return end(200, { 'content-type': 'text/html; charset=utf-8' }, !photo ? page('Your photo', '<p>Your photo is on its way.<br>Tap Done on the booth, and it shows up here.</p>', true)
      : page(photo.event, `${clip ? `<video src="${src}" controls playsinline loop></video>` : `<img src="${src}" alt="Your photo">`}
<a href="${src}" download="${esc(path.basename(photo.file))}">Save</a><p>${clip ? '' : 'Or press and hold the picture to save it.<br>'}${esc(photo.event)}</p>`))
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

// Where a key's page is: http://<this computer>:<port>/p/ (the key goes on the end), or '' when the computer isn't
// on a network. Starts the server at first use, on a port the system picks.
async function base() {
  server ??= new Promise((resolve, reject) => { const s = http.createServer(handle); s.once('error', reject).listen(0, () => resolve(s)) })
  const s = await server.catch(e => { server = null; console.warn('Sharing:', e.message) }), ip = address()
  return s && ip ? `http://${ip}:${s.address().port}/p/` : ''
}

// A finished photo or clip, by its key. Only main.js calls this, with a file it has checked is in the photos folder.
function add(key, file, event) {
  photos.set(key, { file, event })
  if (photos.size > 5000) photos.delete(photos.keys().next().value)
}

function stop() {
  server?.then(s => { s.close(); s.closeAllConnections() }, () => {})
  server = null
  photos.clear()
}

module.exports = { base, add, stop }
