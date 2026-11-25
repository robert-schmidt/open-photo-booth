/* global booth, $, screen */
// Updates: the version and any update, in the settings. A downloaded update installs by itself once the booth has sat
// untouched on its start screen for 15 minutes (or when the operator quits), so it never interrupts a guest.
const Update = (() => {
  const QUIET = 15 * 60000, APP = document.title
  const TEXT = {
    on: () => `${APP} checks for updates every few hours.`,
    checking: () => 'Checking for updates…',
    latest: () => `${APP} is up to date.`,
    downloading: s => `Downloading ${APP} ${s.version}: ${s.percent}%`,
    ready: s => `${APP} ${s.version} is ready. It installs after 15 quiet minutes on the start screen, or when you quit.`,
    failed: () => `Couldn't update just now. ${APP} tries again in a few hours.`,
  }
  let status = {}, touched = Date.now()
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { touched = Date.now() }, true)
  function set(s) {
    status = { ...status, ...s }
    $('#version').textContent = `${APP} ${status.current ?? ''}`
    $('#updateStatus').textContent = TEXT[status.state]?.(status) ?? ''
    $('#updateNow').hidden = status.state !== 'ready'
  }
  // Installs, and says so, when an update is ready and the booth is idle.
  function tick(now = Date.now()) {
    const due = status.state === 'ready' && screen() === 'attract' && !document.querySelector('dialog[open]') && now - touched > QUIET
    if (due) booth.update.install()
    return due
  }
  booth.update.status().then(set)
  booth.onUpdate(set)
  setInterval(tick, 60000)
  $('#updateNow').onclick = () => booth.update.install()
  return { set, tick }
})()
