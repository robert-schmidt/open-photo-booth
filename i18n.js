// The guests' screens in other languages (Settings → Event → Guests' language). The English text is the key: a text
// without a row here, or a language without one, shows in English. The operator's settings stay in English.
// Loaded by the page (LANGS, tr, translatePage) and by local-share.js for the page on a guest's phone (say). A build
// with guest screens of its own adds their rows to TEXTS from a file named i18n-<something>.js (test.js reads those too).
const LANGS = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', ro: 'Română' }
// English: [German, French, Spanish, Italian, Romanian], in LANGS' order. Symbols in front of a text (📱, ↻) aren't
// part of its key: say() keeps them. {n} and the like are filled in by say().
const TEXTS = {
  // Start screen and the session
  'Touch to start': ['Zum Starten tippen', 'Touchez pour commencer', 'Toca para empezar', 'Tocca per iniziare', 'Atinge pentru a începe'],
  'Photos': ['Fotos', 'Photos', 'Fotos', 'Foto', 'Fotografii'],
  'Boomerang': ['Boomerang', 'Boomerang', 'Boomerang', 'Boomerang', 'Boomerang'],
  'Video message': ['Videobotschaft', 'Message vidéo', 'Mensaje de vídeo', 'Videomessaggio', 'Mesaj video'],
  'Photo {n} of {total}': ['Foto {n} von {total}', 'Photo {n} sur {total}', 'Foto {n} de {total}', 'Foto {n} di {total}', 'Fotografia {n} din {total}'],
  'Photo {n}, take two': ['Foto {n}, zweiter Versuch', 'Photo {n}, deuxième prise', 'Foto {n}, segunda toma', 'Foto {n}, secondo scatto', 'Fotografia {n}, a doua încercare'],
  'Boomerang! Get ready to move…': ['Boomerang! Gleich bewegen…', 'Boomerang ! Préparez-vous à bouger…', '¡Boomerang! Prepárate para moverte…', 'Boomerang! Preparati a muoverti…', 'Boomerang! Pregătește-te de mișcare…'],
  'Move!': ['Bewegen!', 'Bougez !', '¡Muévete!', 'Muoviti!', 'Mișcă-te!'],
  'Making your boomerang…': ['Dein Boomerang entsteht…', 'Création de votre boomerang…', 'Creando tu boomerang…', 'Sto creando il tuo boomerang…', 'Se creează boomerangul tău…'],
  'Video message: get ready…': ['Videobotschaft: mach dich bereit…', 'Message vidéo : préparez-vous…', 'Mensaje de vídeo: prepárate…', 'Videomessaggio: preparati…', 'Mesaj video: pregătește-te…'],
  'Recording': ['Aufnahme', 'Enregistrement', 'Grabando', 'Registrazione', 'Se înregistrează'],
  'Stop': ['Stopp', 'Arrêter', 'Detener', 'Stop', 'Stop'],
  'No microphone found, so this video has no sound.': ['Kein Mikrofon gefunden: Dieses Video hat keinen Ton.', 'Aucun micro trouvé : cette vidéo n’a pas de son.', 'No se encontró ningún micrófono: este vídeo no tiene sonido.', 'Nessun microfono trovato: questo video è senza audio.', 'Nu s-a găsit niciun microfon: videoclipul nu are sunet.'],
  'Camera is starting, try again in a moment.': ['Die Kamera startet, versuch es gleich noch einmal.', 'La caméra démarre, réessayez dans un instant.', 'La cámara se está iniciando, inténtalo de nuevo en un momento.', 'La fotocamera si sta avviando, riprova tra un attimo.', 'Camera pornește, încearcă din nou într-o clipă.'],
  'Printing…': ['Wird gedruckt…', 'Impression…', 'Imprimiendo…', 'Stampa in corso…', 'Se tipărește…'],
  // Review screen
  'Your photos': ['Deine Fotos', 'Vos photos', 'Tus fotos', 'Le tue foto', 'Fotografiile tale'],
  'Your boomerang': ['Dein Boomerang', 'Votre boomerang', 'Tu boomerang', 'Il tuo boomerang', 'Boomerangul tău'],
  'Your video': ['Dein Video', 'Votre vidéo', 'Tu vídeo', 'Il tuo video', 'Videoclipul tău'],
  'Skip': ['Überspringen', 'Passer', 'Omitir', 'Salta', 'Sari peste'],
  'Edit all photos': ['Alle Fotos bearbeiten', 'Modifier toutes les photos', 'Editar todas las fotos', 'Modifica tutte le foto', 'Editează toate fotografiile'],
  'Tap a photo to edit or retake just that one.': ['Tippe auf ein Foto, um nur dieses zu bearbeiten oder neu aufzunehmen.', 'Touchez une photo pour modifier ou reprendre seulement celle-ci.', 'Toca una foto para editar o repetir solo esa.', 'Tocca una foto per modificare o rifare solo quella.', 'Atinge o fotografie ca să o editezi sau să o refaci doar pe aceea.'],
  'Tap a photo to edit just that one.': ['Tippe auf ein Foto, um nur dieses zu bearbeiten.', 'Touchez une photo pour modifier seulement celle-ci.', 'Toca una foto para editar solo esa.', 'Tocca una foto per modificare solo quella.', 'Atinge o fotografie ca să o editezi doar pe aceea.'],
  'Retake': ['Neu aufnehmen', 'Reprendre', 'Repetir', 'Rifai', 'Refă'],
  'Retake photo {n}': ['Foto {n} neu aufnehmen', 'Reprendre la photo {n}', 'Repetir la foto {n}', 'Rifai la foto {n}', 'Refă fotografia {n}'],
  'Look': ['Look', 'Style', 'Estilo', 'Stile', 'Stil'],
  'Look for photo {n}': ['Look für Foto {n}', 'Style de la photo {n}', 'Estilo de la foto {n}', 'Stile della foto {n}', 'Stil pentru fotografia {n}'],
  'Look for all photos': ['Look für alle Fotos', 'Style de toutes les photos', 'Estilo de todas las fotos', 'Stile di tutte le foto', 'Stil pentru toate fotografiile'],
  'Original': ['Original', 'Original', 'Original', 'Originale', 'Original'],
  'Black & white': ['Schwarz-Weiß', 'Noir et blanc', 'Blanco y negro', 'Bianco e nero', 'Alb-negru'],
  'Sepia': ['Sepia', 'Sépia', 'Sepia', 'Seppia', 'Sepia'],
  'Warm': ['Warm', 'Chaud', 'Cálido', 'Caldo', 'Cald'],
  'Vivid': ['Kräftig', 'Vif', 'Vivo', 'Vivido', 'Viu'],
  'Faded': ['Verblasst', 'Délavé', 'Desvaído', 'Sbiadito', 'Estompat'],
  'Comic': ['Comic', 'BD', 'Cómic', 'Fumetto', 'Bandă desenată'],
  'Sketch': ['Skizze', 'Croquis', 'Boceto', 'Schizzo', 'Schiță'],
  'Glam': ['Glam', 'Glam', 'Glam', 'Glam', 'Glam'],
  'Off': ['Aus', 'Sans', 'Sin', 'Senza', 'Fără'],
  'Light': ['Leicht', 'Léger', 'Suave', 'Leggero', 'Ușor'],
  'Strong': ['Stark', 'Fort', 'Fuerte', 'Forte', 'Puternic'],
  'Auto-enhance: on': ['Automatisch verbessern: an', 'Amélioration auto : oui', 'Mejora automática: sí', 'Miglioramento automatico: sì', 'Îmbunătățire automată: da'],
  'Auto-enhance: off': ['Automatisch verbessern: aus', 'Amélioration auto : non', 'Mejora automática: no', 'Miglioramento automatico: no', 'Îmbunătățire automată: nu'],
  'Face swap': ['Face Swap', 'Échange de visage', 'Cambio de cara', 'Scambio di volto', 'Schimb de fețe'],
  'Face swap for photo {n}': ['Face Swap für Foto {n}', 'Échange de visage pour la photo {n}', 'Cambio de cara para la foto {n}', 'Scambio di volto per la foto {n}', 'Schimb de fețe pentru fotografia {n}'],
  'Swap places': ['Plätze tauschen', 'Échanger les places', 'Intercambiar lugares', 'Scambia i posti', 'Schimbă locurile'],
  'Put your face into a scene. It takes a moment.': ['Setz dein Gesicht in eine Szene. Das dauert einen Moment.', 'Mettez votre visage dans une scène. Cela prend un instant.', 'Pon tu cara en una escena. Tarda un momento.', 'Metti il tuo volto in una scena. Ci vuole un attimo.', 'Pune-ți fața într-o scenă. Durează puțin.'],
  'Scene {n}': ['Szene {n}', 'Scène {n}', 'Escena {n}', 'Scena {n}', 'Scena {n}'],
  'Putting you in the picture…': ['Du kommst gleich ins Bild…', 'On vous met dans l’image…', 'Te estamos poniendo en la imagen…', 'Ti stiamo mettendo nella scena…', 'Te punem în imagine…'],
  "We couldn't see a face to swap. Try another photo, or a retake!": ['Wir haben kein Gesicht zum Tauschen gefunden. Versuch ein anderes Foto oder nimm es neu auf!', 'Aucun visage à échanger n’a été trouvé. Essayez une autre photo, ou reprenez-la !', 'No hemos visto ninguna cara para cambiar. ¡Prueba con otra foto o repítela!', 'Non abbiamo visto un volto da scambiare. Prova un’altra foto o rifalla!', 'Nu am găsit nicio față de schimbat. Încearcă altă fotografie sau refă-o!'],
  "Face swap didn't work this time. Try another scene.": ['Face Swap hat diesmal nicht geklappt. Versuch eine andere Szene.', 'L’échange de visage n’a pas fonctionné cette fois. Essayez une autre scène.', 'El cambio de cara no ha funcionado esta vez. Prueba otra escena.', 'Lo scambio di volto non ha funzionato questa volta. Prova un’altra scena.', 'Schimbul de fețe nu a mers de data asta. Încearcă altă scenă.'],
  'Background': ['Hintergrund', 'Arrière-plan', 'Fondo', 'Sfondo', 'Fundal'],
  'Background for photo {n}': ['Hintergrund für Foto {n}', 'Arrière-plan de la photo {n}', 'Fondo de la foto {n}', 'Sfondo della foto {n}', 'Fundal pentru fotografia {n}'],
  'Background for all photos': ['Hintergrund für alle Fotos', 'Arrière-plan de toutes les photos', 'Fondo de todas las fotos', 'Sfondo di tutte le foto', 'Fundal pentru toate fotografiile'],
  'Blur': ['Unscharf', 'Flou', 'Desenfoque', 'Sfocato', 'Neclar'],
  'Studio gray': ['Studio grau', 'Studio gris', 'Estudio gris', 'Studio grigio', 'Studio gri'],
  'Studio white': ['Studio weiß', 'Studio blanc', 'Estudio blanco', 'Studio bianco', 'Studio alb'],
  'Night': ['Nacht', 'Nuit', 'Noche', 'Notte', 'Noapte'],
  'Sunset': ['Sonnenuntergang', 'Coucher de soleil', 'Atardecer', 'Tramonto', 'Apus'],
  'Custom {n}': ['Eigener {n}', 'Perso {n}', 'Propio {n}', 'Personale {n}', 'Propriu {n}'],
  'Stickers': ['Sticker', 'Autocollants', 'Pegatinas', 'Adesivi', 'Stickere'],
  'Props fit every face:': ['Accessoires passen auf jedes Gesicht:', 'Des accessoires pour chaque visage :', 'Accesorios para cada cara:', 'Accessori per ogni volto:', 'Accesorii pentru fiecare față:'],
  'Tap a sticker to add it. Drag to move, pinch to resize and turn.': ['Tippe auf einen Sticker, um ihn hinzuzufügen. Ziehen verschiebt ihn, mit zwei Fingern änderst du Größe und Drehung.', 'Touchez un autocollant pour l’ajouter. Faites-le glisser pour le déplacer, pincez pour le redimensionner et le tourner.', 'Toca una pegatina para añadirla. Arrástrala para moverla, pellizca para cambiar su tamaño y girarla.', 'Tocca un adesivo per aggiungerlo. Trascinalo per spostarlo, pizzica per ridimensionarlo e ruotarlo.', 'Atinge un sticker ca să-l adaugi. Trage ca să-l muți, ciupește ca să-l redimensionezi și să-l rotești.'],
  'No faces found for props. Try a sticker instead!': ['Kein Gesicht für Accessoires gefunden. Versuch stattdessen einen Sticker!', 'Aucun visage trouvé pour les accessoires. Essayez plutôt un autocollant !', 'No se han encontrado caras para los accesorios. ¡Prueba con una pegatina!', 'Nessun volto trovato per gli accessori. Prova invece un adesivo!', 'Nu s-a găsit nicio față pentru accesorii. Încearcă un sticker!'],
  'Draw': ['Zeichnen', 'Dessiner', 'Dibujar', 'Disegna', 'Desenează'],
  'Draw or sign on your photos with a finger.': ['Zeichne oder unterschreibe mit dem Finger auf deinen Fotos.', 'Dessinez ou signez sur vos photos avec le doigt.', 'Dibuja o firma en tus fotos con el dedo.', 'Disegna o firma sulle tue foto con un dito.', 'Desenează sau semnează pe fotografii cu degetul.'],
  'Pen': ['Stift', 'Stylo', 'Lápiz', 'Penna', 'Creion'],
  'Thin': ['Dünn', 'Fin', 'Fino', 'Sottile', 'Subțire'],
  'Medium': ['Mittel', 'Moyen', 'Medio', 'Medio', 'Mediu'],
  'Thick': ['Dick', 'Épais', 'Grueso', 'Spesso', 'Gros'],
  'Undo': ['Rückgängig', 'Annuler', 'Deshacer', 'Annulla', 'Anulează'],
  'Clear': ['Löschen', 'Effacer', 'Borrar', 'Cancella', 'Șterge'],
  'Print': ['Drucken', 'Imprimer', 'Imprimir', 'Stampa', 'Tipărește'],
  'Share': ['Teilen', 'Partager', 'Compartir', 'Condividi', 'Distribuie'],
  'Done': ['Fertig', 'Terminé', 'Listo', 'Fatto', 'Gata'],
  // Guests' details
  'A few words about you': ['Ein paar Worte zu dir', 'Quelques mots sur vous', 'Unas palabras sobre ti', 'Due parole su di te', 'Câteva cuvinte despre tine'],
  'Your name': ['Dein Name', 'Votre nom', 'Tu nombre', 'Il tuo nome', 'Numele tău'],
  'Your email': ['Deine E-Mail-Adresse', 'Votre e-mail', 'Tu correo electrónico', 'La tua email', 'Adresa ta de email'],
  'Continue': ['Weiter', 'Continuer', 'Continuar', 'Continua', 'Continuă'],
  'I agree that the host of this event may contact me by email.': ['Ich bin einverstanden, dass mich der Gastgeber dieser Veranstaltung per E-Mail kontaktiert.', 'J’accepte que l’organisateur de cet événement me contacte par e-mail.', 'Acepto que el anfitrión de este evento me contacte por correo electrónico.', 'Accetto che l’organizzatore di questo evento mi contatti via email.', 'Sunt de acord ca gazda acestui eveniment să mă contacteze prin email.'],
  // Photos to phones: the sheet with the QR code, and the page on the guest's phone
  'Scan to get your photo': ['Scannen und Foto mitnehmen', 'Scannez pour obtenir votre photo', 'Escanea para llevarte tu foto', 'Scansiona per avere la tua foto', 'Scanează ca să-ți iei fotografia'],
  'QR code for your photo': ['QR-Code für dein Foto', 'Code QR de votre photo', 'Código QR de tu foto', 'Codice QR della tua foto', 'Cod QR pentru fotografia ta'],
  'Your phone needs to be on the same Wi-Fi as the booth.': ['Dein Handy muss im selben WLAN sein wie die Fotobox.', 'Votre téléphone doit être sur le même Wi-Fi que le photobooth.', 'Tu móvil debe estar en la misma Wi-Fi que el fotomatón.', 'Il telefono deve essere sulla stessa rete Wi-Fi del photobooth.', 'Telefonul tău trebuie să fie pe același Wi-Fi ca și cabina foto.'],
  'Close': ['Schließen', 'Fermer', 'Cerrar', 'Chiudi', 'Închide'],
  'Your photo': ['Dein Foto', 'Votre photo', 'Tu foto', 'La tua foto', 'Fotografia ta'],
  'Your photo is on its way.': ['Dein Foto ist unterwegs.', 'Votre photo arrive.', 'Tu foto está en camino.', 'La tua foto sta arrivando.', 'Fotografia ta e pe drum.'],
  'Tap Done on the booth, and it shows up here.': ['Tippe an der Fotobox auf „Fertig“, dann erscheint es hier.', 'Touchez « Terminé » sur le photobooth, et elle apparaîtra ici.', 'Toca «Listo» en el fotomatón y aparecerá aquí.', 'Tocca «Fatto» sul photobooth e apparirà qui.', 'Atinge „Gata” pe cabina foto și apare aici.'],
  'Save': ['Speichern', 'Enregistrer', 'Guardar', 'Salva', 'Salvează'],
  'Or press and hold the picture to save it.': ['Oder halte das Bild gedrückt, um es zu speichern.', 'Ou maintenez l’image appuyée pour l’enregistrer.', 'O mantén pulsada la imagen para guardarla.', 'Oppure tieni premuta l’immagine per salvarla.', 'Sau ține apăsat pe imagine ca să o salvezi.'],
}

// say('de', '↻ Retake photo {n}', { n: 2 }) → '↻ Foto 2 neu aufnehmen'
function say(lang, text, vars = {}) {
  const [, lead, rest] = /^([^\p{L}{]*)(.*)$/su.exec(String(text))
  return lead + (TEXTS[rest]?.[Object.keys(LANGS).indexOf(lang) - 1] ?? rest).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)
}

let trLang = 'en'
const tr = (text, vars) => say(trLang, text, vars)
// The page's fixed texts are marked data-tr (the element's text) or data-tr-label (its aria-label); the English text
// is kept in that attribute the first time, so the language can change back and forth.
function translatePage(lang) {
  trLang = lang in LANGS ? lang : 'en'
  document.documentElement.lang = trLang
  for (const el of document.querySelectorAll('[data-tr]')) el.textContent = tr(el.dataset.tr ||= el.textContent)
  for (const el of document.querySelectorAll('[data-tr-label]')) el.ariaLabel = tr(el.dataset.trLabel ||= el.ariaLabel)
}
if (typeof module !== 'undefined') module.exports = { LANGS, TEXTS, say }
