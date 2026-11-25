// Events. Each event keeps its own settings, photo folder and session log; settings.json keeps only the per-machine keys.
const { app } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MACHINE = ['cameraId', 'micId', 'mirror', 'outputDir', 'printer', 'pin', 'kiosk', 'autoUpdate']
const file = () => path.join(app.getPath('userData'), 'events.json')
const safe = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Event'
const exists = p => fs.stat(p).then(() => true, () => false)
const today = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const machine = s => Object.fromEntries(MACHINE.map(k => [k, s[k]]))
const eventKeys = s => Object.fromEntries(Object.entries(s).filter(([k]) => !MACHINE.includes(k) && !['eventId', 'swapReady'].includes(k)))
const newEvent = (s, folder = null) => ({ id: randomUUID(), createdAt: new Date().toISOString(), folder, settings: eventKeys(s) })

// No events.json is a first run. A damaged one is moved aside (for support) and the booth starts a fresh list, rather
// than never opening; the photos stay in their folders. Any other read error is thrown, so it can't wipe the list.
const load = () => fs.readFile(file(), 'utf8').then(JSON.parse).catch(async e => {
  if (e instanceof SyntaxError) await fs.rename(file(), `${file()}.damaged-${Date.now()}`)
  else if (e.code !== 'ENOENT') throw e
  return null
})
// Flushed to disk and then renamed, so a power cut mid-write can't leave a half-written events.json behind.
async function save(store) {
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file() + '.tmp', JSON.stringify(store, null, 2), { flush: true })
  await fs.rename(file() + '.tmp', file())
}
// Changes to events.json run one at a time, so two IPC calls can't both read it and then overwrite each other's change.
let last = Promise.resolve()
const serial = fn => (...args) => (last = last.then(() => fn(...args), () => fn(...args)))
const find = (store, id) => store.events.find(e => e.id === id) || store.events.find(e => e.id === store.activeId) || store.events[0]

// base is defaults + settings.json. On first run, or after upgrading from the single-event version, its event keys become
// the first event, which keeps the old <outputDir>/<eventName> folder if it already has photos.
const merge = serial(async base => {
  let store = await load()
  if (!store?.events?.length) {
    const legacy = safe(base.eventName)
    const e = newEvent(base, (await exists(path.join(base.outputDir, legacy))) ? legacy : null)
    store = { activeId: e.id, events: [e] }
    await save(store)
  }
  const e = find(store)
  return { ...base, ...e.settings, eventId: e.id }
})

// Saves the event keys of s to the event they were loaded from (s.eventId).
const update = serial(async s => {
  const store = await load()
  const e = find(store, s.eventId)
  e.settings = { ...e.settings, ...eventKeys(s) }
  await save(store)
})

// A new event starts as a copy of the current one, so the layout, timing and printing carry over.
const create = serial(async s => {
  const store = await load()
  const e = newEvent({ ...s, eventName: 'New event' })
  store.events.push(e)
  store.activeId = e.id
  await save(store)
})

const activate = serial(async id => {
  const store = await load()
  if (!store.events.some(e => e.id === id)) return
  store.activeId = id
  await save(store)
})

// Removes the event from the list only; its photos stay in their folder. The last event can't be removed.
const remove = serial(async id => {
  const store = await load()
  if (store.events.length < 2) return
  store.events = store.events.filter(e => e.id !== id)
  if (store.activeId === id) store.activeId = store.events[0].id
  await save(store)
})

// The folder is named when the event saves its first photo, so renaming a fresh event is free
// and renaming it later never splits its photos. With assign=false an unnamed event gets outputDir.
const dir = serial(async (s, assign = true) => {
  const store = await load()
  const e = find(store, s.eventId)
  if (!e.folder) {
    if (!assign) return s.outputDir
    const base = `${today()} ${safe(s.eventName)}`
    let name = base
    for (let n = 2; store.events.some(x => x.folder === name) || (await exists(path.join(s.outputDir, name))); n++) name = `${base} (${n})`
    e.folder = name
    await save(store)
  }
  return path.join(s.outputDir, e.folder)
})

// One JSON line per session or print. Append-only, so a crash loses at most the line being written.
async function log(s, entry) {
  const d = await dir(s)
  await fs.mkdir(d, { recursive: true })
  await fs.appendFile(path.join(d, 'sessions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

async function list(outputDir) {
  const store = await load()
  const events = await Promise.all(store.events.map(async e => {
    const text = e.folder ? await fs.readFile(path.join(outputDir, e.folder, 'sessions.jsonl'), 'utf8').catch(() => '') : ''
    const lines = text.split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }) // skips a line cut short by a crash
    const count = type => lines.filter(l => l.type === type).length
    return { id: e.id, eventName: e.settings.eventName, sessions: count('session'), prints: count('print') }
  }))
  return { activeId: find(store).id, events }
}

module.exports = { machine, merge, update, create, activate, remove, dir, log, list }
