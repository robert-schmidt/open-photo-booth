/* global booth, $, screen, showSetting */
// Updates: the version and any new one, in the settings. A new version is announced (here, on a line under the
// settings' sections and as a dot on the ⚙️) and the operator starts it. With "Install new versions automatically"
// on, it is downloaded by itself and installs once the booth has sat untouched on its start screen for 15 minutes
// (or when the operator quits), so it never interrupts a guest.
const Update = (() => {
  const QUIET = 15 * 60000, APP = document.title
  const TEXT = {
    on: () => `${APP} looks for a new version every few hours.`,
    checking: () => 'Looking for a new version…',
    latest: () => `${APP} is up to date.`,
    available: s => `${APP} ${s.version} is out. Updating downloads it, installs it and restarts the app: about a minute, best when no guests are at the booth.`,
    downloading: s => `Downloading ${APP} ${s.version}: ${s.percent}%`,
    ready: s => `${APP} ${s.version} is ready. It installs after 15 quiet minutes on the start screen, or when you quit.`,
    failed: s => `${s.version ? "Couldn't update just now." : "Couldn't look for a new version just now: is the booth online?"} ${APP} tries again in a few hours.`,
  }
  let status = {}, touched = Date.now()
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { touched = Date.now() }, true)
  function set(s) {
    status = { ...status, ...s }
    const news = status.state === 'available'
    $('#version').textContent = `${APP} ${status.current ?? ''}`
    $('#updateStatus').textContent = TEXT[status.state]?.(status) ?? ''
    $('#updateNow').hidden = !news && status.state !== 'ready'
    $('#updateNow').textContent = news ? `Update to ${status.version}` : 'Restart and update'
    $('#updateCheck').hidden = !['on', 'latest', 'failed'].includes(status.state)
    $('#updateNews').hidden = !news
    $('#updateNews').textContent = `⬇ ${APP} ${status.version} is out`
    $('#corner').classList.toggle('news', news)
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
  $('#updateCheck').onclick = () => booth.update.check()
  $('#updateNews').onclick = () => { showSetting($('#updateNow')); $('#updateNow').scrollIntoView({ block: 'center' }) }
  return { set, tick }
})()
