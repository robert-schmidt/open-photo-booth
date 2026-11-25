/* global booth, $, fill, form, toast, sleep, current, settings: writable, applySettings, openSettings, saveForm, AI, Swap, Setup */
// The event picker in the settings. Events live in events.js (main process).
const Events = (() => {
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  async function fillSettings() {
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default')
    fill(form.micId, [['', 'Default microphone'], ...mics.map((d, i) => [d.deviceId, d.label || `Microphone ${i + 1}`])])
    const { events } = await booth.listEvents()
    fill($('#eventId'), events.map(e => [e.id, e.eventName]))
    $('#eventId').value = settings.eventId
    $('#removeEvent').disabled = events.length < 2
    const e = events.find(e => e.id === settings.eventId)
    $('#eventStats').textContent = e ? `${count(e.sessions, 'session')} · ${count(e.prints, 'print')}` : ''
  }

  // Edits made to the event being left are kept, as if Save had been pressed first. The last guest's photos finish
  // saving and sharing first (a styled video message takes as long as the video), so they stay with their own event.
  async function go(action) {
    try {
      const last = Promise.allSettled([current?.saved, current?.clip])
      if (await Promise.race([last.then(() => false), sleep(300).then(() => true)])) {
        toast("Finishing the last guest's photos first…")
        await last
      }
      await saveForm()
      settings = await action()
      await applySettings()
      await openSettings()
    } catch (e) {
      toast(`Could not change event: ${e.message}`)
    }
  }

  for (const b of document.querySelectorAll('[data-choose]')) b.onclick = async () => { form[b.dataset.choose].value = (await booth.chooseFolder()) || form[b.dataset.choose].value; Swap.status() }
  for (const b of document.querySelectorAll('[data-clear]')) b.onclick = () => { form[b.dataset.clear].value = ''; Swap.status() }
  $('#eventId').onchange = e => go(() => booth.switchEvent(e.target.value))
  // The guide sets the new event up.
  $('#newEvent').onclick = () => go(booth.newEvent).then(async () => {
    $('#settings').close()
    const more = await Setup.open()
    await applySettings()
    if (more) await openSettings()
  })
  $('#removeEvent').onclick = async () => {
    if (await booth.confirm(`Remove "${settings.eventName}" from the list? Its photos stay in their folder.`)) go(() => booth.removeEvent(settings.eventId))
  }

  // After the camera has started; during the setup guide there are no settings yet, so it waits.
  const warm = () => (settings ? (AI.warm(), Swap.install().then(Swap.warm)) : setTimeout(warm, 1500))
  setTimeout(warm, 1500)
  return { fillSettings }
})()
