/* global booth, $, settings, tr, show */
// Guests' details (Settings → Guest details): a short form before or after a session, asking for a name, an email
// address and one question of the host's. What a guest sends goes to guests.csv in the event's folder (events.js);
// an email address only together with the tick under it. Guests can always skip it.
const Guests = (() => {
  const form = $('#askForm'), keys = $('#askKeys'), name = $('#askName'), email = $('#askEmail'), agree = $('#askAgree'), typed = $('#askAnswer')
  const WAIT = 60000 // nobody at the form for this long: the booth goes back to its start screen
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/ // the same test events.js makes before it keeps one
  let field = null, shift = false, done = null, timer, choice = '', answered = ''

  // The on-screen keyboard: a booth usually has a touchscreen and nothing else. It types at the end of the text field
  // in use. ponytail: letters, digits and what an email address needs; no accented letters (a keyboard plugged into
  // the booth types them), add a second layer when hosts ask.
  for (const row of ['1234567890', 'qwertyuiop', 'asdfghjkl', '⇧zxcvbnm⌫', '@.-_ ']) {
    const r = document.createElement('div')
    for (const k of row) r.append(Object.assign(document.createElement('button'), { type: 'button', textContent: k === ' ' ? '␣' : k, tabIndex: -1 }))
    keys.append(r)
  }
  keys.addEventListener('pointerdown', e => {
    e.preventDefault() // the text field keeps the focus
    const k = e.target.tagName === 'BUTTON' && (e.target.textContent === '␣' ? ' ' : e.target.textContent)
    if (!k || !field) return
    if (k === '⇧') shift = !shift
    else if (k === '⌫') field.value = field.value.slice(0, -1)
    else { field.value += shift ? k.toUpperCase() : k; shift = false }
    keys.classList.toggle('shift', shift)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  form.addEventListener('focusin', e => { if (e.target.matches('input:not([type=checkbox])')) field = e.target })

  const poke = () => { clearTimeout(timer); timer = setTimeout(() => done?.(false), WAIT) }
  for (const ev of ['pointerdown', 'input']) form.addEventListener(ev, () => { poke(); for (const el of form.querySelectorAll('.need')) el.classList.remove('need') })

  form.onsubmit = e => {
    e.preventDefault()
    const g = { name: name.value.trim(), email: email.value.trim(), consent: agree.checked, answer: choice || typed.value.trim() }
    // An address that isn't one, or one without the tick: the field in question lights up, nothing is sent.
    if (g.email && !EMAIL.test(g.email)) return email.classList.add('need')
    if (g.email && !g.consent) return agree.parentElement.classList.add('need')
    if (g.name || g.email || g.answer) booth.saveGuest(g).catch(err => console.warn('Guest details:', err.message))
    answered = g.answer
    done(true)
  }
  $('#askSkip').onclick = () => done(true)

  // Shows the form. Resolves true when the guest sent or skipped it, false when they walked away; the start screen is
  // back either way.
  function ask() {
    const choices = settings.formChoices.split(',').map(s => s.trim()).filter(Boolean)
    form.reset()
    choice = answered = ''
    shift = false
    keys.classList.remove('shift')
    name.parentElement.hidden = !settings.formName
    email.parentElement.hidden = agree.parentElement.hidden = !settings.formEmail
    $('#askAgreeText').textContent = tr(settings.formConsent)
    $('#askQuestion').textContent = settings.formQuestion
    $('#askQuestion').hidden = !settings.formQuestion
    typed.hidden = !settings.formQuestion || choices.length > 0
    $('#askChoices').replaceChildren(...(settings.formQuestion ? choices : []).map(c => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: c, ariaPressed: 'false' })
      b.onclick = () => { choice = c; for (const o of $('#askChoices').children) o.ariaPressed = String(o === b) }
      return b
    }))
    field = [name, email, typed].find(i => !i.hidden && !i.parentElement.hidden) || null
    keys.hidden = !field
    show('guest')
    field?.focus()
    poke()
    return new Promise(resolve => { done = ok => { clearTimeout(timer); done = null; show('attract'); resolve(ok) } })
  }

  // answer(): what this guest answered (for whoever wants to act on it), until the next guest is asked.
  return { ask, answer: () => answered }
})()
